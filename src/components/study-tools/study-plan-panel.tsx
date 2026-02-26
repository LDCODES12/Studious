"use client";

import { useState, useCallback } from "react";
import { CalendarClock, Loader2, RotateCcw, ListChecks, Check } from "lucide-react";
import { cn } from "@/lib/utils";

type PlanMode = "day" | "week";

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

export function StudyPlanPanel() {
  const [plan, setPlan] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planTasks, setPlanTasks] = useState<PlanTask[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(false);

  const generatePlan = useCallback(async (mode: PlanMode) => {
    setPlan("");
    setError(null);
    setLoading(true);
    setPlanTasks([]);
    setExtracted(false);

    try {
      const res = await fetch("/api/study-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate plan");
      }

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setPlan(text);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, []);

  const extractTasks = useCallback(async () => {
    if (!plan || extracting) return;
    setExtracting(true);

    try {
      const res = await fetch("/api/study-plan/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planText: plan }),
      });

      if (!res.ok) throw new Error("Failed to extract tasks");

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
      // Revert on failure
      setPlanTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, completed: !newCompleted } : t))
      );
    }
  }, [planTasks]);

  const completedCount = planTasks.filter((t) => t.completed).length;

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

        {loading && !plan && (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Building your study plan...</span>
          </div>
        )}

        {error && (
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
          <>
            <div className="text-sm whitespace-pre-wrap">{plan}</div>

            {/* Inline task list */}
            {planTasks.length > 0 && (
              <div className="mt-4 rounded-lg border border-border bg-muted/30">
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
                    <div
                      key={task.id}
                      className="flex items-center gap-3 px-3 py-2.5"
                    >
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
          </>
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
          {!extracted && (
            <button
              onClick={extractTasks}
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
