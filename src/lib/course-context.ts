/**
 * Course Context Snapshot Engine
 *
 * Pure deterministic functions that compute "where am I in this class right now?"
 * + a DB loader that feeds them + a prompt formatter for the AI system prompts.
 *
 * No side effects. No AI calls. Just structured context.
 */

import {
  parseISO,
  isValid,
  differenceInCalendarDays,
  addDays,
  subDays,
  isBefore,
  isAfter,
  format,
  getDay,
  setHours,
  setMinutes,
} from "date-fns";
import { db } from "@/lib/db";
import { effectivePlanningDate } from "@/lib/academic-deadlines";
import { computeInterventionOutcomes } from "@/lib/intervention-outcomes";
import { computeTimeToStart } from "@/lib/learning-signals";
import type { ClassMeeting, ExtractedClassSchedule } from "@/lib/parse-syllabus";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WeekPosition {
  weekNumber: number;
  weekLabel: string;
  topics: string[];
  readings: string[];
  completedTopics: string[];
  startDate: string | null;
}

export interface DeadlineItem {
  title: string;
  type: string;
  dueDate: string;
  pointsPossible: number | null;
  hoursUntilDue: number;
  planningDaysLeft: number;
  status: string;
  courseName: string;
  courseColor: string;
}

export interface CourseContextSnapshot {
  courseId: string;
  courseName: string;
  shortName: string | null;
  color: string;
  previousWeek: WeekPosition | null;
  currentWeek: WeekPosition | null;
  nextWeek: WeekPosition | null;
  positionConfidence: "exact" | "interpolated" | "semester-fraction" | "unknown";
  semesterProgress: number | null;
  gradeInfo: string;
  urgentAssignments: DeadlineItem[];   // due within 48h
  upcomingAssignments: DeadlineItem[]; // due within 14 days
  currentWeekProgress: string | null;
  nextClassMeeting: string | null;
}

// ── Input types (what DB loader provides) ────────────────────────────────────

export interface CourseContextInput {
  id: string;
  name: string;
  shortName: string | null;
  color: string;
  currentGrade: string | null;
  currentScore: number | null;
  classSchedule: ExtractedClassSchedule | null;
  topics: {
    weekNumber: number;
    weekLabel: string;
    startDate: string | null;
    topics: string[];
    readings: string[];
    completedTopics: string[];
  }[];
  assignments: {
    title: string;
    type: string;
    dueDate: string | null;
    status: string;
    pointsPossible: number | null;
    omitFromFinalGrade: boolean;
  }[];
}

// ── RFC 5545 day code → JS getDay() ─────────────────────────────────────────

const DAY_CODE_TO_JS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

const JS_TO_DAY_NAME: Record<number, string> = {
  0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday",
  4: "Thursday", 5: "Friday", 6: "Saturday",
};

// ── Pure computation ─────────────────────────────────────────────────────────

export function computeCourseContext(
  input: CourseContextInput,
  now: Date = new Date()
): CourseContextSnapshot {
  const topics = [...input.topics].sort((a, b) => a.weekNumber - b.weekNumber);

  // ── Week position ──
  const { previousWeek, currentWeek, nextWeek, confidence, semesterProgress } =
    resolveWeekPosition(topics, input.classSchedule, now);

  // ── Current week progress ──
  let currentWeekProgress: string | null = null;
  if (currentWeek && currentWeek.topics.length > 0) {
    const done = currentWeek.completedTopics.length;
    const total = currentWeek.topics.length;
    currentWeekProgress = `${done}/${total} topics completed`;
  }

  // ── Grade info ──
  const gradeInfo =
    input.currentScore != null
      ? `${input.currentScore}%${input.currentGrade ? ` (${input.currentGrade})` : ""}`
      : input.currentGrade ?? "not available";

  // ── Deadline bucketing ──
  const urgent: DeadlineItem[] = [];
  const upcoming: DeadlineItem[] = [];

  for (const a of input.assignments) {
    if (!a.dueDate || a.omitFromFinalGrade) continue;
    const due = parseISO(a.dueDate);
    if (!isValid(due)) continue;

    const hoursUntilDue = (due.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursUntilDue < -24) continue; // skip things due more than 24h ago

    const planning = effectivePlanningDate(a.dueDate);
    const planningDaysLeft = differenceInCalendarDays(planning, now);

    const item: DeadlineItem = {
      title: a.title,
      type: a.type,
      dueDate: a.dueDate,
      pointsPossible: a.pointsPossible,
      hoursUntilDue: Math.round(hoursUntilDue),
      planningDaysLeft,
      status: a.status,
      courseName: input.name,
      courseColor: input.color,
    };

    if (hoursUntilDue <= 48) {
      urgent.push(item);
    } else if (planningDaysLeft <= 14) {
      upcoming.push(item);
    }
  }

  urgent.sort((a, b) => a.hoursUntilDue - b.hoursUntilDue);
  upcoming.sort((a, b) => a.planningDaysLeft - b.planningDaysLeft);

  // ── Next class meeting ──
  const nextClassMeeting = findNextClassMeeting(input.classSchedule, now);

  return {
    courseId: input.id,
    courseName: input.name,
    shortName: input.shortName,
    color: input.color,
    previousWeek,
    currentWeek,
    nextWeek,
    positionConfidence: confidence,
    semesterProgress,
    gradeInfo,
    urgentAssignments: urgent,
    upcomingAssignments: upcoming,
    currentWeekProgress,
    nextClassMeeting,
  };
}

// ── Week position resolution (priority cascade) ─────────────────────────────

function resolveWeekPosition(
  topics: CourseContextInput["topics"],
  schedule: ExtractedClassSchedule | null,
  now: Date
): {
  previousWeek: WeekPosition | null;
  currentWeek: WeekPosition | null;
  nextWeek: WeekPosition | null;
  confidence: CourseContextSnapshot["positionConfidence"];
  semesterProgress: number | null;
} {
  if (topics.length === 0) {
    return { previousWeek: null, currentWeek: null, nextWeek: null, confidence: "unknown", semesterProgress: null };
  }

  // Strategy 1: Exact — topics have startDate fields
  const datedTopics = topics.filter((t) => t.startDate && isValid(parseISO(t.startDate)));
  if (datedTopics.length >= 2) {
    const result = resolveByExactDates(topics, datedTopics, now);
    if (result) {
      const semProg = computeSemesterProgress(schedule, topics, now);
      return { ...result, confidence: "exact", semesterProgress: semProg };
    }
  }

  // Strategy 2: Interpolated — first topic has startDate + semester end
  if (datedTopics.length >= 1 && schedule?.semesterEnd) {
    const result = resolveByInterpolation(topics, datedTopics[0], schedule.semesterEnd, now);
    if (result) {
      const semProg = computeSemesterProgress(schedule, topics, now);
      return { ...result, confidence: "interpolated", semesterProgress: semProg };
    }
  }

  // Strategy 3: Semester fraction
  if (schedule?.semesterStart && schedule?.semesterEnd) {
    const result = resolveBySemesterFraction(topics, schedule.semesterStart, schedule.semesterEnd, now);
    if (result) {
      const semProg = computeSemesterProgress(schedule, topics, now);
      return { ...result, confidence: "semester-fraction", semesterProgress: semProg };
    }
  }

  // Strategy 4: Unknown — just return the first, middle, and last weeks as rough reference
  return { previousWeek: null, currentWeek: null, nextWeek: null, confidence: "unknown", semesterProgress: null };
}

function toWeekPosition(topic: CourseContextInput["topics"][number]): WeekPosition {
  return {
    weekNumber: topic.weekNumber,
    weekLabel: topic.weekLabel,
    topics: topic.topics,
    readings: topic.readings,
    completedTopics: topic.completedTopics,
    startDate: topic.startDate,
  };
}

function resolveByExactDates(
  allTopics: CourseContextInput["topics"],
  datedTopics: CourseContextInput["topics"],
  now: Date
) {
  // Find the current week: startDate ≤ now < next startDate
  let currentIdx = -1;
  for (let i = 0; i < datedTopics.length; i++) {
    const start = parseISO(datedTopics[i].startDate!);
    const nextStart = i + 1 < datedTopics.length ? parseISO(datedTopics[i + 1].startDate!) : null;

    if (!isBefore(now, start) && (!nextStart || isBefore(now, nextStart))) {
      currentIdx = i;
      break;
    }
  }

  // If before all topics, current = first; if after all, current = last
  if (currentIdx === -1) {
    if (isBefore(now, parseISO(datedTopics[0].startDate!))) {
      currentIdx = 0;
    } else {
      currentIdx = datedTopics.length - 1;
    }
  }

  // Map back to allTopics index for prev/next
  const currentWeekNum = datedTopics[currentIdx].weekNumber;
  const allIdx = allTopics.findIndex((t) => t.weekNumber === currentWeekNum);

  return {
    previousWeek: allIdx > 0 ? toWeekPosition(allTopics[allIdx - 1]) : null,
    currentWeek: toWeekPosition(allTopics[allIdx]),
    nextWeek: allIdx < allTopics.length - 1 ? toWeekPosition(allTopics[allIdx + 1]) : null,
  };
}

function resolveByInterpolation(
  allTopics: CourseContextInput["topics"],
  firstDated: CourseContextInput["topics"][number],
  semesterEnd: string,
  now: Date
) {
  const start = parseISO(firstDated.startDate!);
  const end = parseISO(semesterEnd);
  if (!isValid(start) || !isValid(end)) return null;

  const totalDays = differenceInCalendarDays(end, start);
  if (totalDays <= 0) return null;

  const daysIn = differenceInCalendarDays(now, start);
  const fraction = Math.max(0, Math.min(1, daysIn / totalDays));
  const weekIdx = Math.min(
    Math.floor(fraction * allTopics.length),
    allTopics.length - 1
  );

  return {
    previousWeek: weekIdx > 0 ? toWeekPosition(allTopics[weekIdx - 1]) : null,
    currentWeek: toWeekPosition(allTopics[weekIdx]),
    nextWeek: weekIdx < allTopics.length - 1 ? toWeekPosition(allTopics[weekIdx + 1]) : null,
  };
}

function resolveBySemesterFraction(
  allTopics: CourseContextInput["topics"],
  semesterStart: string,
  semesterEnd: string,
  now: Date
) {
  const start = parseISO(semesterStart);
  const end = parseISO(semesterEnd);
  if (!isValid(start) || !isValid(end)) return null;

  const totalDays = differenceInCalendarDays(end, start);
  if (totalDays <= 0) return null;

  const daysIn = differenceInCalendarDays(now, start);
  const fraction = Math.max(0, Math.min(1, daysIn / totalDays));
  const weekIdx = Math.min(
    Math.floor(fraction * allTopics.length),
    allTopics.length - 1
  );

  return {
    previousWeek: weekIdx > 0 ? toWeekPosition(allTopics[weekIdx - 1]) : null,
    currentWeek: toWeekPosition(allTopics[weekIdx]),
    nextWeek: weekIdx < allTopics.length - 1 ? toWeekPosition(allTopics[weekIdx + 1]) : null,
  };
}

function computeSemesterProgress(
  schedule: ExtractedClassSchedule | null,
  topics: CourseContextInput["topics"],
  now: Date
): number | null {
  if (schedule?.semesterStart && schedule?.semesterEnd) {
    const start = parseISO(schedule.semesterStart);
    const end = parseISO(schedule.semesterEnd);
    if (isValid(start) && isValid(end)) {
      const total = differenceInCalendarDays(end, start);
      if (total > 0) {
        return Math.max(0, Math.min(1, differenceInCalendarDays(now, start) / total));
      }
    }
  }
  // Fallback: use first and last dated topics
  const dated = topics.filter((t) => t.startDate && isValid(parseISO(t.startDate!)));
  if (dated.length >= 2) {
    const first = parseISO(dated[0].startDate!);
    const last = parseISO(dated[dated.length - 1].startDate!);
    const total = differenceInCalendarDays(last, first);
    if (total > 0) {
      return Math.max(0, Math.min(1, differenceInCalendarDays(now, first) / total));
    }
  }
  return null;
}

// ── Next class meeting ───────────────────────────────────────────────────────

function findNextClassMeeting(
  schedule: ExtractedClassSchedule | null,
  now: Date
): string | null {
  if (!schedule?.meetings || schedule.meetings.length === 0) return null;

  // If past semester end, no more meetings
  if (schedule.semesterEnd) {
    const end = parseISO(schedule.semesterEnd);
    if (isValid(end) && isAfter(now, end)) return null;
  }

  let best: { meeting: ClassMeeting; date: Date } | null = null;

  for (const meeting of schedule.meetings) {
    if (!meeting.days?.length || !meeting.startTime) continue;

    const [h, m] = meeting.startTime.split(":").map(Number);

    // Check today and next 7 days
    for (let offset = 0; offset < 8; offset++) {
      const candidate = addDays(now, offset);
      const dayOfWeek = getDay(candidate);
      const dayCode = Object.entries(DAY_CODE_TO_JS).find(([, v]) => v === dayOfWeek)?.[0];

      if (!dayCode || !meeting.days.includes(dayCode)) continue;

      const meetingTime = setMinutes(setHours(candidate, h), m);
      if (!isAfter(meetingTime, now)) continue;

      if (!best || isBefore(meetingTime, best.date)) {
        best = { meeting, date: meetingTime };
      }
      break; // first match for this meeting is the soonest
    }
  }

  if (!best) return null;

  const dayName = JS_TO_DAY_NAME[getDay(best.date)];
  const timeStr = format(best.date, "h:mm a");
  const loc = best.meeting.location ? ` in ${best.meeting.location}` : "";
  const label = best.meeting.label ? ` (${best.meeting.label})` : "";
  return `${dayName} ${timeStr}${label}${loc}`;
}

// ── DB Loader ────────────────────────────────────────────────────────────────

export async function buildStudyContext(
  userId: string,
  courseId?: string
): Promise<{ snapshots: CourseContextSnapshot[]; promptText: string }> {
  const now = new Date();

  const where = courseId
    ? { id: courseId, userId }
    : { userId };

  const courses = await db.course.findMany({
    where,
    select: {
      id: true,
      name: true,
      shortName: true,
      color: true,
      currentGrade: true,
      currentScore: true,
      classSchedule: true,
      topics: {
        orderBy: { weekNumber: "asc" as const },
        select: {
          weekNumber: true,
          weekLabel: true,
          startDate: true,
          topics: true,
          readings: true,
          completedTopics: true,
        },
      },
      assignments: {
        where: {
          omitFromFinalGrade: false,
        },
        orderBy: { dueDate: "asc" as const },
        select: {
          title: true,
          type: true,
          dueDate: true,
          status: true,
          pointsPossible: true,
          omitFromFinalGrade: true,
        },
      },
    },
  });

  const snapshots = courses.map((course) =>
    computeCourseContext(
      {
        ...course,
        classSchedule: course.classSchedule as ExtractedClassSchedule | null,
      },
      now
    )
  );

  const mode = courseId ? "single" : "cross";
  let promptText = formatContextForPrompt(snapshots, mode);

  // Append reflection data if available
  const reflectionSummary = await buildReflectionSummary(userId, courseId);
  if (reflectionSummary) {
    promptText += "\n\n" + reflectionSummary;
  }

  return { snapshots, promptText };
}

// ── Prompt Formatter ─────────────────────────────────────────────────────────

export function formatContextForPrompt(
  snapshots: CourseContextSnapshot[],
  mode: "single" | "cross"
): string {
  if (snapshots.length === 0) return "No course data available.";

  const blocks = snapshots.map((s) => formatOneCourse(s));

  if (mode === "cross" && snapshots.length > 1) {
    // Add cross-course urgency summary
    const allUrgent = snapshots
      .flatMap((s) => s.urgentAssignments)
      .sort((a, b) => a.hoursUntilDue - b.hoursUntilDue)
      .slice(0, 5);

    if (allUrgent.length > 0) {
      const urgencyBlock =
        "=== MOST URGENT ACROSS ALL COURSES ===\n" +
        allUrgent
          .map((a) => {
            const hrs = a.hoursUntilDue;
            const timeStr = hrs < 0 ? "OVERDUE" : hrs < 24 ? `${hrs}h left` : `${Math.round(hrs / 24)}d left`;
            const pts = a.pointsPossible ? ` (${a.pointsPossible}pts)` : "";
            return `- ${a.courseName}: ${a.title} (${a.type}) — ${timeStr}${pts}`;
          })
          .join("\n");
      blocks.unshift(urgencyBlock);
    }
  }

  return blocks.join("\n\n");
}

function formatOneCourse(s: CourseContextSnapshot): string {
  const lines: string[] = [];

  // Header
  const progress = s.semesterProgress != null ? `, ${Math.round(s.semesterProgress * 100)}% through semester` : "";
  if (s.currentWeek) {
    lines.push(
      `=== ${s.courseName} ===`,
      `Week ${s.currentWeek.weekNumber}: "${s.currentWeek.weekLabel}" (${s.positionConfidence}${progress})`
    );
  } else {
    lines.push(`=== ${s.courseName} ===`, `Timeline not available${progress}`);
  }

  // Previous / Next week context
  if (s.previousWeek) {
    const done = s.previousWeek.completedTopics.length;
    const total = s.previousWeek.topics.length;
    const topicStr = s.previousWeek.topics.slice(0, 3).join(", ");
    const completionStr = total > 0 ? ` (${done}/${total} done)` : "";
    lines.push(`Previous: Week ${s.previousWeek.weekNumber} — "${s.previousWeek.weekLabel}": ${topicStr}${completionStr}`);
  }

  if (s.currentWeek && s.currentWeek.topics.length > 0) {
    lines.push(`Current topics: ${s.currentWeek.topics.join(", ")}`);
  }

  if (s.nextWeek) {
    const topicStr = s.nextWeek.topics.slice(0, 3).join(", ");
    lines.push(`Next: Week ${s.nextWeek.weekNumber} — "${s.nextWeek.weekLabel}": ${topicStr}`);
  }

  // Progress + grade
  if (s.currentWeekProgress) lines.push(`Progress: ${s.currentWeekProgress}`);
  lines.push(`Grade: ${s.gradeInfo}`);
  if (s.nextClassMeeting) lines.push(`Next class: ${s.nextClassMeeting}`);

  // Urgent deadlines
  if (s.urgentAssignments.length > 0) {
    lines.push("", "Urgent (≤48h):");
    for (const a of s.urgentAssignments) {
      const hrs = a.hoursUntilDue;
      const timeStr = hrs < 0 ? "OVERDUE" : hrs < 24 ? `${hrs}h left` : `${Math.round(hrs / 24)}d left`;
      const pts = a.pointsPossible ? `, ${a.pointsPossible}pts` : "";
      const status = a.status !== "not_started" ? ` [${a.status}]` : "";
      lines.push(`- ${a.title} (${a.type}) — ${timeStr}${pts}${status}`);
    }
  }

  // Upcoming
  if (s.upcomingAssignments.length > 0) {
    lines.push("", "Coming up (≤14 days):");
    for (const a of s.upcomingAssignments.slice(0, 8)) {
      const pts = a.pointsPossible ? `, ${a.pointsPossible}pts` : "";
      const status = a.status !== "not_started" ? ` [${a.status}]` : "";
      lines.push(`- ${a.title} (${a.type}) — ${a.planningDaysLeft}d left${pts}${status}`);
    }
  }

  return lines.join("\n");
}

// ── Reflection Summary (with temporal trends + behavioral signals) ───────────

export async function buildReflectionSummary(
  userId: string,
  courseId?: string
): Promise<string> {
  const where: Record<string, unknown> = { userId };
  if (courseId) where.courseId = courseId;

  const now = new Date();
  const sevenDaysAgo = subDays(now, 7);
  const fourteenDaysAgo = subDays(now, 14);

  const [reflections, taskStats, assignmentStats, planTaskStats] = await Promise.all([
    db.reflection.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    // Task completion in last 7 days
    Promise.all([
      db.task.count({
        where: { userId, completed: true, completedAt: { gte: sevenDaysAgo } },
      }),
      db.task.count({
        where: {
          userId,
          OR: [
            { completed: true, completedAt: { gte: sevenDaysAgo } },
            { completed: false, dueDate: { gte: format(sevenDaysAgo, "yyyy-MM-dd"), lte: format(now, "yyyy-MM-dd") } },
          ],
        },
      }),
    ]),
    // On-time submission rate
    (async () => {
      const courseIds = courseId
        ? [courseId]
        : (await db.course.findMany({ where: { userId }, select: { id: true } })).map((c) => c.id);
      if (courseIds.length === 0) return null;
      const submitted = await db.assignment.findMany({
        where: { courseId: { in: courseIds }, status: { in: ["submitted", "graded"] } },
        select: { late: true },
      });
      if (submitted.length === 0) return null;
      const onTime = submitted.filter((a) => !a.late).length;
      return { onTime, total: submitted.length };
    })(),
    // Plan follow-through
    Promise.all([
      db.task.count({ where: { userId, source: "plan" } }),
      db.task.count({ where: { userId, source: "plan", completed: true } }),
    ]),
  ]);

  if (reflections.length === 0 && taskStats[0] === 0 && !assignmentStats) return "";

  const lines: string[] = ["=== STUDENT LEARNING SIGNALS ==="];

  const taskReflections = reflections.filter((r) => r.type === "task_completion");
  const assignmentReflections = reflections.filter((r) => r.type === "post_assignment");
  const preClassReflections = reflections.filter((r) => r.type === "pre_class");

  // Task completion confidence patterns
  if (taskReflections.length > 0) {
    const withConf = taskReflections.filter((r) => r.confidence !== null);
    if (withConf.length > 0) {
      const avgConf = withConf.reduce((sum, r) => sum + r.confidence!, 0) / withConf.length;
      const confLabel = avgConf < 1 ? "low" : avgConf < 2 ? "moderate" : avgConf < 3 ? "good" : "high";
      lines.push(`Study confidence: ${confLabel} (avg ${avgConf.toFixed(1)}/3 over ${withConf.length} sessions)`);

      // Confidence trend — compare last 7d vs prior 7d
      const recent = withConf.filter((r) => r.createdAt >= sevenDaysAgo);
      const prior = withConf.filter((r) => r.createdAt < sevenDaysAgo && r.createdAt >= fourteenDaysAgo);
      if (recent.length >= 2 && prior.length >= 2) {
        const recentAvg = recent.reduce((s, r) => s + r.confidence!, 0) / recent.length;
        const priorAvg = prior.reduce((s, r) => s + r.confidence!, 0) / prior.length;
        const delta = recentAvg - priorAvg;
        if (delta > 0.3) {
          lines.push(`Confidence trend: IMPROVING (was ${priorAvg.toFixed(1)}, now ${recentAvg.toFixed(1)})`);
        } else if (delta < -0.3) {
          lines.push(`Confidence trend: DECLINING (was ${priorAvg.toFixed(1)}, now ${recentAvg.toFixed(1)}) — student may need extra support`);
        } else {
          lines.push(`Confidence trend: stable over the last 2 weeks`);
        }
      }
    }

    // Most common blocker
    const blockerCounts: Record<string, number> = {};
    for (const r of taskReflections) {
      if (r.blocker && r.blocker !== "none") {
        blockerCounts[r.blocker] = (blockerCounts[r.blocker] ?? 0) + 1;
      }
    }
    const topBlocker = Object.entries(blockerCounts).sort(([, a], [, b]) => b - a)[0];
    if (topBlocker) {
      const blockerLabels: Record<string, string> = {
        confused_by_topic: "confusion about the material",
        ran_out_of_time: "time management",
        missing_prereq: "missing prerequisite knowledge",
      };
      lines.push(`Most common blocker: ${blockerLabels[topBlocker[0]] ?? topBlocker[0]} (${topBlocker[1]}x)`);
    }

    // Recent low-confidence sessions
    const recentLow = withConf.filter((r) => r.confidence! <= 1).slice(0, 3);
    if (recentLow.length > 0) {
      const topicStrs = recentLow.map((r) => r.topics.length > 0 ? r.topics.join(", ") : "general");
      lines.push("Recent struggles: " + topicStrs.join("; "));
    }
  }

  // Post-assignment understanding
  if (assignmentReflections.length > 0) {
    const withConf = assignmentReflections.filter((r) => r.confidence !== null);
    const low = withConf.filter((r) => r.confidence! <= 1);
    if (low.length > 0) {
      lines.push(`Assignments with low understanding: ${low.length}/${withConf.length}`);
    }
  }

  // Pre-class self-assessment
  if (preClassReflections.length > 0) {
    const recent = preClassReflections[0];
    if (recent.priorKnowledge) {
      const pkLabels: Record<string, string> = {
        nothing: "no prior exposure",
        heard_of_it: "heard of it",
        some_understanding: "some understanding",
        comfortable: "comfortable",
      };
      const topic = recent.topics[0] ?? "upcoming topic";
      lines.push(`Pre-class self-assessment for "${topic}": ${pkLabels[recent.priorKnowledge] ?? recent.priorKnowledge}`);
    }
  }

  // Behavioral signals — task completion this week
  const [completedTasks, totalTasks] = taskStats;
  if (totalTasks > 0) {
    lines.push(`Task completion (7d): ${completedTasks}/${totalTasks} tasks completed this week`);
  }

  // On-time submission rate
  if (assignmentStats) {
    const pct = Math.round((assignmentStats.onTime / assignmentStats.total) * 100);
    lines.push(`On-time submission rate: ${pct}% (${assignmentStats.onTime}/${assignmentStats.total} submitted on time)`);
  }

  // Plan follow-through
  const [planCreated, planCompleted] = planTaskStats;
  if (planCreated > 0) {
    const pct = Math.round((planCompleted / planCreated) * 100);
    lines.push(`Plan follow-through: ${planCompleted}/${planCreated} planned tasks completed (${pct}%)`);
  }

  // Time-to-start
  const timeToStart = await computeTimeToStart(userId);
  if (timeToStart) {
    lines.push(`Avg time-to-start: ${timeToStart.avgDaysBefore} days before deadline (${timeToStart.count} assignments)`);
  }

  // Intervention effectiveness (Pillar 3)
  const interventions = await computeInterventionOutcomes(userId, courseId);
  const insights = interventions.outcomes.filter((o) => o.insight);
  if (insights.length > 0) {
    lines.push("");
    lines.push("=== INTERVENTION EFFECTIVENESS ===");
    for (const o of insights) {
      lines.push(o.insight!);
    }
    if (interventions.effectiveInterventions.length > 0) {
      lines.push(`Most effective tools for this student: ${interventions.effectiveInterventions.join(", ")}`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}
