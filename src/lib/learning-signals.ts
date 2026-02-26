/**
 * Learning Process Signals
 *
 * Computes derived analytics from existing behavior data:
 * tasks, assignments, reflections, learning events.
 * No new user input required — all signals from existing behavior.
 */

import { db } from "@/lib/db";
import { subDays, startOfDay, format, differenceInCalendarDays, parseISO } from "date-fns";

// ── Output Types ────────────────────────────────────────────────────────────

export interface ConfidenceTrend {
  direction: "improving" | "declining" | "stable" | "insufficient";
  recentAvg: number;       // last 7 days avg
  priorAvg: number;        // 7-14 days ago avg
  totalReflections: number;
}

export interface LearningSignals {
  confidenceTrend: ConfidenceTrend;
  studyStreak: number;
  activeDaysLast7: number;
  taskCompletion: { done: number; total: number; rate: number } | null;
  onTimeRate: { onTime: number; total: number; rate: number } | null;
  topBlockers: { blocker: string; count: number }[];
  perCourseConfidence: { courseId: string; avg: number; count: number }[];
  planCount7d: number;
  planFollowThrough: { created: number; completed: number; rate: number } | null;
  timeToStart: { avgDaysBefore: number; count: number } | null;
}

export interface CourseLearningSignals {
  avgConfidence: number | null;
  confidenceCount: number;
  topBlocker: string | null;
  topBlockerCount: number;
}

// ── Confidence Trend ────────────────────────────────────────────────────────

async function computeConfidenceTrend(userId: string): Promise<ConfidenceTrend> {
  const now = new Date();
  const fourteenDaysAgo = subDays(now, 14);
  const sevenDaysAgo = subDays(now, 7);

  const reflections = await db.reflection.findMany({
    where: {
      userId,
      confidence: { not: null },
      createdAt: { gte: fourteenDaysAgo },
    },
    select: { confidence: true, createdAt: true },
  });

  if (reflections.length < 3) {
    return {
      direction: "insufficient",
      recentAvg: 0,
      priorAvg: 0,
      totalReflections: reflections.length,
    };
  }

  const recent = reflections.filter((r) => r.createdAt >= sevenDaysAgo);
  const prior = reflections.filter((r) => r.createdAt < sevenDaysAgo);

  if (recent.length === 0 || prior.length === 0) {
    const avg =
      reflections.reduce((s, r) => s + r.confidence!, 0) / reflections.length;
    return {
      direction: "stable",
      recentAvg: avg,
      priorAvg: avg,
      totalReflections: reflections.length,
    };
  }

  const recentAvg =
    recent.reduce((s, r) => s + r.confidence!, 0) / recent.length;
  const priorAvg =
    prior.reduce((s, r) => s + r.confidence!, 0) / prior.length;
  const delta = recentAvg - priorAvg;

  // 0.3 on a 0-3 scale (10%) threshold for meaningful change
  const direction =
    delta > 0.3 ? "improving" : delta < -0.3 ? "declining" : "stable";

  return { direction, recentAvg, priorAvg, totalReflections: reflections.length };
}

// ── Study Streak ────────────────────────────────────────────────────────────

async function computeStudyStreak(
  userId: string
): Promise<{ streak: number; activeDays7: number }> {
  const now = new Date();
  const thirtyDaysAgo = subDays(now, 30);

  const [completedTasks, reflections] = await Promise.all([
    db.task.findMany({
      where: {
        userId,
        completed: true,
        completedAt: { gte: thirtyDaysAgo },
      },
      select: { completedAt: true },
    }),
    db.reflection.findMany({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
    }),
  ]);

  const activeDates = new Set<string>();
  for (const t of completedTasks) {
    if (t.completedAt) activeDates.add(format(t.completedAt, "yyyy-MM-dd"));
  }
  for (const r of reflections) {
    activeDates.add(format(r.createdAt, "yyyy-MM-dd"));
  }

  // Active days in last 7
  const sevenDaysAgo = subDays(now, 7);
  let activeDays7 = 0;
  for (const dateStr of activeDates) {
    if (new Date(dateStr) >= startOfDay(sevenDaysAgo)) activeDays7++;
  }

  // Streak: consecutive days backward from today
  let streak = 0;
  let checkDate = startOfDay(now);
  while (activeDates.has(format(checkDate, "yyyy-MM-dd"))) {
    streak++;
    checkDate = subDays(checkDate, 1);
  }

  return { streak, activeDays7 };
}

// ── Task Completion Rate ────────────────────────────────────────────────────

async function computeTaskCompletion(
  userId: string
): Promise<{ done: number; total: number; rate: number } | null> {
  const thirtyDaysAgo = subDays(new Date(), 30);

  const [done, total] = await Promise.all([
    db.task.count({
      where: { userId, completed: true, completedAt: { gte: thirtyDaysAgo } },
    }),
    db.task.count({
      where: {
        userId,
        OR: [
          { completed: true, completedAt: { gte: thirtyDaysAgo } },
          { completed: false, createdAt: { gte: thirtyDaysAgo } },
        ],
      },
    }),
  ]);

  if (total === 0) return null;
  return { done, total, rate: done / total };
}

// ── On-Time Rate ────────────────────────────────────────────────────────────

async function computeOnTimeRate(
  userId: string
): Promise<{ onTime: number; total: number; rate: number } | null> {
  const courseIds = (
    await db.course.findMany({
      where: { userId },
      select: { id: true },
    })
  ).map((c) => c.id);

  if (courseIds.length === 0) return null;

  const submitted = await db.assignment.findMany({
    where: {
      courseId: { in: courseIds },
      status: { in: ["submitted", "graded"] },
    },
    select: { late: true },
  });

  if (submitted.length === 0) return null;
  const onTime = submitted.filter((a) => !a.late).length;
  return { onTime, total: submitted.length, rate: onTime / submitted.length };
}

// ── Top Blockers ────────────────────────────────────────────────────────────

async function computeTopBlockers(
  userId: string
): Promise<{ blocker: string; count: number }[]> {
  const reflections = await db.reflection.findMany({
    where: {
      userId,
      blocker: { notIn: ["none"] },
      NOT: { blocker: null },
    },
    select: { blocker: true },
    take: 50,
    orderBy: { createdAt: "desc" },
  });

  const counts: Record<string, number> = {};
  for (const r of reflections) {
    if (r.blocker) counts[r.blocker] = (counts[r.blocker] ?? 0) + 1;
  }

  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([blocker, count]) => ({ blocker, count }));
}

// ── Per-Course Confidence ───────────────────────────────────────────────────

async function computePerCourseConfidence(
  userId: string
): Promise<{ courseId: string; avg: number; count: number }[]> {
  const reflections = await db.reflection.findMany({
    where: { userId, confidence: { not: null }, courseId: { not: null } },
    select: { courseId: true, confidence: true },
    take: 100,
    orderBy: { createdAt: "desc" },
  });

  const groups: Record<string, { sum: number; count: number }> = {};
  for (const r of reflections) {
    if (!r.courseId) continue;
    const g = (groups[r.courseId] ??= { sum: 0, count: 0 });
    g.sum += r.confidence!;
    g.count++;
  }

  return Object.entries(groups).map(([courseId, g]) => ({
    courseId,
    avg: g.sum / g.count,
    count: g.count,
  }));
}

// ── Time-to-Start ──────────────────────────────────────────────────────────

export async function computeTimeToStart(
  userId: string
): Promise<{ avgDaysBefore: number; count: number } | null> {
  const courseIds = (
    await db.course.findMany({
      where: { userId },
      select: { id: true },
    })
  ).map((c) => c.id);

  if (courseIds.length === 0) return null;

  // Find submitted/graded assignments with due dates
  const assignments = await db.assignment.findMany({
    where: {
      courseId: { in: courseIds },
      dueDate: { not: null },
      status: { in: ["submitted", "graded"] },
    },
    select: { id: true, dueDate: true },
  });

  if (assignments.length === 0) return null;

  // Find earliest task per assignment
  const tasks = await db.task.findMany({
    where: {
      userId,
      assignmentId: { in: assignments.map((a) => a.id) },
    },
    select: { assignmentId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const earliestByAssignment: Record<string, Date> = {};
  for (const t of tasks) {
    if (t.assignmentId && !earliestByAssignment[t.assignmentId]) {
      earliestByAssignment[t.assignmentId] = t.createdAt;
    }
  }

  const daysBefore: number[] = [];
  for (const a of assignments) {
    if (a.dueDate && earliestByAssignment[a.id]) {
      const days = differenceInCalendarDays(
        parseISO(a.dueDate),
        earliestByAssignment[a.id]
      );
      if (days >= 0) daysBefore.push(days);
    }
  }

  if (daysBefore.length === 0) return null;

  const avg = daysBefore.reduce((s, d) => s + d, 0) / daysBefore.length;
  return { avgDaysBefore: Math.round(avg * 10) / 10, count: daysBefore.length };
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export async function computeLearningSignals(
  userId: string
): Promise<LearningSignals> {
  const sevenDaysAgo = subDays(new Date(), 7);

  const [
    confidenceTrend,
    streakData,
    taskCompletion,
    onTimeRate,
    topBlockers,
    perCourseConfidence,
    planCount7d,
    planTaskCounts,
    timeToStart,
  ] = await Promise.all([
    computeConfidenceTrend(userId),
    computeStudyStreak(userId),
    computeTaskCompletion(userId),
    computeOnTimeRate(userId),
    computeTopBlockers(userId),
    computePerCourseConfidence(userId),
    db.learningEvent.count({
      where: {
        userId,
        type: "plan_generated",
        createdAt: { gte: sevenDaysAgo },
      },
    }),
    // Plan follow-through: tasks created from study plans
    Promise.all([
      db.task.count({ where: { userId, source: "plan" } }),
      db.task.count({ where: { userId, source: "plan", completed: true } }),
    ]),
    computeTimeToStart(userId),
  ]);

  const [planCreated, planCompleted] = planTaskCounts;
  const planFollowThrough =
    planCreated > 0
      ? { created: planCreated, completed: planCompleted, rate: planCompleted / planCreated }
      : null;

  return {
    confidenceTrend,
    studyStreak: streakData.streak,
    activeDaysLast7: streakData.activeDays7,
    taskCompletion,
    onTimeRate,
    topBlockers,
    perCourseConfidence,
    planCount7d,
    planFollowThrough,
    timeToStart,
  };
}

// ── Course-Level Signals ────────────────────────────────────────────────────

export async function computeCourseLearningSignals(
  userId: string,
  courseId: string
): Promise<CourseLearningSignals> {
  const reflections = await db.reflection.findMany({
    where: { userId, courseId, confidence: { not: null } },
    select: { confidence: true, blocker: true },
    take: 30,
    orderBy: { createdAt: "desc" },
  });

  const withConf = reflections.filter((r) => r.confidence !== null);
  const avgConfidence =
    withConf.length > 0
      ? withConf.reduce((s, r) => s + r.confidence!, 0) / withConf.length
      : null;

  const blockerCounts: Record<string, number> = {};
  for (const r of reflections) {
    if (r.blocker && r.blocker !== "none") {
      blockerCounts[r.blocker] = (blockerCounts[r.blocker] ?? 0) + 1;
    }
  }
  const topEntry = Object.entries(blockerCounts).sort(
    ([, a], [, b]) => b - a
  )[0];

  return {
    avgConfidence,
    confidenceCount: withConf.length,
    topBlocker: topEntry?.[0] ?? null,
    topBlockerCount: topEntry?.[1] ?? 0,
  };
}
