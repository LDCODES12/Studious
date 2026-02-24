"use client";

import {
  format,
  addDays,
  startOfWeek,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isToday,
} from "date-fns";
import { cn } from "@/lib/utils";
import { ACCENT_DOT } from "./calendar-constants";
import type { Assignment, CalendarEvent } from "./calendar-types";

export function MonthView({
  monthStart,
  assignmentsForDay,
  eventsForDay,
  onDayClick,
}: {
  monthStart: Date;
  assignmentsForDay: (day: Date) => Assignment[];
  eventsForDay: (day: Date) => CalendarEvent[];
  onDayClick: (day: Date) => void;
}) {
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const calendarEnd = addDays(
    startOfWeek(addDays(endOfMonth(monthStart), 1), { weekStartsOn: 0 }),
    6
  );
  const allDays = eachDayOfInterval({ start: calendarStart, end: calendarEnd });
  const weeks: Date[][] = [];
  for (let i = 0; i < allDays.length; i += 7) weeks.push(allDays.slice(i, i + 7));

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid grid-cols-7 border-b border-border">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
          <div
            key={d}
            className={cn(
              "border-l border-border py-2.5 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
              i === 0 && "border-l-0"
            )}
          >
            {d}
          </div>
        ))}
      </div>

      {weeks.map((week, wi) => (
        <div
          key={wi}
          className="grid grid-cols-7 border-b border-border last:border-b-0"
        >
          {week.map((day, di) => {
            const inMonth = isSameMonth(day, monthStart);
            const dayAssignments = assignmentsForDay(day);
            const dayEvents = eventsForDay(day);
            const allItems = [
              ...dayAssignments.map((a) => ({
                type: "assignment" as const,
                item: a,
              })),
              ...dayEvents.map((e) => ({
                type: "event" as const,
                item: e,
              })),
            ];
            const MAX_VISIBLE = 2;
            const visible = allItems.slice(0, MAX_VISIBLE);
            const overflow = allItems.length - MAX_VISIBLE;

            return (
              <button
                key={day.toISOString()}
                onClick={() => onDayClick(day)}
                className={cn(
                  "group min-h-[110px] border-l border-border p-2 text-left transition-colors hover:bg-muted/30",
                  di === 0 && "border-l-0",
                  !inMonth && "bg-muted/10"
                )}
              >
                <div className="mb-1.5 flex items-start">
                  <span
                    className={cn(
                      "inline-flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-medium",
                      isToday(day)
                        ? "bg-blue-600 font-semibold text-white dark:bg-blue-500"
                        : inMonth
                          ? "text-foreground group-hover:bg-muted"
                          : "text-muted-foreground/40"
                    )}
                  >
                    {format(day, "d")}
                  </span>
                </div>

                <div className="space-y-0.5">
                  {visible.map((entry) => {
                    if (entry.type === "assignment") {
                      const a = entry.item as Assignment;
                      return (
                        <div
                          key={a.id}
                          className="flex items-center gap-1 truncate rounded px-1 py-px"
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 shrink-0 rounded-full",
                              ACCENT_DOT[a.course.color] ?? "bg-gray-400"
                            )}
                          />
                          <span className="truncate text-[11px] font-medium text-foreground">
                            {a.title}
                          </span>
                        </div>
                      );
                    }
                    const e = entry.item as CalendarEvent;
                    return (
                      <div
                        key={e.id}
                        className="flex items-center gap-1 truncate rounded px-1 py-px"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
                        <span className="truncate text-[11px] text-muted-foreground">
                          {e.summary}
                        </span>
                      </div>
                    );
                  })}
                  {overflow > 0 && (
                    <p className="px-1 text-[11px] font-medium text-muted-foreground">
                      +{overflow} more
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
