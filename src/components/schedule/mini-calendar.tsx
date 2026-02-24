"use client";

import { useState, useMemo } from "react";
import {
  format,
  addDays,
  addMonths,
  subMonths,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  isToday,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Assignment, CalendarEvent } from "./calendar-types";

export function MiniCalendar({
  currentDate,
  assignments,
  calendarEvents,
  onSelectDate,
}: {
  currentDate: Date;
  assignments: Assignment[];
  calendarEvents: CalendarEvent[];
  onSelectDate: (d: Date) => void;
}) {
  const derivedMonth = useMemo(() => startOfMonth(currentDate), [currentDate]);
  const [miniMonthOverride, setMiniMonthOverride] = useState<Date | null>(null);
  const miniMonth =
    miniMonthOverride &&
    format(miniMonthOverride, "yyyy-MM") !== format(derivedMonth, "yyyy-MM")
      ? miniMonthOverride
      : derivedMonth;

  const calStart = startOfWeek(miniMonth, { weekStartsOn: 0 });
  const calEnd = addDays(
    startOfWeek(addDays(endOfMonth(miniMonth), 1), { weekStartsOn: 0 }),
    6
  );
  const allDays = eachDayOfInterval({ start: calStart, end: calEnd });

  const daysWithEvents = useMemo(() => {
    const set = new Set<string>();
    for (const a of assignments) {
      if (a.dueDate) set.add(a.dueDate);
    }
    for (const e of calendarEvents) {
      set.add(e.start.slice(0, 10));
    }
    return set;
  }, [assignments, calendarEvents]);

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">
          {format(miniMonth, "MMMM yyyy")}
        </h3>
        <div className="flex gap-0.5">
          <button
            onClick={() => setMiniMonthOverride(subMonths(miniMonth, 1))}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setMiniMonthOverride(addMonths(miniMonth, 1))}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div
            key={i}
            className="py-1 text-center text-[11px] font-medium text-muted-foreground"
          >
            {d}
          </div>
        ))}
        {allDays.map((day) => {
          const inMonth = isSameMonth(day, miniMonth);
          const selected = isSameDay(day, currentDate);
          const hasEvents = daysWithEvents.has(format(day, "yyyy-MM-dd"));

          return (
            <button
              key={day.toISOString()}
              onClick={() => onSelectDate(day)}
              className="group relative mx-auto flex h-7 w-7 items-center justify-center"
            >
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full text-[11px] transition-colors",
                  !inMonth && "text-muted-foreground/30",
                  inMonth &&
                    !selected &&
                    !isToday(day) &&
                    "text-foreground group-hover:bg-muted",
                  isToday(day) &&
                    !selected &&
                    "bg-blue-600 font-semibold text-white dark:bg-blue-500",
                  selected &&
                    !isToday(day) &&
                    "bg-foreground font-semibold text-background",
                  selected &&
                    isToday(day) &&
                    "bg-blue-600 font-semibold text-white ring-2 ring-blue-600/30 dark:bg-blue-500 dark:ring-blue-500/30"
                )}
              >
                {format(day, "d")}
              </span>
              {hasEvents && !selected && inMonth && (
                <span className="absolute bottom-0 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-blue-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
