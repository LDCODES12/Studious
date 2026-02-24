"use client";

import { format, parseISO } from "date-fns";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCENT_BAR, ACCENT_CHIP } from "./calendar-constants";
import type { Assignment } from "./calendar-types";

export function UpcomingList({
  assignments,
  onSelect,
}: {
  assignments: Assignment[];
  onSelect: (a: Assignment) => void;
}) {
  const upcoming = assignments
    .filter((a) => a.dueDate && a.dueDate >= format(new Date(), "yyyy-MM-dd"))
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
    .slice(0, 6);

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Clock className="h-3.5 w-3.5" />
        Upcoming
      </h3>
      {upcoming.length === 0 ? (
        <p className="py-2 text-center text-[12px] text-muted-foreground">
          No upcoming deadlines
        </p>
      ) : (
        <div className="space-y-0.5">
          {upcoming.map((a) => (
            <button
              key={a.id}
              onClick={() => onSelect(a)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60"
            >
              <div
                className={cn(
                  "h-8 w-[3px] shrink-0 rounded-full",
                  ACCENT_BAR[a.course.color] ?? "bg-gray-400"
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{a.title}</p>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span
                    className={cn(
                      "rounded px-1.5 py-px text-[10px] font-medium",
                      ACCENT_CHIP[a.course.color] ??
                        "bg-muted text-muted-foreground"
                    )}
                  >
                    {a.course.shortName ?? a.course.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {a.dueDate
                      ? format(parseISO(a.dueDate), "EEE, MMM d")
                      : ""}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
