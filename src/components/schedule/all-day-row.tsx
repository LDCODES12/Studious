"use client";

import { cn } from "@/lib/utils";
import {
  GUTTER_WIDTH,
  ACCENT_DOT,
  ACCENT_EVENT_BG,
  ACCENT_EVENT_TEXT,
} from "./calendar-constants";
import { isAllDayEvent } from "./calendar-utils";
import type { Assignment, CalendarEvent, ScheduleItem } from "./calendar-types";

export function AllDayRow({
  days,
  assignmentsForDay,
  eventsForDay,
  onSelectEvent,
}: {
  days: Date[];
  assignmentsForDay: (day: Date) => Assignment[];
  eventsForDay: (day: Date) => CalendarEvent[];
  onSelectEvent: (e: ScheduleItem) => void;
}) {
  return (
    <div className="flex shrink-0 border-b border-border">
      <div
        className="flex shrink-0 items-start justify-end pr-2 pt-1.5"
        style={{ width: GUTTER_WIDTH }}
      >
        <span className="text-[11px] text-muted-foreground">All day</span>
      </div>
      {days.map((day, i) => {
        const allDayGcal = eventsForDay(day).filter((e) =>
          isAllDayEvent(e.start, e.end)
        );
        const dayAssignments = assignmentsForDay(day);
        return (
          <div
            key={day.toISOString()}
            className={cn(
              "flex min-h-[32px] flex-1 flex-col gap-0.5 border-l border-border px-1 py-1",
              i === 0 && "border-l-0"
            )}
          >
            {dayAssignments.map((a) => (
              <button
                key={a.id}
                onClick={() => onSelectEvent(a)}
                className={cn(
                  "flex items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium transition-colors",
                  ACCENT_EVENT_BG[a.course.color] ??
                    "bg-muted hover:bg-muted/80",
                  ACCENT_EVENT_TEXT[a.course.color] ?? "text-foreground"
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    ACCENT_DOT[a.course.color] ?? "bg-gray-400"
                  )}
                />
                <span className="truncate">{a.title}</span>
              </button>
            ))}
            {allDayGcal.map((e) => (
              <button
                key={e.id}
                onClick={() => onSelectEvent(e)}
                className="flex items-center gap-1 truncate rounded-md bg-blue-500/10 px-1.5 py-0.5 text-left text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-500/15 dark:bg-blue-400/15 dark:text-blue-300 dark:hover:bg-blue-400/20"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
                <span className="truncate">{e.summary}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
