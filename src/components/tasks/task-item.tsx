"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { CalendarPlus, CalendarCheck, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";

interface TaskCourse {
  id: string;
  name: string;
  shortName: string | null;
  color: string;
}

export interface TaskData {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  dueTime: string | null;
  priority: string;
  completed: boolean;
  source: string;
  sourceType: string | null;
  googleEventId: string | null;
  course: TaskCourse | null;
}

interface TaskItemProps {
  task: TaskData;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  onCalendarSync: (id: string) => void;
  googleConnected: boolean;
}

const priorityDot: Record<string, string> = {
  high: "bg-red-500",
  medium: "bg-yellow-500",
  low: "bg-gray-300",
};

export function TaskItem({ task, onToggle, onDelete, onCalendarSync, googleConnected }: TaskItemProps) {
  const [syncing, setSyncing] = useState(false);

  const handleCalendarSync = async () => {
    setSyncing(true);
    try {
      await onCalendarSync(task.id);
    } finally {
      setSyncing(false);
    }
  };

  const colors = task.course ? courseColors[task.course.color] : null;

  return (
    <div
      className={cn(
        "group flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-accent/30",
        task.completed && "opacity-50"
      )}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={task.completed}
        onChange={() => onToggle(task.id, !task.completed)}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-border accent-foreground"
      />

      {/* Course color dot */}
      {colors && (
        <span className={cn("h-2 w-2 shrink-0 rounded-full", colors.dot)} />
      )}

      {/* Title + course name */}
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "text-[13px]",
            task.completed && "line-through text-muted-foreground"
          )}
        >
          {task.title}
        </span>
        {task.course && (
          <span className="ml-1.5 text-[11px] text-muted-foreground">
            {task.course.shortName ?? task.course.name}
          </span>
        )}
      </div>

      {/* Auto badge */}
      {task.source === "auto" && (
        <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          auto
        </span>
      )}

      {/* Priority dot */}
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", priorityDot[task.priority] ?? "bg-gray-300")}
        title={task.priority}
      />

      {/* Due date */}
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
        {task.dueDate ? format(parseISO(task.dueDate), "MMM d") : "No date"}
      </span>

      {/* Calendar sync */}
      {googleConnected && task.dueDate && (
        <button
          onClick={handleCalendarSync}
          disabled={!!task.googleEventId || syncing}
          className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
          title={task.googleEventId ? "Added to calendar" : "Add to Google Calendar"}
        >
          {task.googleEventId ? (
            <CalendarCheck className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <CalendarPlus className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      {/* Delete */}
      <button
        onClick={() => onDelete(task.id)}
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
        title="Delete task"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
