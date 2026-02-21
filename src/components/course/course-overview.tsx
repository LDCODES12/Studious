"use client";

import { useState } from "react";
import { format, parseISO, differenceInHours, differenceInDays } from "date-fns";
import { AlertTriangle, CheckCircle2, Check } from "lucide-react";
import { cn } from "@/lib/utils";

const TYPE_PILL: Record<string, { label: string; className: string }> = {
  exam:       { label: "Exam",       className: "bg-red-50 text-red-700" },
  quiz:       { label: "Quiz",       className: "bg-amber-50 text-amber-700" },
  project:    { label: "Project",    className: "bg-purple-50 text-purple-700" },
  lab:        { label: "Lab",        className: "bg-green-50 text-green-700" },
  reading:    { label: "Reading",    className: "bg-gray-100 text-gray-500" },
  assignment: { label: "Assignment", className: "bg-blue-50 text-blue-600" },
};

interface OverviewAssignment {
  id: string;
  title: string;
  type: string;
  dueDate: string | null;
  status: string;
  missing: boolean;
  pointsPossible: number | null;
  canvasUrl: string | null;
}

interface OverviewAnnouncement {
  id: string;
  title: string;
  body: string;
  postedAt: string;
}

interface OverviewTask {
  id: string;
  title: string;
  dueDate: string | null;
  priority: string;
  source: string;
}

interface CourseOverviewProps {
  assignments: OverviewAssignment[];
  announcements: OverviewAnnouncement[];
  currentGrade: string | null;
  currentScore: number | null;
  applyGroupWeights: boolean;
  courseTasks: OverviewTask[];
  courseId: string;
}

function timeUntil(dueDate: string): string {
  const now = new Date();
  const due = parseISO(dueDate);
  const hours = differenceInHours(due, now);
  const days = differenceInDays(due, now);
  if (hours < 0) return "Overdue";
  if (hours < 24) return `${hours}h left`;
  return `${days}d left`;
}

export function CourseOverview({
  assignments,
  announcements,
  currentGrade,
  currentScore,
  applyGroupWeights,
  courseTasks,
  courseId,
}: CourseOverviewProps) {
  const [tasks, setTasks] = useState(courseTasks);

  const now = new Date();

  // Urgent: missing OR (due within 48h AND not submitted/graded)
  const urgent = assignments.filter((a) => {
    if (a.status === "submitted" || a.status === "graded") return false;
    if (a.missing) return true;
    if (a.dueDate) {
      const hoursLeft = differenceInHours(parseISO(a.dueDate), now);
      return hoursLeft >= 0 && hoursLeft <= 48;
    }
    return false;
  });

  // Up Next: upcoming not-submitted/graded, sorted by dueDate, top 3
  const upNext = assignments
    .filter((a) => {
      if (a.status === "submitted" || a.status === "graded" || a.missing) return false;
      if (!a.dueDate) return false;
      return differenceInHours(parseISO(a.dueDate), now) > 48;
    })
    .sort((a, b) => {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    })
    .slice(0, 3);

  const handleToggleTask = async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      });
    } catch {
      // optimistic — don't revert, will refresh on next page load
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Urgent ── */}
      {urgent.length > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <span className="text-[13px] font-semibold text-red-700">
              Needs Attention ({urgent.length})
            </span>
          </div>
          <div className="space-y-1.5">
            {urgent.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[13px] text-red-800">
                  {a.canvasUrl ? (
                    <a href={a.canvasUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {a.title}
                    </a>
                  ) : a.title}
                </span>
                <span className="shrink-0 text-[11px] font-medium text-red-600">
                  {a.missing ? "Missing" : a.dueDate ? timeUntil(a.dueDate) : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <span className="text-[13px] text-green-700">All caught up — nothing urgent.</span>
        </div>
      )}

      {/* ── Grade ── */}
      {(currentGrade || currentScore != null) && (
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Current Grade
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            {currentGrade && (
              <span className="text-2xl font-semibold">{currentGrade}</span>
            )}
            {currentScore != null && (
              <span className="text-[15px] tabular-nums text-muted-foreground">
                {currentScore.toFixed(1)}%
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {applyGroupWeights ? "Weighted grading" : "Points-based grading"}
          </p>
        </div>
      )}

      {/* ── Up Next ── */}
      {upNext.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Up Next
          </p>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {upNext.map((a, i) => {
              const pill = TYPE_PILL[a.type] ?? TYPE_PILL.assignment;
              const highStake = (a.pointsPossible ?? 0) >= 100;
              return (
                <div
                  key={a.id}
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5",
                    i < upNext.length - 1 && "border-b border-border"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className={cn("truncate text-[13px]", highStake && "font-medium")}>
                      {a.canvasUrl ? (
                        <a href={a.canvasUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {a.title}
                        </a>
                      ) : a.title}
                    </p>
                    {a.pointsPossible != null && (
                      <p className="text-[11px] text-muted-foreground">{a.pointsPossible} pts</p>
                    )}
                  </div>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", pill.className)}>
                    {pill.label}
                  </span>
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {a.dueDate ? format(parseISO(a.dueDate), "MMM d") : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Announcements ── */}
      {announcements.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Announcements
          </p>
          <div className="space-y-2">
            {announcements.slice(0, 3).map((ann) => (
              <div key={ann.id} className="rounded-lg border border-border bg-card px-3 py-2.5">
                <p className="text-[13px] font-medium leading-snug">{ann.title}</p>
                {ann.body && (
                  <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">{ann.body}</p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground/60">
                  {format(parseISO(ann.postedAt), "MMM d, yyyy")}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Tasks ── */}
      {tasks.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Tasks
          </p>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {tasks.map((task, i) => (
              <div
                key={task.id}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5",
                  i < tasks.length - 1 && "border-b border-border"
                )}
              >
                <button
                  onClick={() => handleToggleTask(task.id)}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border hover:border-foreground/40 transition-colors"
                >
                  <Check className="h-2.5 w-2.5 opacity-0 hover:opacity-50" />
                </button>
                <span className="min-w-0 flex-1 truncate text-[13px]">{task.title}</span>
                {task.source === "auto" && (
                  <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    auto
                  </span>
                )}
                {task.dueDate && (
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {format(parseISO(task.dueDate), "MMM d")}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
