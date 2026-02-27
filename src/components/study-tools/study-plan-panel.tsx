"use client";

import { useState, useCallback } from "react";
import {
  CalendarClock,
  Loader2,
  RotateCcw,
  ListChecks,
  Check,
  Clock,
  Coffee,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StudyPlanResult, StudySession } from "@/lib/study-plan-engine";

interface PlanTask {
  id: string;
  title: string;
  courseId: string | null;
  dueDate: string | null;
  priority: string;
  completed: boolean;
  source: string;
  course: { shortName: string | null; color: string } | null;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function groupByDay(sessions: StudySession[]): Map<string, StudySession[]> {
  const groups = new Map<string, StudySession[]>();
  for (const s of sessions) {
    const day = new Date(s.start).toDateString();
    const arr = groups.get(day) ?? [];
    arr.push(s);
    groups.set(day, arr);
  }
  return groups;
}

export function StudyPlanPanel() {
  const [plan, setPlan] = useState<StudyPlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planTasks, setPlanTasks] = useState<PlanTask[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(false);

  const generatePlan = useCallback(async (mode: "day" | "week") => {
    setPlan(null);
    setError(null);
    setLoading(true);
    setPlanTasks([]);
    setExtracted(false);

    try {
      const res = await fetch("/api/study-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, tzOffset: new Date().getTimezoneOffset() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate plan");
      }

      const data: StudyPlanResult = await res.json();
      setPlan(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, []);

  const addToTasks = useCallback(async () => {
    if (!plan || extracting) return;
    setExtracting(true);

    try {
      const res = await fetch("/api/study-plan/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessions: plan.schedule }),
      });

      if (!res.ok) throw new Error("Failed to create tasks");

      const data = await res.json();
      setPlanTasks(data.tasks ?? []);
      setExtracted(true);
    } catch {
      setError("Couldn't create tasks. Try again.");
    } finally {
      setExtracting(false);
    }
  }, [plan, extracting]);

  const toggleTask = useCallback(async (taskId: string) => {
    const task = planTasks.find((t) => t.id === taskId);
    if (!task) return;

    const newCompleted = !task.completed;
    setPlanTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, completed: newCompleted } : t))
    );

    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: newCompleted }),
      });
    } catch {
      setPlanTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, completed: !newCompleted } : t))
      );
    }
  }, [planTasks]);

  const completedCount = planTasks.filter((t) => t.completed).length;
  const studySessions = plan?.schedule.filter((s) => s.type === "study") ?? [];

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card" style={{ height: "60vh", minHeight: "400px" }}>
      {/* Plan content */}
      <div className="flex-1 overflow-y-auto p-4">
        {!plan && !loading && !error && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <CalendarClock className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground max-w-xs">
              Generate a study plan based on your deadlines, class schedule, and calendar.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => generatePlan("day")}
                className="rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
              >
                Plan my day
              </button>
              <button
                onClick={() => generatePlan("week")}
                className="rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
              >
                Plan my week
              </button>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Building your study plan...</span>
          </div>
        )}

        {error && !plan && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <button
              onClick={() => generatePlan("day")}
              className="rounded-lg border border-border bg-muted px-4 py-2 text-sm hover:bg-accent transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {plan && (
          <div className="space-y-5">
            {/* Summary header */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{plan.date}</p>
                <p className="text-xs text-muted-foreground">
                  {plan.summary.sessionCount} session{plan.summary.sessionCount !== 1 ? "s" : ""} &middot; {plan.summary.studyHours}h study time
                </p>
              </div>
            </div>

            {/* Schedule blocks grouped by day */}
            {Array.from(groupByDay(plan.schedule)).map(([dayKey, sessions]) => (
              <div key={dayKey} className="space-y-2">
                {plan.mode === "week" && (
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {formatDayHeader(sessions[0].start)}
                  </p>
                )}
                {sessions.map((block, i) => (
                  <ScheduleBlockCard key={`${dayKey}-${i}`} block={block} />
                ))}
              </div>
            ))}

            {plan.schedule.length === 0 && (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">No sessions to schedule right now.</p>
                <p className="text-xs text-muted-foreground mt-1">
                  It might be too late in the day, or there are no upcoming items to work on.
                </p>
              </div>
            )}

            {/* Priority summary */}
            {(plan.summary.topPriority || plan.summary.canSlip) && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Priorities</p>
                {plan.summary.topPriority && (
                  <p className="text-sm">Top priority: {plan.summary.topPriority}</p>
                )}
                {plan.summary.canSlip && (
                  <p className="text-xs text-muted-foreground">{plan.summary.canSlip}</p>
                )}
              </div>
            )}

            {/* Task list */}
            {planTasks.length > 0 && (
              <div className="rounded-lg border border-border bg-muted/30">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
                    Plan Tasks
                  </span>
                  <span className="text-[12px] tabular-nums text-muted-foreground">
                    {completedCount}/{planTasks.length} done
                  </span>
                </div>
                <div className="divide-y divide-border">
                  {planTasks.map((task) => (
                    <div key={task.id} className="flex items-center gap-3 px-3 py-2.5">
                      <button
                        onClick={() => toggleTask(task.id)}
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                          task.completed
                            ? "border-green-500 bg-green-500 text-white"
                            : "border-border hover:border-foreground/40"
                        )}
                      >
                        {task.completed && <Check className="h-2.5 w-2.5" />}
                      </button>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-[13px]",
                          task.completed && "text-muted-foreground line-through"
                        )}
                      >
                        {task.title}
                      </span>
                      {task.course?.shortName && (
                        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {task.course.shortName}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      {plan && !loading && (
        <div className="border-t border-border p-3 flex gap-2">
          <button
            onClick={() => generatePlan("day")}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            Replan my day
          </button>
          <button
            onClick={() => generatePlan("week")}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            Replan my week
          </button>
          {!extracted && studySessions.length > 0 && (
            <button
              onClick={addToTasks}
              disabled={extracting}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-border bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:bg-foreground/90 transition-colors disabled:opacity-50"
            >
              {extracting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ListChecks className="h-3 w-3" />
              )}
              {extracting ? "Creating..." : "Add to my tasks"}
            </button>
          )}
          {extracted && planTasks.length > 0 && (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="h-3 w-3 text-green-500" />
              {planTasks.length} tasks added
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ScheduleBlockCard({ block }: { block: StudySession }) {
  if (block.type === "break") {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
        <Coffee className="h-3 w-3" />
        <span>{formatTime(block.start)} – {formatTime(block.end)}</span>
        <span>Break</span>
      </div>
    );
  }

  if (block.type === "class") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
        <div className="flex flex-col items-end shrink-0 w-[90px]">
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatTime(block.start)}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {formatTime(block.end)}
          </span>
        </div>
        <div className="h-8 w-0.5 rounded-full bg-muted-foreground/30" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">{block.label}</p>
        </div>
      </div>
    );
  }

  if (block.type === "calendar") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
        <div className="flex flex-col items-end shrink-0 w-[90px]">
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatTime(block.start)}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {formatTime(block.end)}
          </span>
        </div>
        <div className="h-8 w-0.5 rounded-full bg-muted-foreground/30" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">{block.label}</p>
        </div>
      </div>
    );
  }

  // Study session
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-3">
      <div className="flex flex-col items-end shrink-0 w-[90px] pt-0.5">
        <span className="text-xs tabular-nums font-medium">
          {formatTime(block.start)}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {formatTime(block.end)}
        </span>
      </div>
      <div
        className="h-10 w-0.5 rounded-full shrink-0 mt-0.5"
        style={{ backgroundColor: block.courseColor ?? "hsl(var(--muted-foreground))" }}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {block.courseName}
          </span>
          {block.item?.status === "due_today" && (
            <span className="rounded-full bg-orange-500/10 px-1.5 py-0.5 text-[9px] font-medium text-orange-600 dark:text-orange-400">
              DUE TODAY
            </span>
          )}
        </div>
        <p className="text-sm font-medium leading-snug">{block.label}</p>
        {block.approach && (
          <p className="text-xs text-muted-foreground flex items-start gap-1">
            <BookOpen className="h-3 w-3 mt-0.5 shrink-0" />
            {block.approach}
          </p>
        )}
        {block.rationale && (
          <p className="text-xs text-muted-foreground flex items-start gap-1">
            <Clock className="h-3 w-3 mt-0.5 shrink-0" />
            {block.rationale}
          </p>
        )}
      </div>
    </div>
  );
}
