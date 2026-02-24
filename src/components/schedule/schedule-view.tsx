"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { format, addDays, startOfWeek, startOfMonth, endOfMonth } from "date-fns";
import { CalendarPlus } from "lucide-react";
import { toast } from "sonner";
import { SxCalendar } from "./sx-calendar";
import { MiniCalendar } from "./mini-calendar";
import { UpcomingList } from "./upcoming-list";
import { SuggestionsPanel } from "./suggestions-panel";
import { EventDetailPanel } from "./event-detail-panel";
import type {
  Assignment,
  CalendarEvent,
  CourseRef,
  Suggestion,
  ScheduleItem,
} from "./calendar-types";

export function ScheduleView() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
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
    setSuggestions([]);
    fetch(`/api/schedule?start=${fetchRange.start}&end=${fetchRange.end}`)
      .then((r) => r.json())
      .then(async (data) => {
        const a = data.assignments ?? [];
        const e = data.calendarEvents ?? [];
        setAssignments(a);
        setCalendarEvents(e);
        setGoogleConnected(data.googleConnected ?? false);
        setLoading(false);

        if (a.length > 0) {
          setSuggestionsLoading(true);
          try {
            const res = await fetch("/api/schedule/suggestions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ assignments: a, calendarEvents: e }),
            });
            const sData = await res.json();
            setSuggestions(sData.suggestions ?? []);
          } catch {
            /* non-fatal */
          } finally {
            setSuggestionsLoading(false);
          }
        }
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

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!googleConnected && !loading && (
          /* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route */
          <a
            href="/api/auth/google?returnTo=%2Fschedule"
            className="mb-3 flex items-center gap-3 rounded-xl border border-dashed border-border/80 px-4 py-3 transition-colors hover:bg-muted/40 lg:hidden"
          >
            <CalendarPlus className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-[13px] font-medium">Connect Google Calendar</p>
              <p className="text-[12px] text-muted-foreground">
                See your events alongside assignments
              </p>
            </div>
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
            onDateChange={handleDateChange}
          />
        )}
      </div>

      {/* Sidebar */}
      <aside className="hidden w-[272px] shrink-0 space-y-5 overflow-y-auto lg:block">
        {!googleConnected && !loading && (
          /* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route */
          <a
            href="/api/auth/google?returnTo=%2Fschedule"
            className="flex items-center gap-3 rounded-xl border border-dashed border-border/80 px-4 py-3 transition-colors hover:bg-muted/40"
          >
            <CalendarPlus className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-[13px] font-medium">Connect Google Calendar</p>
              <p className="text-[12px] text-muted-foreground">See your events</p>
            </div>
          </a>
        )}

        <MiniCalendar
          currentDate={currentDate}
          assignments={assignments}
          calendarEvents={calendarEvents}
          onSelectDate={(d) => setCurrentDate(d)}
        />

        <UpcomingList assignments={assignments} onSelect={setSelectedEvent} />

        {(suggestionsLoading || suggestions.length > 0) && (
          <SuggestionsPanel
            suggestions={suggestions}
            loading={suggestionsLoading}
          />
        )}
      </aside>

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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex shrink-0 border-b border-border">
        <div className="w-14 shrink-0" />
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex-1 border-l border-border px-2 py-3">
            <div className="mx-auto h-3 w-6 animate-pulse rounded bg-muted" />
            <div className="mx-auto mt-1.5 h-5 w-5 animate-pulse rounded-full bg-muted" />
          </div>
        ))}
      </div>
      <div className="flex-1 p-4">
        <div className="space-y-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <div className="h-3 w-10 animate-pulse rounded bg-muted" />
              <div className="h-px flex-1 bg-border" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
