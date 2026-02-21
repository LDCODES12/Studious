"use client";

import { useState } from "react";
import Link from "next/link";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";

interface TaskItem {
  id: string;
  title: string;
  dueDate: string | null;
  completed: boolean;
  priority: string;
  source: string;
  course: { shortName: string | null; color: string } | null;
}

const priorityDot: Record<string, string> = {
  high: "bg-red-500",
  medium: "bg-yellow-500",
  low: "bg-gray-300",
};

export function TodayTasks({ initialTasks }: { initialTasks: TaskItem[] }) {
  const [tasks, setTasks] = useState(initialTasks);

  const handleToggle = async (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;

    const newCompleted = !task.completed;
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, completed: newCompleted } : t))
    );

    try {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: newCompleted }),
      });
    } catch {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, completed: !newCompleted } : t))
      );
    }
  };

  const pending = tasks.filter((t) => !t.completed);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Tasks</h2>
        <Link
          href="/tasks"
          className="text-[12px] text-muted-foreground hover:text-foreground"
        >
          View all
        </Link>
      </div>

      {pending.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
          <p className="text-[13px] text-muted-foreground">
            No tasks coming up. Looking good!
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {pending.map((task, i) => {
            const colors = task.course ? courseColors[task.course.color ?? "blue"] : null;
            return (
              <div
                key={task.id}
                className={cn(
                  "flex items-center gap-2.5 px-4 py-2.5",
                  i < pending.length - 1 && "border-b border-border"
                )}
              >
                <input
                  type="checkbox"
                  checked={task.completed}
                  onChange={() => handleToggle(task.id)}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-border accent-foreground"
                />
                {colors && (
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", colors.dot)} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">{task.title}</p>
                  {task.course && (
                    <p className="text-[11px] text-muted-foreground">
                      {task.course.shortName ?? ""}
                    </p>
                  )}
                </div>
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    priorityDot[task.priority] ?? "bg-gray-300"
                  )}
                />
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {task.dueDate ? format(parseISO(task.dueDate), "MMM d") : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
