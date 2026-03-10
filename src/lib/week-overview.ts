/**
 * Week Overview — AI-generated weekly learning summary
 *
 * Generated once per week on first dashboard visit, cached in LearningEvent.
 * Focuses on LEARNING CONTENT — topics, readings, key deadlines — not class times.
 * Uses gpt-4o-mini for cost efficiency.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import crypto from "crypto";
import { db } from "@/lib/db";
import { getISOWeek, getISOWeekYear, startOfWeek, addDays, format, parseISO, isValid, getDay } from "date-fns";
import type { CourseContextSnapshot } from "@/lib/course-context";
import type { LearningSignals } from "@/lib/learning-signals";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WeekOverviewData {
  weekKey: string;
  summary: string;
  courseNotes: { courseName: string; note: string }[];
  generatedAt: string;
  sourceFingerprint?: string;
}

export interface WeekCourseData {
  courseId: string;
  courseName: string;
  courseColor: string;
  weekLabel: string | null;
  topics: string[];
  readings: string[];
  notes: string | null;
  dateConfidence: string | null;
  contentConfidence: string | null;
  scheduleMode: string | null;
  deadlines: { title: string; type: string; dueDay: string; pointsPossible: number | null; status: string }[];
  aiNote: string | null;
}

export interface WeekDeadlineDay {
  dayName: string;
  date: string;
  isToday: boolean;
  isPast: boolean;
  deadlines: { title: string; type: string; courseName: string; courseColor: string; status: string }[];
}

type CourseContextBundle = {
  course: {
    id: string;
    name: string;
    color: string;
    term?: string | null;
    currentGrade: string | null;
    currentScore: number | null;
  };
  context: CourseContextSnapshot;
};

const WEEK_OVERVIEW_FINGERPRINT_VERSION = "2026-03-09-provenance-v3";

// ── Week key ─────────────────────────────────────────────────────────────────

export function getCurrentWeekKey(now: Date = new Date()): string {
  return `${getISOWeekYear(now)}-W${String(getISOWeek(now)).padStart(2, "0")}`;
}

// ── Build structured week data (no AI needed) ────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const FULL_BREAK_RX = /\bspring break\b|\bacademic break\b|\bread(?:ing)? days?\b|\bbye week\b|\bholiday\b|\bno classes\b/i;
const PARTIAL_NO_CLASS_RX = /\bno class(?:es)?\s+(?:on|for)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}\/\d{1,2})/i;

function hasBreakSignal(week: CourseContextSnapshot["currentWeek"]): boolean {
  if (!week) return false;
  if (FULL_BREAK_RX.test(week.weekLabel)) return true;
  if (week.notes && FULL_BREAK_RX.test(week.notes)) return true;
  if (week.notes && /\bno class\b/i.test(week.notes)) {
    if (PARTIAL_NO_CLASS_RX.test(week.notes) && (week.topics.length > 0 || week.readings.length > 0)) {
      return false;
    }
    return week.topics.length === 0 && week.readings.length === 0;
  }
  return false;
}

function isExplicitBreakWeek(week: CourseContextSnapshot["currentWeek"]): boolean {
  if (!week) return false;
  if (!hasBreakSignal(week)) return false;
  return week.topics.length === 0 && week.readings.length === 0;
}

function hasDeadlineThisWeek(
  context: CourseContextSnapshot,
  weekStart: Date,
  weekEnd: Date,
): boolean {
  return [...context.urgentAssignments, ...context.upcomingAssignments].some((assignment) => {
    const due = parseISO(assignment.dueDate);
    return isValid(due) && due >= weekStart && due <= weekEnd;
  });
}

export function applyDetectedTermBreaks(
  courseContexts: CourseContextBundle[],
  now: Date = new Date(),
): CourseContextBundle[] {
  if (courseContexts.length === 0) return courseContexts;

  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = addDays(weekStart, 6);
  const weekStartStr = format(weekStart, "yyyy-MM-dd");

  const breakStartByTerm = new Map<string, string>();
  for (const { course, context } of courseContexts) {
    if (!isExplicitBreakWeek(context.currentWeek)) continue;
    if (context.currentWeek?.startDate !== weekStartStr) continue;
    breakStartByTerm.set(course.term ?? "__all__", weekStartStr);
  }

  if (breakStartByTerm.size === 0) return courseContexts;

  return courseContexts.map((bundle) => {
    const breakStart = breakStartByTerm.get(bundle.course.term ?? "__all__");
    if (!breakStart) return bundle;

    const { context } = bundle;
    const currentWeek = context.currentWeek;
    const nextWeek = context.nextWeek;

    if (!currentWeek || isExplicitBreakWeek(currentWeek)) {
      return bundle;
    }

    const weekHasDeadline = hasDeadlineThisWeek(context, weekStart, weekEnd);
    const currentStart = currentWeek.startDate;
    const nextStart = nextWeek?.startDate ?? null;
    const spansBreakGap =
      Boolean(currentStart && currentStart < breakStart) &&
      Boolean(nextStart && nextStart > breakStart);
    const startsOnBreak = currentStart === breakStart;
    const breakMentioned = hasBreakSignal(currentWeek);
    const lowConfidenceInferredWeek =
      (currentWeek.dateConfidence === "low" || currentWeek.scheduleMode === "inferred") &&
      !currentWeek.startDate;

    if (!startsOnBreak && !spansBreakGap && !lowConfidenceInferredWeek) {
      return bundle;
    }

    if (!breakMentioned && weekHasDeadline) {
      return bundle;
    }

    const syntheticBreakWeek = {
      weekNumber: currentWeek.weekNumber,
      weekLabel: "Spring Break — No Class",
      topics: [] as string[],
      readings: [] as string[],
      notes: "No class — Spring Break",
      dateConfidence: currentWeek.dateConfidence ?? "medium",
      contentConfidence: currentWeek.contentConfidence ?? "low",
      scheduleMode: currentWeek.scheduleMode ?? "weekly",
      provenance: currentWeek.provenance ?? null,
      completedTopics: [] as string[],
      startDate: breakStart,
    };

    return {
      ...bundle,
      context: {
        ...context,
        currentWeek: syntheticBreakWeek,
        nextWeek: startsOnBreak ? currentWeek : nextWeek,
      },
    };
  });
}

export function buildWeekCourses(
  courseContexts: CourseContextBundle[],
  now: Date = new Date(),
): WeekCourseData[] {
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = addDays(weekStart, 6); // Sunday end

  return courseContexts
    .map(({ course, context }) => {
      const currentWeek = context.currentWeek;

      // Collect deadlines due this week for this course
      const allDeadlines = [...context.urgentAssignments, ...context.upcomingAssignments];
      const deadlines = allDeadlines
        .filter((a) => {
          const due = parseISO(a.dueDate);
          if (!isValid(due)) return false;
          return due >= weekStart && due <= weekEnd;
        })
        .map((a) => {
          const due = parseISO(a.dueDate);
          return {
            title: a.title,
            type: a.type,
            dueDay: isValid(due) ? DAY_NAMES[getDay(due)] : "?",
            pointsPossible: a.pointsPossible,
            status: a.status,
          };
        });

      return {
        courseId: course.id,
        courseName: course.name,
        courseColor: course.color,
        weekLabel: currentWeek?.weekLabel ?? null,
        topics: currentWeek?.topics ?? [],
        readings: currentWeek?.readings ?? [],
        notes: currentWeek?.notes ?? null,
        dateConfidence: currentWeek?.dateConfidence ?? null,
        contentConfidence: currentWeek?.contentConfidence ?? null,
        scheduleMode: currentWeek?.scheduleMode ?? null,
        deadlines,
        aiNote: null,
      };
    })
    .filter((c) => Boolean(c.weekLabel) || c.topics.length > 0 || c.readings.length > 0 || Boolean(c.notes) || c.deadlines.length > 0);
}

export function buildDeadlineDays(
  courseContexts: CourseContextBundle[],
  now: Date = new Date(),
): WeekDeadlineDay[] {
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const todayStr = format(now, "yyyy-MM-dd");

  const days: WeekDeadlineDay[] = [];

  for (let i = 0; i < 5; i++) {
    const date = addDays(weekStart, i);
    const dateStr = format(date, "yyyy-MM-dd");

    const deadlines: WeekDeadlineDay["deadlines"] = [];
    for (const { course, context } of courseContexts) {
      for (const a of [...context.urgentAssignments, ...context.upcomingAssignments]) {
        if (!a.dueDate) continue;
        const dueDate = parseISO(a.dueDate);
        if (!isValid(dueDate)) continue;
        if (format(dueDate, "yyyy-MM-dd") === dateStr) {
          deadlines.push({
            title: a.title,
            type: a.type,
            courseName: course.name,
            courseColor: course.color,
            status: a.status,
          });
        }
      }
    }

    days.push({
      dayName: DAY_NAMES[date.getDay()],
      date: format(date, "MMM d"),
      isToday: dateStr === todayStr,
      isPast: dateStr < todayStr,
      deadlines,
    });
  }

  return days;
}

// ── Zod schema for AI output ─────────────────────────────────────────────────

const weekOverviewSchema = z.object({
  summary: z.string().describe("2-3 sentence overview of the week's learning: what are the big topics, what's due, what to prioritize"),
  courseNotes: z.array(z.object({
    courseName: z.string(),
    note: z.string().describe("One sentence about what this course covers this week and what to focus on"),
  })),
});

// ── AI generation ────────────────────────────────────────────────────────────

async function generateOverview(
  courseContexts: CourseContextBundle[],
  signals: LearningSignals | null,
  now: Date,
): Promise<{ summary: string; courseNotes: { courseName: string; note: string }[] }> {
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = addDays(weekStart, 6);

  const courseLines = courseContexts.map(({ course, context }) => {
    const parts = [`${course.name}:`];
    if (context.currentWeek) {
      parts.push(`Week: "${context.currentWeek.weekLabel}"`);
      if (context.currentWeek.topics.length > 0) {
        parts.push(`Topics: ${context.currentWeek.topics.join(", ")}`);
      }
      if (context.currentWeek.readings.length > 0) {
        parts.push(`Readings: ${context.currentWeek.readings.join(", ")}`);
      }
      if (context.currentWeek.notes) {
        parts.push(`Notes: ${context.currentWeek.notes}`);
      }
      if (context.currentWeek.scheduleMode || context.currentWeek.dateConfidence || context.currentWeek.contentConfidence) {
        parts.push(
          `Timeline metadata: mode=${context.currentWeek.scheduleMode ?? "unknown"}, dateConfidence=${context.currentWeek.dateConfidence ?? "unknown"}, contentConfidence=${context.currentWeek.contentConfidence ?? "unknown"}`,
        );
      }
    }
    parts.push(`Grade: ${context.gradeInfo}`);

    const deadlines = [...context.urgentAssignments, ...context.upcomingAssignments].filter((assignment) => {
      const due = parseISO(assignment.dueDate);
      return isValid(due) && due >= weekStart && due <= weekEnd;
    });
    if (deadlines.length > 0) {
      const dlStr = deadlines.slice(0, 5).map((a) => {
        const due = parseISO(a.dueDate);
        const dayStr = isValid(due) ? format(due, "EEE") : "?";
        const pts = a.pointsPossible ? ` (${a.pointsPossible}pts)` : "";
        return `${a.title} (${a.type}) due ${dayStr}${pts}`;
      }).join("; ");
      parts.push(`Due: ${dlStr}`);
    }

    return parts.join(" | ");
  });

  let studentCtx = "";
  if (signals) {
    const parts: string[] = [];
    if (signals.confidenceTrend.direction !== "insufficient") {
      parts.push(`Confidence: ${signals.confidenceTrend.direction}`);
    }
    if (signals.studyStreak > 0) {
      parts.push(`Study streak: ${signals.studyStreak} days`);
    }
    if (signals.topBlockers.length > 0) {
      parts.push(`Top blocker: ${signals.topBlockers[0].blocker}`);
    }
    if (parts.length > 0) {
      studentCtx = `\nStudent: ${parts.join(", ")}`;
    }
  }

  const dayOfWeek = format(now, "EEEE");

  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: weekOverviewSchema,
    system: `You write brief weekly learning overviews for a college student. Focus on CONTENT — what topics they're learning, what readings matter, what assignments to prioritize. Do NOT mention class times or schedules. Be specific — reference actual topic names, assignment names, and readings. Keep the summary to 2-3 sentences. Keep each course note to one concise sentence about what to focus on. Be encouraging but honest about heavy workloads.`,
    prompt: `Today is ${dayOfWeek}, ${format(now, "MMMM d")}.

Courses this week:
${courseLines.join("\n")}
${studentCtx}

Write a learning-focused week overview with a summary and a note for each course.`,
  });

  return object;
}

function buildWeekOverviewFingerprint(
  courseContexts: CourseContextBundle[],
  signals: LearningSignals | null,
): string {
  const payload = {
    version: WEEK_OVERVIEW_FINGERPRINT_VERSION,
    courses: courseContexts.map(({ course, context }) => ({
      id: course.id,
      name: course.name,
      weekLabel: context.currentWeek?.weekLabel ?? null,
      weekNumber: context.currentWeek?.weekNumber ?? null,
      topics: context.currentWeek?.topics ?? [],
      readings: context.currentWeek?.readings ?? [],
      notes: context.currentWeek?.notes ?? null,
      dateConfidence: context.currentWeek?.dateConfidence ?? null,
      contentConfidence: context.currentWeek?.contentConfidence ?? null,
      scheduleMode: context.currentWeek?.scheduleMode ?? null,
      urgentAssignments: context.urgentAssignments.map((a) => ({
        title: a.title,
        dueDate: a.dueDate,
        status: a.status,
      })),
      upcomingAssignments: context.upcomingAssignments.map((a) => ({
        title: a.title,
        dueDate: a.dueDate,
        status: a.status,
      })),
    })),
    signals: signals
      ? {
          confidenceTrend: signals.confidenceTrend.direction,
          studyStreak: signals.studyStreak,
          blockers: signals.topBlockers.map((b) => b.blocker),
        }
      : null,
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

// ── Cache logic ──────────────────────────────────────────────────────────────

export async function getOrCreateWeekOverview(
  userId: string,
  courseContexts: CourseContextBundle[],
  signals: LearningSignals | null,
  now: Date = new Date(),
): Promise<WeekOverviewData | null> {
  if (courseContexts.length === 0) return null;

  const weekKey = getCurrentWeekKey(now);
  const sourceFingerprint = buildWeekOverviewFingerprint(courseContexts, signals);

  // Check cache
  const cached = await db.learningEvent.findFirst({
    where: {
      userId,
      type: "week_overview",
    },
    orderBy: { createdAt: "desc" },
  });

  if (cached) {
    const meta = cached.metadata as Record<string, unknown>;
    if (
      meta.weekKey === weekKey &&
      meta.sourceFingerprint === sourceFingerprint &&
      Array.isArray(meta.courseNotes)
    ) {
      return meta as unknown as WeekOverviewData;
    }
  }

  // Generate new overview
  try {
    const result = await generateOverview(courseContexts, signals, now);

    const data: WeekOverviewData = {
      weekKey,
      summary: result.summary,
      courseNotes: result.courseNotes,
      generatedAt: now.toISOString(),
      sourceFingerprint,
    };

    await db.learningEvent.create({
      data: {
        userId,
        type: "week_overview",
        metadata: JSON.parse(JSON.stringify(data)),
      },
    });

    return data;
  } catch (err) {
    console.error("Week overview generation failed:", err);
    return null;
  }
}
