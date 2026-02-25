"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useCalendarApp, ScheduleXCalendar } from "@schedule-x/react";
import {
  createViewDay,
  createViewWeek,
  createViewMonthGrid,
} from "@schedule-x/calendar";
import type { CalendarEvent as SxCalendarEvent } from "@schedule-x/calendar";
import { createEventsServicePlugin } from "@schedule-x/events-service";
import { createDragAndDropPlugin } from "@schedule-x/drag-and-drop";
import { createResizePlugin } from "@schedule-x/resize";
import { createScrollControllerPlugin } from "@schedule-x/scroll-controller";
import { createCurrentTimePlugin } from "@schedule-x/current-time";
import { format, startOfWeek, addDays, isSameDay } from "date-fns";
import { toast } from "sonner";
import "@schedule-x/theme-shadcn/dist/index.css";
import "temporal-polyfill/global";

import type {
  Assignment,
  CalendarEvent,
  CourseRef,
  ScheduleItem,
} from "./calendar-types";
import { ACCENT_BAR } from "./calendar-constants";
import { isMidnightDeadline } from "@/lib/academic-deadlines";

const COURSE_COLORS: Record<
  string,
  {
    lightColors: { main: string; container: string; onContainer: string };
    darkColors: { main: string; container: string; onContainer: string };
  }
> = {
  blue: {
    lightColors: { main: "#3b82f6", container: "#dbeafe", onContainer: "#1e3a5f" },
    darkColors: { main: "#93c5fd", container: "#1e3a5f", onContainer: "#dbeafe" },
  },
  green: {
    lightColors: { main: "#22c55e", container: "#dcfce7", onContainer: "#14532d" },
    darkColors: { main: "#86efac", container: "#14532d", onContainer: "#dcfce7" },
  },
  purple: {
    lightColors: { main: "#a855f7", container: "#f3e8ff", onContainer: "#3b0764" },
    darkColors: { main: "#d8b4fe", container: "#3b0764", onContainer: "#f3e8ff" },
  },
  orange: {
    lightColors: { main: "#f97316", container: "#ffedd5", onContainer: "#7c2d12" },
    darkColors: { main: "#fdba74", container: "#7c2d12", onContainer: "#ffedd5" },
  },
  rose: {
    lightColors: { main: "#f43f5e", container: "#ffe4e6", onContainer: "#881337" },
    darkColors: { main: "#fda4af", container: "#881337", onContainer: "#ffe4e6" },
  },
};

function matchEventToCourse(
  summary: string,
  courses: CourseRef[]
): string | null {
  const lower = summary.toLowerCase();
  for (const c of courses) {
    if (c.shortName && lower.includes(c.shortName.toLowerCase())) return c.color;
    const words = c.name.toLowerCase().split(/\s+/);
    if (words.length >= 2 && lower.includes(words.slice(0, 2).join(" ")))
      return c.color;
  }
  return null;
}

function buildCalendarMap(courses: CourseRef[]) {
  const seen = new Set<string>();
  const calendars: Record<
    string,
    (typeof COURSE_COLORS)[string] & { colorName: string }
  > = {};

  for (const c of courses) {
    const color = c.color in COURSE_COLORS ? c.color : "blue";
    if (seen.has(color)) continue;
    seen.add(color);
    calendars[color] = { colorName: color, ...COURSE_COLORS[color] };
  }

  if (!calendars.blue) {
    calendars.blue = { colorName: "blue", ...COURSE_COLORS.blue };
  }

  return calendars;
}

function hasExplicitDueTime(dueDate: string): boolean {
  return /T\d{2}:\d{2}/.test(dueDate);
}

function isLateNightDeadline(date: Date): boolean {
  if (!Number.isFinite(date.getTime())) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= 23 * 60; // 11:00 PM+
}

function toSxEvents(
  assignments: Assignment[],
  calendarEvents: CalendarEvent[],
  courses: CourseRef[]
): SxCalendarEvent[] {
  const events: SxCalendarEvent[] = [];

  for (const a of assignments) {
    if (!a.dueDate) continue;
    const color = a.course.color in COURSE_COLORS ? a.course.color : "blue";

    // Date-only deadlines (unknown time) are intentionally kept out of the
    // built-in all-day lane. They will be handled by dedicated deadline UI.
    if (!hasExplicitDueTime(a.dueDate)) {
      continue;
    }

    const due = new Date(a.dueDate);
    if (!Number.isFinite(due.getTime())) continue;

    const midnight = isMidnightDeadline(a.dueDate);
    const lateNight = !midnight && isLateNightDeadline(due);

    // Late-night/midnight deadlines are handled by the dedicated "Due Tonight"
    // row instead of the built-in all-day lane.
    if (midnight || lateNight) {
      continue;
    }

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Represent assignment deadlines as a short timed marker that *ends* at the
    // due moment. This avoids 11:59 PM deadlines spilling into the next day and
    // being rendered as multi-day/all-day bars.
    const start = new Date(due.getTime() - 15 * 60 * 1000);
    const startStr = format(start, "yyyy-MM-dd'T'HH:mm:ss");
    const endStr = format(due, "yyyy-MM-dd'T'HH:mm:ss");
    events.push({
      id: `assignment-${a.id}`,
      title: a.title,
      start: Temporal.ZonedDateTime.from(`${startStr}[${tz}]`),
      end: Temporal.ZonedDateTime.from(`${endStr}[${tz}]`),
      calendarId: color,
      _type: "assignment",
      _originalId: a.id,
      _course: a.course,
      _options: { disableDND: true, disableResize: true },
    });
  }

  for (const e of calendarEvents) {
    const isAllDay =
      e.start.length === 10 ||
      (!e.start.includes("T") && !e.end.includes("T"));
    const color = matchEventToCourse(e.summary, courses) ?? "blue";

    if (isAllDay) {
      events.push({
        id: `event-${e.id}`,
        title: e.summary,
        start: Temporal.PlainDate.from(e.start.slice(0, 10)),
        end: Temporal.PlainDate.from(e.end.slice(0, 10)),
        calendarId: color,
        _type: "calendar-event",
        _originalId: e.id,
      });
    } else {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const startDate = new Date(e.start);
      const endDate = new Date(e.end);
      const startStr = format(startDate, "yyyy-MM-dd'T'HH:mm:ss");
      const endStr = format(endDate, "yyyy-MM-dd'T'HH:mm:ss");

      events.push({
        id: `event-${e.id}`,
        title: e.summary,
        start: Temporal.ZonedDateTime.from(`${startStr}[${tz}]`),
        end: Temporal.ZonedDateTime.from(`${endStr}[${tz}]`),
        calendarId: color,
        _type: "calendar-event",
        _originalId: e.id,
      });
    }
  }

  return events;
}

/* ------------------------------------------------------------------ */
/*  Quick-create popover (click empty time slot → type title → save)  */
/* ------------------------------------------------------------------ */

interface QuickCreateState {
  dateTime: Temporal.ZonedDateTime;
  x: number;
  y: number;
}

function QuickCreatePopover({
  state,
  onClose,
  onSave,
}: {
  state: QuickCreateState;
  onClose: () => void;
  onSave: (title: string, start: string, end: string) => void;
}) {
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node))
        onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    const startMs = state.dateTime.epochMilliseconds;
    const endMs = state.dateTime.add({ hours: 1 }).epochMilliseconds;
    const startISO = new Date(startMs).toISOString();
    const endISO = new Date(endMs).toISOString();
    onSave(trimmed, startISO, endISO);
    onClose();
  };

  const timeLabel = new Date(state.dateTime.epochMilliseconds).toLocaleTimeString(
    [],
    { hour: "numeric", minute: "2-digit" }
  );
  const dateLabel = new Date(state.dateTime.epochMilliseconds).toLocaleDateString(
    [],
    { weekday: "short", month: "short", day: "numeric" }
  );

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 w-64 rounded-lg border border-border/60 bg-card p-3 shadow-lg backdrop-blur-sm"
      style={{
        left: Math.min(state.x, window.innerWidth - 280),
        top: Math.min(state.y, window.innerHeight - 180),
      }}
    >
      <form onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add title"
          className="w-full border-b border-border bg-transparent px-1 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-blue-500"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {dateLabel} · {timeLabel}
        </p>
        <div className="mt-2 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main calendar component                                           */
/* ------------------------------------------------------------------ */

interface SxCalendarProps {
  assignments: Assignment[];
  calendarEvents: CalendarEvent[];
  courses: CourseRef[];
  selectedDate: Date;
  dueTonightItems?: Array<{ assignment: Assignment; due: Date; midnight: boolean; planningDate: Date }>;
  onSelectEvent: (item: ScheduleItem) => void;
  onEventUpdate: (eventId: string, newStart: string, newEnd: string) => void;
  onEventCreate?: (title: string, startISO: string, endISO: string) => void;
  onDateChange?: (date: Date) => void;
}

export function SxCalendar({
  assignments,
  calendarEvents,
  courses,
  selectedDate,
  dueTonightItems = [],
  onSelectEvent,
  onEventUpdate,
  onEventCreate,
  onDateChange,
}: SxCalendarProps) {
  const [eventsService] = useState(() => createEventsServicePlugin());
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);

  const calendars = useMemo(() => buildCalendarMap(courses), [courses]);

  const handleEventClick = useCallback(
    (sxEvent: SxCalendarEvent) => {
      const type = sxEvent._type as string;
      const origId = sxEvent._originalId as string;

      if (type === "assignment") {
        const found = assignments.find((a) => a.id === origId);
        if (found) onSelectEvent(found);
      } else {
        const found = calendarEvents.find((e) => e.id === origId);
        if (found) onSelectEvent(found);
      }
    },
    [assignments, calendarEvents, onSelectEvent]
  );

  const handleEventUpdate = useCallback(
    (updatedEvent: SxCalendarEvent) => {
      if (updatedEvent._type !== "calendar-event") return;

      const origId = updatedEvent._originalId as string;
      const start = updatedEvent.start;
      const end = updatedEvent.end;

      let startISO: string;
      let endISO: string;

      if (start instanceof Temporal.ZonedDateTime) {
        startISO = new Date(start.epochMilliseconds).toISOString();
        endISO = new Date(
          (end as Temporal.ZonedDateTime).epochMilliseconds
        ).toISOString();
      } else {
        startISO = start.toString();
        endISO = (end as Temporal.PlainDate).toString();
      }

      const evt = calendarEvents.find((e) => e.id === origId);
      const label = evt?.summary ?? "Event";
      const timeLabel = new Date(startISO).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });

      toast(`${label} moved to ${timeLabel}`, { duration: 4000 });
      onEventUpdate(origId, startISO, endISO);
    },
    [calendarEvents, onEventUpdate]
  );

  const handleClickDateTime = useCallback(
    (dateTime: Temporal.ZonedDateTime, e?: UIEvent) => {
      const mouseEvt = e as MouseEvent | undefined;
      const minute = dateTime.minute;
      const snapped = Math.round(minute / 15) * 15;
      const adjusted = dateTime.with({ minute: snapped % 60, second: 0 });
      const final = snapped >= 60 ? adjusted.add({ hours: 1 }) : adjusted;

      setQuickCreate({
        dateTime: final,
        x: mouseEvt?.clientX ?? 400,
        y: mouseEvt?.clientY ?? 300,
      });
    },
    []
  );

  const handleQuickSave = useCallback(
    (title: string, startISO: string, endISO: string) => {
      if (onEventCreate) {
        onEventCreate(title, startISO, endISO);
      } else {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const startStr = format(new Date(startISO), "yyyy-MM-dd'T'HH:mm:ss");
        const endStr = format(new Date(endISO), "yyyy-MM-dd'T'HH:mm:ss");

        const tempId = `temp-${Date.now()}`;
        eventsService.add({
          id: tempId,
          title,
          start: Temporal.ZonedDateTime.from(`${startStr}[${tz}]`),
          end: Temporal.ZonedDateTime.from(`${endStr}[${tz}]`),
          calendarId: "blue",
          _type: "calendar-event",
          _originalId: tempId,
        });
        toast("Event created", { duration: 3000 });
      }
    },
    [onEventCreate, eventsService]
  );

  const sxSelectedDate = useMemo(
    () => Temporal.PlainDate.from(format(selectedDate, "yyyy-MM-dd")),
    [selectedDate]
  );

  const userTimezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );

  const calendar = useCalendarApp({
    views: [createViewWeek(), createViewDay(), createViewMonthGrid()],
    defaultView: "week",
    theme: "shadcn",
    selectedDate: sxSelectedDate,
    locale: "en-US",
    timezone: userTimezone,
    firstDayOfWeek: 7,
    weekOptions: {
      gridHeight: 1300,
      eventWidth: 95,
      gridStep: 60,
      timeAxisFormatOptions: { hour: "numeric" },
    },
    calendars,
    callbacks: {
      onEventClick: handleEventClick,
      onEventUpdate: handleEventUpdate,
      onClickDateTime: handleClickDateTime,
      onSelectedDateUpdate: (date: Temporal.PlainDate) => {
        onDateChange?.(new Date(date.toString() + "T12:00:00"));
      },
    },
    plugins: [
      eventsService,
      createDragAndDropPlugin(15),
      createResizePlugin(15),
      createScrollControllerPlugin({ initialScroll: "07:00" }),
      createCurrentTimePlugin({ fullWeekWidth: true }),
    ],
  });

  const sxEvents = useMemo(
    () => toSxEvents(assignments, calendarEvents, courses),
    [assignments, calendarEvents, courses]
  );

  useEffect(() => {
    eventsService.set(sxEvents);
  }, [eventsService, sxEvents]);

  /* ── Group due-tonight items into day columns matching the week view ── */
  const weekStart = useMemo(
    () => startOfWeek(selectedDate, { weekStartsOn: 0 }),
    [selectedDate]
  );
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );
  const dueTonightByDay = useMemo(
    () =>
      weekDays.map((day) =>
        dueTonightItems.filter((item) => isSameDay(item.planningDate, day))
      ),
    [weekDays, dueTonightItems]
  );
  const hasDueTonight = dueTonightByDay.some((items) => items.length > 0);

  return (
    <div className="sx-calendar-wrapper">
      <div className="sx-calendar-unified">
        <ScheduleXCalendar calendarApp={calendar} />
        {hasDueTonight && (
          <div className="due-tonight-row">
            <div className="due-tonight-gutter">
              <span>Due</span>
              <span>Tonight</span>
            </div>
            <div className="due-tonight-columns">
              {dueTonightByDay.map((items, dayIdx) => (
                <div key={dayIdx} className="due-tonight-day">
                  {items.map(({ assignment }) => (
                    <button
                      key={assignment.id}
                      type="button"
                      onClick={() => onSelectEvent(assignment)}
                      className="due-tonight-chip"
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          ACCENT_BAR[assignment.course.color] ?? "bg-gray-400"
                        }`}
                      />
                      <span className="due-tonight-chip-title">
                        {assignment.title}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {quickCreate && (
        <QuickCreatePopover
          state={quickCreate}
          onClose={() => setQuickCreate(null)}
          onSave={handleQuickSave}
        />
      )}
    </div>
  );
}
