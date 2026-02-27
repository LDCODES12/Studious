/**
 * Study Plan Pipeline Engine
 *
 * Multi-stage architecture:
 *   Stage 1: GATHER   (algorithm)  — collect assignments, classes, calendar → WorkItems + BusyBlocks
 *   Stage 2: SCORE    (algorithm)  — priority scoring via rubric → ScoredItems
 *   Stage 3: SCHEDULE (algorithm)  — constraint solver fills available slots → ScheduleBlocks
 *   Stage 4: ENRICH   (AI)         — study approach tips per session → StudySessions
 *
 * The AI never decides WHEN to study — only HOW to study.
 */

import { db } from "@/lib/db";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import {
  addDays,
  addMinutes,
  format,
  isBefore,
  isAfter,
  startOfDay,
  differenceInMinutes,
  differenceInHours,
  parseISO,
  setHours,
  setMinutes,
  max as dateMax,
} from "date-fns";
import type { ExtractedClassSchedule, ClassMeeting } from "@/lib/parse-syllabus";
import type { LearningSignals } from "@/lib/learning-signals";
import { computeLearningSignals } from "@/lib/learning-signals";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkItem {
  id: string;
  courseId: string;
  courseName: string;
  courseColor: string;
  title: string;
  type: "assignment" | "exam_prep" | "topic_review" | "topic_preview";
  dueDate: string | null;
  hoursUntilDue: number | null;
  pointsPossible: number | null;
  status: "due_today" | "due_soon" | "upcoming";
  estimatedMinutes: number;
  relatedTopics: string[];
  assignmentId: string | null;
}

export interface BusyBlock {
  start: Date;
  end: Date;
  label: string;
  type: "class" | "calendar" | "buffer";
}

export interface AvailableSlot {
  start: Date;
  end: Date;
  durationMinutes: number;
}

export interface ScoredItem extends WorkItem {
  scores: {
    urgency: number;
    importance: number;
    difficulty: number;
  };
  priorityScore: number;
}

export interface ScheduleBlock {
  start: string; // ISO
  end: string;   // ISO
  type: "study" | "break" | "class" | "calendar";
  item?: ScoredItem;
  label: string;
  courseName?: string;
  courseColor?: string;
}

export interface StudySession extends ScheduleBlock {
  approach?: string;
  rationale?: string;
}

export interface StudyPlanResult {
  date: string;
  generatedAt: string;
  mode: "day" | "week";
  schedule: StudySession[];
  summary: {
    studyHours: number;
    sessionCount: number;
    topPriority: string | null;
    canSlip: string | null;
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

const DAY_CODE_TO_JS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 23;
const BUFFER_MINUTES = 15;
const MAX_STUDY_MINUTES_PER_DAY = 480; // 8 hours
const BREAK_AFTER_MINUTES = 90;
const BREAK_DURATION = 15;

// ── Duration estimation heuristics ───────────────────────────────────────────

function estimateDuration(type: string, assignmentType: string): number {
  const t = assignmentType.toLowerCase();
  if (/exam|midterm|final/i.test(t)) return 120;
  if (/essay|paper|report/i.test(t)) return 90;
  if (/homework|problem.?set|assignment/i.test(t)) return 60;
  if (/quiz|survey/i.test(t)) return 30;
  if (/discussion|forum|post/i.test(t)) return 30;
  if (/lab/i.test(t)) return 60;

  if (type === "topic_review") return 30;
  if (type === "topic_preview") return 20;
  if (type === "exam_prep") return 120;
  return 45;
}

// ── Stage 1: GATHER ──────────────────────────────────────────────────────────

interface GatherResult {
  workItems: WorkItem[];
  busyBlocks: BusyBlock[];
  availableSlots: AvailableSlot[];
}

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
}

export async function gatherWorkItems(
  userId: string,
  mode: "day" | "week",
  now: Date,
  calendarEvents: CalendarEvent[] = [],
  tzOffsetMinutes: number = 0
): Promise<GatherResult> {
  const days = mode === "day" ? 1 : 7;
  const planEnd = addDays(startOfDay(now), days);

  // Query courses with assignments and topics
  const courses = await db.course.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      shortName: true,
      color: true,
      classSchedule: true,
      topics: {
        orderBy: { weekNumber: "asc" as const },
        select: {
          weekNumber: true,
          weekLabel: true,
          startDate: true,
          topics: true,
          completedTopics: true,
        },
      },
      assignments: {
        where: { omitFromFinalGrade: false },
        orderBy: { dueDate: "asc" as const },
        select: {
          id: true,
          title: true,
          type: true,
          dueDate: true,
          status: true,
          pointsPossible: true,
        },
      },
    },
  });

  const todayStr = format(now, "yyyy-MM-dd");
  const workItems: WorkItem[] = [];

  for (const course of courses) {
    const cName = course.shortName ?? course.name;

    // Build work items from assignments
    for (const a of course.assignments) {
      // Skip completed/graded
      if (a.status === "submitted" || a.status === "graded") continue;

      let status: WorkItem["status"];
      let hoursUntilDue: number | null = null;

      if (!a.dueDate) {
        status = "upcoming";
      } else {
        const due = parseISO(a.dueDate);
        if (!Number.isFinite(due.getTime())) {
          status = "upcoming";
        } else {
          hoursUntilDue = differenceInHours(due, now);
          const dueDateStr = format(due, "yyyy-MM-dd");

          if (hoursUntilDue < 0 || a.status === "missing") {
            continue; // Skip overdue — can't be submitted
          } else if (dueDateStr === todayStr) {
            status = "due_today";
          } else if (hoursUntilDue <= days * 24) {
            status = "due_soon";
          } else if (hoursUntilDue <= 14 * 24) {
            status = "upcoming";
          } else {
            continue; // Too far out
          }
        }
      }

      // For exams, create exam_prep items instead
      const isExam = /exam|midterm|final|test/i.test(a.type) || /exam|midterm|final|test/i.test(a.title);
      const itemType = isExam ? "exam_prep" as const : "assignment" as const;

      // Find related topics for this course
      const currentTopics = findCurrentTopics(course.topics, now);

      workItems.push({
        id: a.id,
        courseId: course.id,
        courseName: cName,
        courseColor: course.color,
        title: isExam ? `Study for ${a.title}` : a.title,
        type: itemType,
        dueDate: a.dueDate,
        hoursUntilDue,
        pointsPossible: a.pointsPossible,
        status,
        estimatedMinutes: estimateDuration(itemType, a.type),
        relatedTopics: currentTopics,
        assignmentId: a.id,
      });
    }

    // Build topic review/preview items
    const currentTopics = findCurrentTopics(course.topics, now);
    const nextTopics = findNextTopics(course.topics, now);

    if (currentTopics.length > 0) {
      // Check if any current topics are not yet completed
      const currentWeek = findCurrentWeekData(course.topics, now);
      const unreviewed = currentTopics.filter(
        (t) => !(currentWeek?.completedTopics ?? []).includes(t)
      );
      if (unreviewed.length > 0) {
        workItems.push({
          id: `review-${course.id}`,
          courseId: course.id,
          courseName: cName,
          courseColor: course.color,
          title: `Review: ${unreviewed.slice(0, 2).join(", ")}`,
          type: "topic_review",
          dueDate: null,
          hoursUntilDue: null,
          pointsPossible: null,
          status: "upcoming",
          estimatedMinutes: 30,
          relatedTopics: unreviewed,
          assignmentId: null,
        });
      }
    }

    if (nextTopics.length > 0 && mode === "day") {
      workItems.push({
        id: `preview-${course.id}`,
        courseId: course.id,
        courseName: cName,
        courseColor: course.color,
        title: `Preview: ${nextTopics.slice(0, 2).join(", ")}`,
        type: "topic_preview",
        dueDate: null,
        hoursUntilDue: null,
        pointsPossible: null,
        status: "upcoming",
        estimatedMinutes: 20,
        relatedTopics: nextTopics,
        assignmentId: null,
      });
    }
  }

  // Build busy blocks from class schedules + calendar
  const busyBlocks: BusyBlock[] = [];

  for (const course of courses) {
    const sched = course.classSchedule as ExtractedClassSchedule | null;
    if (!sched?.meetings) continue;

    for (const meeting of sched.meetings as ClassMeeting[]) {
      if (!meeting.days?.length || !meeting.startTime || !meeting.endTime) continue;

      const jsDays = meeting.days.map((d) => DAY_CODE_TO_JS[d]).filter((n) => n != null);

      for (let offset = 0; offset < days; offset++) {
        const day = startOfLocalDay(addDays(now, offset), tzOffsetMinutes);
        // getDay() on a UTC date may not match local day — adjust
        const localDayOfWeek = new Date(day.getTime() - tzOffsetMinutes * 60 * 1000).getUTCDay();
        if (!jsDays.includes(localDayOfWeek)) continue;

        const [sh, sm] = meeting.startTime.split(":").map(Number);
        const [eh, em] = meeting.endTime.split(":").map(Number);
        const start = localTimeToUTC(day, sh, sm, tzOffsetMinutes);
        const end = localTimeToUTC(day, eh, em, tzOffsetMinutes);

        if (isAfter(end, now)) {
          const label = meeting.label
            ? `${course.shortName ?? course.name} (${meeting.label})`
            : (course.shortName ?? course.name);

          busyBlocks.push({ start, end, label, type: "class" });

          // Add buffers
          busyBlocks.push({
            start: addMinutes(start, -BUFFER_MINUTES),
            end: start,
            label: `Buffer before ${label}`,
            type: "buffer",
          });
          busyBlocks.push({
            start: end,
            end: addMinutes(end, BUFFER_MINUTES),
            label: `Buffer after ${label}`,
            type: "buffer",
          });
        }
      }
    }
  }

  // Add calendar events
  for (const evt of calendarEvents) {
    const start = new Date(evt.start);
    const end = new Date(evt.end);
    if (isAfter(end, now)) {
      busyBlocks.push({ start, end, label: evt.summary, type: "calendar" });
    }
  }

  // Sort busy blocks by start time
  busyBlocks.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Compute available slots
  const availableSlots = computeAvailableSlots(now, mode, busyBlocks, tzOffsetMinutes);

  return { workItems, busyBlocks, availableSlots };
}

// ── Slot Computation ─────────────────────────────────────────────────────────

function computeAvailableSlots(
  now: Date,
  mode: "day" | "week",
  busyBlocks: BusyBlock[],
  tzOffsetMinutes: number = 0
): AvailableSlot[] {
  const days = mode === "day" ? 1 : 7;
  const slots: AvailableSlot[] = [];

  for (let offset = 0; offset < days; offset++) {
    const day = startOfLocalDay(addDays(now, offset), tzOffsetMinutes);

    // Day boundaries in local time
    let dayStart = localTimeToUTC(day, DAY_START_HOUR, 0, tzOffsetMinutes);
    const dayEnd = localTimeToUTC(day, DAY_END_HOUR, 0, tzOffsetMinutes);

    // If today, start from now (rounded up to next 15-min)
    if (offset === 0) {
      const roundedNow = roundUpTo15Min(now);
      dayStart = dateMax([dayStart, roundedNow]);
    }

    if (!isBefore(dayStart, dayEnd)) continue;

    // Merge overlapping busy blocks for this day
    const dayBusy = busyBlocks
      .filter((b) => isBefore(b.start, dayEnd) && isAfter(b.end, dayStart))
      .map((b) => ({
        start: dateMax([b.start, dayStart]),
        end: new Date(Math.min(b.end.getTime(), dayEnd.getTime())),
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    // Merge overlapping
    const merged: { start: Date; end: Date }[] = [];
    for (const block of dayBusy) {
      const last = merged[merged.length - 1];
      if (last && !isAfter(block.start, last.end)) {
        last.end = new Date(Math.max(last.end.getTime(), block.end.getTime()));
      } else {
        merged.push({ ...block });
      }
    }

    // Find gaps between busy blocks
    let cursor = dayStart;
    for (const block of merged) {
      if (isBefore(cursor, block.start)) {
        const dur = differenceInMinutes(block.start, cursor);
        if (dur >= 20) {
          slots.push({ start: new Date(cursor), end: new Date(block.start), durationMinutes: dur });
        }
      }
      cursor = dateMax([cursor, block.end]);
    }

    // Gap after last block
    if (isBefore(cursor, dayEnd)) {
      const dur = differenceInMinutes(dayEnd, cursor);
      if (dur >= 20) {
        slots.push({ start: new Date(cursor), end: new Date(dayEnd), durationMinutes: dur });
      }
    }
  }

  return slots;
}

/**
 * Create a Date representing a local time on a given day.
 * tzOffsetMinutes = getTimezoneOffset() value (e.g., 300 for EST = UTC-5)
 * "09:00" local with offset 300 → 14:00 UTC
 */
function localTimeToUTC(day: Date, hours: number, minutes: number, tzOffsetMinutes: number): Date {
  const utcDay = new Date(day);
  utcDay.setUTCHours(hours + Math.floor(tzOffsetMinutes / 60), minutes + (tzOffsetMinutes % 60), 0, 0);
  return utcDay;
}

/**
 * Get the start of day in local timezone terms.
 * "Start of day" is midnight local = midnight + tzOffset in UTC.
 */
function startOfLocalDay(d: Date, tzOffsetMinutes: number): Date {
  const utc = new Date(d.getTime() - tzOffsetMinutes * 60 * 1000);
  const dayStart = startOfDay(utc);
  return new Date(dayStart.getTime() + tzOffsetMinutes * 60 * 1000);
}

function roundUpTo15Min(d: Date): Date {
  const minutes = d.getMinutes();
  const remainder = minutes % 15;
  if (remainder === 0 && d.getSeconds() === 0) return d;
  return addMinutes(setMinutes(new Date(d), minutes - remainder), 15);
}

// ── Topic helpers ────────────────────────────────────────────────────────────

interface TopicData {
  weekNumber: number;
  weekLabel: string;
  startDate: string | null;
  topics: string[];
  completedTopics: string[];
}

function findCurrentWeekData(topics: TopicData[], now: Date): TopicData | null {
  const todayStr = format(now, "yyyy-MM-dd");
  // Find by startDate
  const withDates = topics.filter((t) => t.startDate);
  if (withDates.length > 0) {
    for (let i = withDates.length - 1; i >= 0; i--) {
      if (withDates[i].startDate! <= todayStr) return withDates[i];
    }
  }
  // Fallback: use semester fraction
  if (topics.length > 0) {
    const fraction = 0.5; // approximate
    const idx = Math.min(Math.floor(fraction * topics.length), topics.length - 1);
    return topics[idx];
  }
  return null;
}

function findCurrentTopics(topics: TopicData[], now: Date): string[] {
  const week = findCurrentWeekData(topics, now);
  return week?.topics ?? [];
}

function findNextTopics(topics: TopicData[], now: Date): string[] {
  const current = findCurrentWeekData(topics, now);
  if (!current) return [];
  const idx = topics.findIndex((t) => t.weekNumber === current.weekNumber);
  if (idx >= 0 && idx + 1 < topics.length) {
    return topics[idx + 1].topics ?? [];
  }
  return [];
}

// ── Stage 2: SCORE ───────────────────────────────────────────────────────────

export function scoreAndPrioritize(
  items: WorkItem[],
  signals?: LearningSignals | null
): ScoredItem[] {
  const courseConfidence = new Map(
    (signals?.perCourseConfidence ?? []).map((c) => [c.courseId, c.avg])
  );

  return items
    .map((item) => {
      // Urgency (1-5)
      let urgency = 1;
      if (item.hoursUntilDue !== null) {
        if (item.hoursUntilDue <= 6) urgency = 5;
        else if (item.hoursUntilDue <= 24) urgency = 4;
        else if (item.hoursUntilDue <= 48) urgency = 3;
        else if (item.hoursUntilDue <= 168) urgency = 2;
      }

      // Importance (1-5)
      let importance = 2;
      if (item.type === "exam_prep") importance = 5;
      else if (item.pointsPossible !== null) {
        if (item.pointsPossible >= 30) importance = 5;
        else if (item.pointsPossible >= 20) importance = 4;
        else if (item.pointsPossible >= 10) importance = 3;
        else if (item.pointsPossible >= 5) importance = 2;
        else importance = 1;
      }
      // Topic items are low importance
      if (item.type === "topic_review") importance = Math.min(importance, 2);
      if (item.type === "topic_preview") importance = Math.min(importance, 1);

      // Difficulty (1-5) from per-course confidence
      let difficulty = 3; // neutral default
      const conf = courseConfidence.get(item.courseId);
      if (conf !== undefined) {
        if (conf < 1) difficulty = 5;
        else if (conf < 1.5) difficulty = 4;
        else if (conf < 2) difficulty = 3;
        else if (conf < 2.5) difficulty = 2;
        else difficulty = 1;
      }

      const priorityScore = (urgency * 3 + importance * 2.5 + difficulty * 1.5) / 7;

      return {
        ...item,
        scores: { urgency, importance, difficulty },
        priorityScore,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

// ── Stage 3: SCHEDULE ────────────────────────────────────────────────────────

export function buildSchedule(
  scoredItems: ScoredItem[],
  availableSlots: AvailableSlot[],
  busyBlocks: BusyBlock[],
  mode: "day" | "week"
): ScheduleBlock[] {
  const schedule: ScheduleBlock[] = [];
  const assigned = new Set<string>();
  let totalStudyMinutes = 0;
  const maxPerDay = MAX_STUDY_MINUTES_PER_DAY;
  let minutesSinceBreak = 0;

  // Add class and calendar blocks to the schedule
  for (const block of busyBlocks) {
    if (block.type === "buffer") continue; // Don't show buffers
    schedule.push({
      start: block.start.toISOString(),
      end: block.end.toISOString(),
      type: block.type,
      label: block.label,
    });
  }

  // Fill available slots with scored items
  for (const slot of availableSlots) {
    if (totalStudyMinutes >= maxPerDay * (mode === "week" ? 7 : 1)) break;

    let cursor = new Date(slot.start);
    const slotEnd = new Date(slot.end);

    while (isBefore(cursor, slotEnd)) {
      // Check if we need a break
      if (minutesSinceBreak >= BREAK_AFTER_MINUTES) {
        const breakEnd = addMinutes(cursor, BREAK_DURATION);
        if (isAfter(breakEnd, slotEnd)) break;

        schedule.push({
          start: cursor.toISOString(),
          end: breakEnd.toISOString(),
          type: "break",
          label: "Break",
        });
        cursor = breakEnd;
        minutesSinceBreak = 0;
        continue;
      }

      // Find next unassigned item
      const nextItem = scoredItems.find((item) => !assigned.has(item.id));
      if (!nextItem) break;

      const remainingSlot = differenceInMinutes(slotEnd, cursor);
      if (remainingSlot < 20) break; // Too short

      const sessionDuration = Math.min(nextItem.estimatedMinutes, remainingSlot);

      schedule.push({
        start: cursor.toISOString(),
        end: addMinutes(cursor, sessionDuration).toISOString(),
        type: "study",
        item: nextItem,
        label: nextItem.title,
        courseName: nextItem.courseName,
        courseColor: nextItem.courseColor,
      });

      assigned.add(nextItem.id);
      cursor = addMinutes(cursor, sessionDuration);
      totalStudyMinutes += sessionDuration;
      minutesSinceBreak += sessionDuration;
    }
  }

  // Sort by start time
  schedule.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return schedule;
}

// ── Stage 4: ENRICH ──────────────────────────────────────────────────────────

const approachSchema = z.object({
  sessions: z.array(
    z.object({
      index: z.number(),
      approach: z.string(),
      rationale: z.string(),
    })
  ),
});

export async function enrichWithAI(
  schedule: ScheduleBlock[],
  signals?: LearningSignals | null
): Promise<StudySession[]> {
  const studySessions = schedule.filter((b) => b.type === "study" && b.item);

  if (studySessions.length === 0) {
    return schedule as StudySession[];
  }

  // Build context for the AI
  const sessionDescriptions = studySessions.map((s, i) => ({
    index: i,
    time: `${format(new Date(s.start), "h:mm a")} – ${format(new Date(s.end), "h:mm a")}`,
    course: s.courseName,
    task: s.label,
    type: s.item!.type,
    status: s.item!.status,
    hoursUntilDue: s.item!.hoursUntilDue,
    pointsPossible: s.item!.pointsPossible,
    relatedTopics: s.item!.relatedTopics,
    scores: s.item!.scores,
  }));

  let studentContext = "";
  if (signals) {
    const parts: string[] = [];
    if (signals.confidenceTrend.direction !== "insufficient") {
      parts.push(`Confidence trend: ${signals.confidenceTrend.direction} (avg ${signals.confidenceTrend.recentAvg.toFixed(1)}/3)`);
    }
    if (signals.topBlockers.length > 0) {
      parts.push(`Top blocker: ${signals.topBlockers[0].blocker}`);
    }
    if (signals.taskCompletion) {
      parts.push(`Task completion: ${signals.taskCompletion.done}/${signals.taskCompletion.total} (${Math.round(signals.taskCompletion.rate * 100)}%)`);
    }
    if (parts.length > 0) {
      studentContext = `\n\nStudent context:\n${parts.join("\n")}`;
    }
  }

  try {
    const { object } = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: approachSchema,
      system: `You generate brief study approach tips for scheduled study sessions.
For each session, write:
- "approach": One sentence on HOW to study (e.g., "Start with practice problems from Chapter 5, then review weak areas")
- "rationale": One sentence on WHY this matters now (e.g., "Worth 10 points and due in 4 hours — prioritize completion")

Be specific to the task and course. Reference related topics when available.
Keep each under 20 words. Be practical, not motivational.${studentContext}`,
      prompt: `Generate approach and rationale for these study sessions:\n${JSON.stringify(sessionDescriptions, null, 2)}`,
    });

    // Merge AI enrichments back into schedule
    const enrichments = new Map(
      object.sessions.map((s) => [s.index, { approach: s.approach, rationale: s.rationale }])
    );

    let studyIdx = 0;
    return schedule.map((block) => {
      if (block.type === "study" && block.item) {
        const enrichment = enrichments.get(studyIdx);
        studyIdx++;
        return {
          ...block,
          approach: enrichment?.approach,
          rationale: enrichment?.rationale,
        };
      }
      return block;
    });
  } catch {
    // AI enrichment is non-fatal — return schedule without tips
    return schedule as StudySession[];
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function runStudyPlanPipeline(
  userId: string,
  mode: "day" | "week",
  now: Date,
  calendarEvents: CalendarEvent[] = [],
  tzOffsetMinutes: number = 0
): Promise<StudyPlanResult> {
  // Stage 1: Gather
  const { workItems, busyBlocks, availableSlots } = await gatherWorkItems(
    userId, mode, now, calendarEvents, tzOffsetMinutes
  );

  // Load learning signals for scoring
  let signals: LearningSignals | null = null;
  try {
    signals = await computeLearningSignals(userId);
  } catch { /* non-fatal */ }

  // Stage 2: Score
  const scoredItems = scoreAndPrioritize(workItems, signals);

  // Stage 3: Schedule
  const schedule = buildSchedule(scoredItems, availableSlots, busyBlocks, mode);

  // Stage 4: Enrich
  const enrichedSchedule = await enrichWithAI(schedule, signals);

  // Build summary
  const studySessions = enrichedSchedule.filter((s) => s.type === "study");
  const totalMinutes = studySessions.reduce((sum, s) => {
    return sum + differenceInMinutes(new Date(s.end), new Date(s.start));
  }, 0);

  const topItem = scoredItems[0];
  const lowestItem = scoredItems.length > 1 ? scoredItems[scoredItems.length - 1] : null;

  return {
    date: format(now, "EEEE, MMMM d, yyyy"),
    generatedAt: now.toISOString(),
    mode,
    schedule: enrichedSchedule,
    summary: {
      studyHours: Math.round((totalMinutes / 60) * 10) / 10,
      sessionCount: studySessions.length,
      topPriority: topItem
        ? `${topItem.title}${topItem.hoursUntilDue !== null ? ` (${topItem.hoursUntilDue < 0 ? "overdue" : topItem.hoursUntilDue < 24 ? `${topItem.hoursUntilDue}h left` : `${Math.round(topItem.hoursUntilDue / 24)}d left`})` : ""}`
        : null,
      canSlip: lowestItem && lowestItem.type !== "assignment"
        ? `${lowestItem.title} can wait if time is short`
        : null,
    },
  };
}
