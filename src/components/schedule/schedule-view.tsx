"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { format, addDays, startOfWeek, startOfMonth, endOfMonth } from "date-fns";
import { CalendarPlus } from "lucide-react";
import { toast } from "sonner";
import { SxCalendar } from "./sx-calendar";
import { EventDetailPanel } from "./event-detail-panel";
import type {
  Assignment,
  CalendarEvent,
  CourseRef,
  ScheduleItem,
} from "./calendar-types";

export function ScheduleView() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<ScheduleItem | null>(null);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      new URL(window.location.href).searchParams.get("google") === "connected"
    ) {
      window.history.replaceState({}, "", "/schedule");
    }
  }, []);

  const monthStart = useMemo(() => startOfMonth(currentDate), [currentDate]);

  const fetchRange = useMemo(() => {
    const ms = startOfWeek(monthStart, { weekStartsOn: 0 });
    const me = addDays(
      startOfWeek(addDays(endOfMonth(monthStart), 1), { weekStartsOn: 0 }),
      6
    );
    return { start: format(ms, "yyyy-MM-dd"), end: format(me, "yyyy-MM-dd") };
  }, [monthStart]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/schedule?start=${fetchRange.start}&end=${fetchRange.end}`)
      .then((r) => r.json())
      .then((data) => {
        setAssignments(data.assignments ?? []);
        setCalendarEvents(data.calendarEvents ?? []);
        setGoogleConnected(data.googleConnected ?? false);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [fetchRange]);

  const courses: CourseRef[] = useMemo(() => {
    const map = new Map<string, CourseRef>();
    for (const a of assignments) {
      if (!map.has(a.course.id)) map.set(a.course.id, a.course);
    }
    return Array.from(map.values());
  }, [assignments]);

  const handleEventUpdate = useCallback(
    async (eventId: string, newStart: string, newEnd: string) => {
      const prev = calendarEvents;
      setCalendarEvents((evts) =>
        evts.map((e) =>
          e.id === eventId ? { ...e, start: newStart, end: newEnd } : e
        )
      );

      try {
        const res = await fetch(`/api/calendar/events/${eventId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start: newStart, end: newEnd }),
        });
        if (!res.ok) throw new Error();
      } catch {
        setCalendarEvents(prev);
        toast.error("Failed to save — change reverted");
      }
    },
    [calendarEvents]
  );

  const handleDateChange = useCallback((date: Date) => {
    setCurrentDate(date);
  }, []);

  const handleEventCreate = useCallback(
    async (title: string, startISO: string, endISO: string) => {
      const tempEvent: CalendarEvent = {
        id: `local-${Date.now()}`,
        summary: title,
        start: startISO,
        end: endISO,
      };
      setCalendarEvents((prev) => [...prev, tempEvent]);
      toast("Event created", { duration: 3000 });

      if (googleConnected) {
        try {
          const res = await fetch("/api/calendar/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ summary: title, start: startISO, end: endISO }),
          });
          if (res.ok) {
            const data = await res.json();
            setCalendarEvents((prev) =>
              prev.map((e) =>
                e.id === tempEvent.id
                  ? { ...e, id: data.eventId ?? e.id }
                  : e
              )
            );
          }
        } catch {
          /* local event persists even if API fails */
        }
      }
    },
    [googleConnected]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {!googleConnected && !loading && (
        /* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route */
        <a
          href="/api/auth/google?returnTo=%2Fschedule"
          className="mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-[11px] transition-colors hover:bg-muted/40"
        >
          <CalendarPlus className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">Connect Google Calendar</span>
          <span className="text-muted-foreground">to see events alongside assignments</span>
        </a>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : (
          <SxCalendar
            assignments={assignments}
            calendarEvents={calendarEvents}
            courses={courses}
            selectedDate={currentDate}
          onSelectEvent={setSelectedEvent}
          onEventUpdate={handleEventUpdate}
          onEventCreate={handleEventCreate}
          onDateChange={handleDateChange}
        />
      )}

      {selectedEvent && (
        <EventDetailPanel
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex shrink-0 border-b border-border">
        <div className="w-[52px] shrink-0" />
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex-1 border-l border-border px-1.5 py-2">
            <div className="mx-auto h-2.5 w-5 animate-pulse rounded bg-muted" />
            <div className="mx-auto mt-1 h-4 w-4 animate-pulse rounded-full bg-muted" />
          </div>
        ))}
      </div>
      <div className="flex-1 p-3">
        <div className="space-y-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-2">
              <div className="h-2.5 w-8 animate-pulse rounded bg-muted" />
              <div className="h-px flex-1 bg-border/50" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
