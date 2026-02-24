"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
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
import { format } from "date-fns";
import { toast } from "sonner";
import "@schedule-x/theme-shadcn/dist/index.css";
import "temporal-polyfill/global";

import type {
  Assignment,
  CalendarEvent,
  CourseRef,
  ScheduleItem,
} from "./calendar-types";

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

function toSxEvents(
  assignments: Assignment[],
  calendarEvents: CalendarEvent[],
  courses: CourseRef[]
): SxCalendarEvent[] {
  const events: SxCalendarEvent[] = [];

  for (const a of assignments) {
    if (!a.dueDate) continue;
    events.push({
      id: `assignment-${a.id}`,
      title: a.title,
      start: Temporal.PlainDate.from(a.dueDate),
      end: Temporal.PlainDate.from(a.dueDate),
      calendarId: a.course.color in COURSE_COLORS ? a.course.color : "blue",
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

interface SxCalendarProps {
  assignments: Assignment[];
  calendarEvents: CalendarEvent[];
  courses: CourseRef[];
  selectedDate: Date;
  onSelectEvent: (item: ScheduleItem) => void;
  onEventUpdate: (eventId: string, newStart: string, newEnd: string) => void;
  onDateChange?: (date: Date) => void;
}

export function SxCalendar({
  assignments,
  calendarEvents,
  courses,
  selectedDate,
  onSelectEvent,
  onEventUpdate,
  onDateChange,
}: SxCalendarProps) {
  const [eventsService] = useState(() => createEventsServicePlugin());

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

  const sxSelectedDate = useMemo(
    () => Temporal.PlainDate.from(format(selectedDate, "yyyy-MM-dd")),
    [selectedDate]
  );

  const calendar = useCalendarApp({
    views: [createViewWeek(), createViewDay(), createViewMonthGrid()],
    defaultView: "week",
    theme: "shadcn",
    selectedDate: sxSelectedDate,
    locale: "en-US",
    firstDayOfWeek: 7,
    weekOptions: {
      gridHeight: 2400,
      eventWidth: 95,
      gridStep: 30,
      timeAxisFormatOptions: { hour: "numeric" },
    },
    calendars,
    callbacks: {
      onEventClick: handleEventClick,
      onEventUpdate: handleEventUpdate,
      onSelectedDateUpdate: (date: Temporal.PlainDate) => {
        onDateChange?.(new Date(date.toString() + "T12:00:00"));
      },
    },
    plugins: [eventsService, createDragAndDropPlugin(15), createResizePlugin(15)],
  });

  const sxEvents = useMemo(
    () => toSxEvents(assignments, calendarEvents, courses),
    [assignments, calendarEvents, courses]
  );

  useEffect(() => {
    eventsService.set(sxEvents);
  }, [eventsService, sxEvents]);

  return (
    <div className="sx-calendar-wrapper">
      <ScheduleXCalendar calendarApp={calendar} />
    </div>
  );
}
