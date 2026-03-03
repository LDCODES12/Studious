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
}

export interface WeekCourseData {
  courseId: string;
  courseName: string;
  courseColor: string;
  weekLabel: string | null;
  topics: string[];
  readings: string[];
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

// ── Week key ─────────────────────────────────────────────────────────────────

export function getCurrentWeekKey(now: Date = new Date()): string {
  return `${getISOWeekYear(now)}-W${String(getISOWeek(now)).padStart(2, "0")}`;
}

// ── Build structured week data (no AI needed) ────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildWeekCourses(
  courseContexts: { course: { id: string; name: string; color: string }; context: CourseContextSnapshot }[],
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
        deadlines,
        aiNote: null,
      };
    })
    .filter((c) => c.topics.length > 0 || c.readings.length > 0 || c.deadlines.length > 0);
}

export function buildDeadlineDays(
  courseContexts: { course: { name: string; color: string }; context: CourseContextSnapshot }[],
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
  courseContexts: { course: { name: string; color: string }; context: CourseContextSnapshot }[],
  signals: LearningSignals | null,
  now: Date,
): Promise<{ summary: string; courseNotes: { courseName: string; note: string }[] }> {
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
    }
    parts.push(`Grade: ${context.gradeInfo}`);

    const deadlines = [...context.urgentAssignments, ...context.upcomingAssignments];
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

// ── Cache logic ──────────────────────────────────────────────────────────────

export async function getOrCreateWeekOverview(
  userId: string,
  courseContexts: { course: { id: string; name: string; color: string }; context: CourseContextSnapshot }[],
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
      courseNotes: result.courseNotes,
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
