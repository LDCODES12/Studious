/**
 * Week Overview — AI-generated weekly summary
 *
 * Generated once per week on first dashboard visit, cached in LearningEvent.
 * Uses gpt-4o-mini for cost efficiency.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { db } from "@/lib/db";
import { getISOWeek, getISOWeekYear, format, startOfWeek, addDays, parseISO, isValid } from "date-fns";
import type { CourseContextSnapshot, DeadlineItem } from "@/lib/course-context";
import type { LearningSignals } from "@/lib/learning-signals";
import type { ExtractedClassSchedule, ClassMeeting } from "@/lib/parse-syllabus";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WeekOverviewData {
  weekKey: string;
  summary: string;
  days: { day: string; note: string }[];
  generatedAt: string;
}

export interface WeekDayData {
  dayName: string;        // "Mon", "Tue", etc.
  date: string;           // "Mar 3"
  isToday: boolean;
  classes: {
    courseName: string;
    courseColor: string;
    label: string;        // "Lecture", "Lab"
    time: string;         // "9:00 AM"
    location: string;
  }[];
  deadlines: {
    title: string;
    type: string;
    courseName: string;
    courseColor: string;
    pointsPossible: number | null;
    status: string;
  }[];
  aiNote: string;
}

// ── Week key ─────────────────────────────────────────────────────────────────

export function getCurrentWeekKey(now: Date = new Date()): string {
  return `${getISOWeekYear(now)}-W${String(getISOWeek(now)).padStart(2, "0")}`;
}

// ── Zod schema for AI output ─────────────────────────────────────────────────

const weekOverviewSchema = z.object({
  summary: z.string().describe("1-2 sentence overview of the week — priorities, big items, encouragement"),
  days: z.array(z.object({
    day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    note: z.string().describe("One brief sentence: what to focus on, what's due, or encouragement"),
  })),
});

// ── Build structured day data (no AI needed) ─────────────────────────────────

const DAY_CODE_TO_JS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildWeekDays(
  courseContexts: { course: { name: string; color: string }; context: CourseContextSnapshot; classSchedule: ExtractedClassSchedule | null }[],
  now: Date = new Date(),
): Omit<WeekDayData, "aiNote">[] {
  const weekStart = startOfWeek(now, { weekStartsOn: 1 }); // Monday
  const todayStr = format(now, "yyyy-MM-dd");

  const days: Omit<WeekDayData, "aiNote">[] = [];

  for (let i = 0; i < 5; i++) { // Mon–Fri
    const date = addDays(weekStart, i);
    const dateStr = format(date, "yyyy-MM-dd");
    const dayOfWeek = date.getDay(); // 0=Sun ... 6=Sat

    // Find classes on this day
    const classes: WeekDayData["classes"] = [];
    for (const { course, classSchedule } of courseContexts) {
      if (!classSchedule?.meetings) continue;
      for (const meeting of classSchedule.meetings) {
        if (!meeting.days?.length || !meeting.startTime) continue;
        const meetingDayNums = meeting.days.map((d) => DAY_CODE_TO_JS[d]).filter((n) => n !== undefined);
        if (meetingDayNums.includes(dayOfWeek)) {
          const [h, m] = meeting.startTime.split(":").map(Number);
          const hour12 = h % 12 || 12;
          const ampm = h < 12 ? "AM" : "PM";
          const timeStr = m === 0 ? `${hour12} ${ampm}` : `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;

          classes.push({
            courseName: course.name,
            courseColor: course.color,
            label: meeting.label || "Class",
            time: timeStr,
            location: meeting.location || "",
          });
        }
      }
    }

    // Sort classes by time
    classes.sort((a, b) => a.time.localeCompare(b.time));

    // Find assignments due on this day
    const deadlines: WeekDayData["deadlines"] = [];
    for (const { course, context } of courseContexts) {
      const allAssignments = [...context.urgentAssignments, ...context.upcomingAssignments];
      for (const a of allAssignments) {
        if (!a.dueDate) continue;
        const dueDate = parseISO(a.dueDate);
        if (!isValid(dueDate)) continue;
        if (format(dueDate, "yyyy-MM-dd") === dateStr) {
          deadlines.push({
            title: a.title,
            type: a.type,
            courseName: course.name,
            courseColor: course.color,
            pointsPossible: a.pointsPossible,
            status: a.status,
          });
        }
      }
    }

    days.push({
      dayName: DAY_NAMES[dayOfWeek],
      date: format(date, "MMM d"),
      isToday: dateStr === todayStr,
      classes,
      deadlines,
    });
  }

  return days;
}

// ── AI generation ────────────────────────────────────────────────────────────

async function generateOverview(
  courseContexts: { course: { name: string; color: string }; context: CourseContextSnapshot }[],
  signals: LearningSignals | null,
  now: Date,
): Promise<{ summary: string; days: { day: string; note: string }[] }> {
  // Build context for the AI
  const courseLines = courseContexts.map(({ course, context }) => {
    const parts = [`${course.name}:`];
    if (context.currentWeek) {
      parts.push(`This week: "${context.currentWeek.weekLabel}"`);
      if (context.currentWeek.topics.length > 0) {
        parts.push(`Topics: ${context.currentWeek.topics.join(", ")}`);
      }
      if (context.currentWeek.readings.length > 0) {
        parts.push(`Readings: ${context.currentWeek.readings.join(", ")}`);
      }
    }
    parts.push(`Grade: ${context.gradeInfo}`);
    return parts.join(" | ");
  });

  const allDeadlines = courseContexts.flatMap(({ context }) =>
    [...context.urgentAssignments, ...context.upcomingAssignments]
  );
  const deadlineLines = allDeadlines
    .sort((a, b) => a.hoursUntilDue - b.hoursUntilDue)
    .slice(0, 15)
    .map((a) => {
      const pts = a.pointsPossible ? ` (${a.pointsPossible}pts)` : "";
      const due = parseISO(a.dueDate);
      const dayStr = isValid(due) ? format(due, "EEE") : "?";
      return `${a.courseName}: ${a.title} (${a.type}) — due ${dayStr}${pts} [${a.status}]`;
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
    system: `You write brief, helpful weekly overviews for a college student. Be specific and practical — reference actual course names, assignment names, and due dates. Keep the summary to 1-2 sentences. Keep each day's note to one short sentence. If it's mid-week, acknowledge what's already passed and focus forward. Be encouraging but honest about heavy workloads.`,
    prompt: `Today is ${dayOfWeek}, ${format(now, "MMMM d")}.

Courses this week:
${courseLines.join("\n")}

Assignments due this week:
${deadlineLines.length > 0 ? deadlineLines.join("\n") : "None"}
${studentCtx}

Write a week overview with a summary and a note for each day Mon–Fri.`,
  });

  return object;
}

// ── Cache logic ──────────────────────────────────────────────────────────────

export async function getOrCreateWeekOverview(
  userId: string,
  courseContexts: { course: { name: string; color: string }; context: CourseContextSnapshot; classSchedule: ExtractedClassSchedule | null }[],
  signals: LearningSignals | null,
): Promise<WeekOverviewData | null> {
  if (courseContexts.length === 0) return null;

  const now = new Date();
  const weekKey = getCurrentWeekKey(now);

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
    if (meta.weekKey === weekKey) {
      return meta as unknown as WeekOverviewData;
    }
  }

  // Generate new overview
  try {
    const result = await generateOverview(courseContexts, signals, now);

    const data: WeekOverviewData = {
      weekKey,
      summary: result.summary,
      days: result.days,
      generatedAt: now.toISOString(),
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
