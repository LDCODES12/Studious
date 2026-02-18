"use client";

import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

interface Assignment {
  id: string;
  title: string;
  dueDate: string;
  status: string;
  type: string;
}

const statusDot: Record<string, string> = {
  not_started: "bg-gray-300",
  in_progress: "bg-blue-500",
  submitted: "bg-green-500",
  graded: "bg-green-500",
};

export function CourseTabs({ assignments }: { assignments: Assignment[] }) {
  const sorted = [...assignments].sort(
    (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
        <p className="text-[13px] text-muted-foreground">No assignments yet.</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-3 text-[14px] font-semibold">Assignments</h2>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {sorted.map((a, i) => (
          <div
            key={a.id}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 hover:bg-accent/30",
              i < sorted.length - 1 ? "border-b border-border" : ""
            )}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[a.status] ?? "bg-gray-300"}`}
            />
            <span className="min-w-0 flex-1 truncate text-[13px]">{a.title}</span>
            <span className="shrink-0 text-[12px] capitalize text-muted-foreground">
              {a.type.replace("_", " ")}
            </span>
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
              {format(parseISO(a.dueDate), "MMM d")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
