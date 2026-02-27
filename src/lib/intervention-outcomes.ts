/**
 * Intervention Outcomes — Pillar 3
 *
 * Measures whether AI interventions (plans, chat, reflections) actually
 * improve student behavior. Compares post-intervention metrics to baseline.
 * No new user input required — all derived from existing LearningEvent,
 * Task, and Reflection data.
 */

import { db } from "@/lib/db";
import { subDays, addHours } from "date-fns";

// ── Types ────────────────────────────────────────────────────────────────────

export interface InterventionOutcome {
  type: string;
  label: string;
  sampleSize: number;
  taskLift: number | null;        // percentage-point difference vs baseline
  confidenceLift: number | null;  // difference on 0-3 scale vs baseline
  insight: string | null;
}

export interface InterventionSummary {
  outcomes: InterventionOutcome[];
  topInsight: string | null;
  effectiveInterventions: string[];
}

// ── Config ───────────────────────────────────────────────────────────────────

const INTERVENTION_TYPES = [
  { type: "plan_generated",       label: "Study plans",    windowHours: 48 },
  { type: "chat_session",         label: "Chat sessions",  windowHours: 48 },
  { type: "reflection_completed", label: "Reflections",    windowHours: 24 },
] as const;

const MIN_SAMPLE = 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function measureWindow(
  userId: string,
  start: Date,
  end: Date,
  courseId?: string,
): Promise<{ tasksCompleted: number; avgConfidence: number | null }> {
  const taskWhere: Record<string, unknown> = {
    userId,
    completed: true,
    completedAt: { gte: start, lte: end },
  };
  if (courseId) taskWhere.courseId = courseId;

  const reflWhere: Record<string, unknown> = {
    userId,
    confidence: { not: null },
    createdAt: { gte: start, lte: end },
  };
  if (courseId) reflWhere.courseId = courseId;

  const [taskCount, reflections] = await Promise.all([
    db.task.count({ where: taskWhere }),
    db.reflection.findMany({
      where: reflWhere,
      select: { confidence: true },
    }),
  ]);

  const avgConfidence =
    reflections.length > 0
      ? reflections.reduce((s, r) => s + r.confidence!, 0) / reflections.length
      : null;

  return { tasksCompleted: taskCount, avgConfidence };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function computeInterventionOutcomes(
  userId: string,
  courseId?: string,
): Promise<InterventionSummary> {
  const now = new Date();
  const thirtyDaysAgo = subDays(now, 30);

  // Baseline: average daily task completion and confidence over 30 days
  const baselineWindow = await measureWindow(userId, thirtyDaysAgo, now, courseId);
  const baselineTasksPerDay = baselineWindow.tasksCompleted / 30;
  const baselineConfidence = baselineWindow.avgConfidence;

  // Compute outcome for each intervention type
  const outcomes: InterventionOutcome[] = [];

  for (const cfg of INTERVENTION_TYPES) {
    const events = await db.learningEvent.findMany({
      where: {
        userId,
        type: cfg.type,
        createdAt: { gte: thirtyDaysAgo },
        ...(courseId && cfg.type !== "plan_generated"
          ? { metadata: { path: ["courseId"], equals: courseId } }
          : {}),
      },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    if (events.length < MIN_SAMPLE) {
      outcomes.push({
        type: cfg.type,
        label: cfg.label,
        sampleSize: events.length,
        taskLift: null,
        confidenceLift: null,
        insight: null,
      });
      continue;
    }

    // Measure post-intervention windows
    let totalTasks = 0;
    let totalConf = 0;
    let confCount = 0;

    for (const event of events) {
      const windowStart = event.createdAt;
      const windowEnd = addHours(event.createdAt, cfg.windowHours);
      const result = await measureWindow(userId, windowStart, windowEnd, courseId);
      totalTasks += result.tasksCompleted;
      if (result.avgConfidence !== null) {
        totalConf += result.avgConfidence;
        confCount++;
      }
    }

    // Normalize to per-day equivalent for comparison
    const windowDays = cfg.windowHours / 24;
    const postTasksPerDay = totalTasks / (events.length * windowDays);
    const postConfidence = confCount > 0 ? totalConf / confCount : null;

    // Compute lift
    const taskLift =
      baselineTasksPerDay > 0
        ? (postTasksPerDay - baselineTasksPerDay) / baselineTasksPerDay
        : postTasksPerDay > 0 ? 1 : null;

    const confidenceLift =
      postConfidence !== null && baselineConfidence !== null
        ? postConfidence - baselineConfidence
        : null;

    // Generate insight
    const insight = generateInsight(cfg.label, taskLift, confidenceLift, events.length);

    outcomes.push({
      type: cfg.type,
      label: cfg.label,
      sampleSize: events.length,
      taskLift,
      confidenceLift,
      insight,
    });
  }

  // Aggregate
  const effectiveInterventions = outcomes
    .filter(
      (o) =>
        (o.taskLift !== null && o.taskLift > 0.1) ||
        (o.confidenceLift !== null && o.confidenceLift > 0.3),
    )
    .map((o) => o.label);

  const topInsight =
    outcomes
      .filter((o) => o.insight !== null)
      .sort((a, b) => {
        const aScore = Math.abs(a.taskLift ?? 0) + Math.abs(a.confidenceLift ?? 0);
        const bScore = Math.abs(b.taskLift ?? 0) + Math.abs(b.confidenceLift ?? 0);
        return bScore - aScore;
      })[0]?.insight ?? null;

  return { outcomes, topInsight, effectiveInterventions };
}

// ── Insight Generation ───────────────────────────────────────────────────────

function generateInsight(
  label: string,
  taskLift: number | null,
  confidenceLift: number | null,
  sampleSize: number,
): string | null {
  const prefix = sampleSize < 3 ? "Early sign: " : "";

  // Positive task lift
  if (taskLift !== null && taskLift > 0.1) {
    return `${prefix}${label} are working — you complete ${Math.round(taskLift * 100)}% more tasks afterward.`;
  }

  // Positive confidence lift
  if (confidenceLift !== null && confidenceLift > 0.3) {
    return `${prefix}${label} boost your confidence by ${confidenceLift.toFixed(1)} points.`;
  }

  // Negative task lift (only mention if meaningful and enough data)
  if (taskLift !== null && taskLift < -0.15 && sampleSize >= 3) {
    return `You might benefit from lighter ${label.toLowerCase()} — task completion dips slightly after them.`;
  }

  return null;
}
