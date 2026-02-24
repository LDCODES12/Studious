"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  format,
  addDays,
  addWeeks,
  addMonths,
  subMonths,
  startOfWeek,
  startOfMonth,
  endOfMonth,
} from "date-fns";
import { ChevronLeft, ChevronRight, CalendarPlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { timeToY } from "./calendar-utils";
import { WeekView } from "./week-view";
import { MonthView } from "./month-view";
import { MiniCalendar } from "./mini-calendar";
import { UpcomingList } from "./upcoming-list";
import { SuggestionsPanel } from "./suggestions-panel";
import { EventDetailPanel } from "./event-detail-panel";
import type {
  Assignment,
  CalendarEvent,
  CourseRef,
  Suggestion,
  ViewMode,
  ScheduleItem,
} from "./calendar-types";

export function ScheduleView() {
  const [view, setView] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<ScheduleItem | null>(null);
  const weekGridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      new URL(window.location.href).searchParams.get("google") === "connected"
    ) {
      window.history.replaceState({}, "", "/schedule");
    }
  }, []);

  const weekStart = useMemo(
    () => startOfWeek(currentDate, { weekStartsOn: 0 }),
    [currentDate]
  );
  const monthStart = useMemo(() => startOfMonth(currentDate), [currentDate]);

  const fetchRange = useMemo(() => {
    if (view === "week") {
      return {
        start: format(weekStart, "yyyy-MM-dd"),
        end: format(addDays(weekStart, 7), "yyyy-MM-dd"),
      };
    }
    const ms = startOfWeek(monthStart, { weekStartsOn: 0 });
    const me = addDays(
      startOfWeek(addDays(endOfMonth(monthStart), 1), { weekStartsOn: 0 }),
      6
    );
    return { start: format(ms, "yyyy-MM-dd"), end: format(me, "yyyy-MM-dd") };
  }, [view, weekStart, monthStart]);

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

        if (a.length > 0 && view === "week") {
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
  }, [fetchRange, view]);

  useEffect(() => {
    if (view === "week" && weekGridRef.current && !loading) {
      const top = timeToY(new Date()) - 120;
      weekGridRef.current.scrollTo({
        top: Math.max(0, top),
        behavior: "smooth",
      });
    }
  }, [view, loading]);

  const courses: CourseRef[] = useMemo(() => {
    const map = new Map<string, CourseRef>();
    for (const a of assignments) {
      if (!map.has(a.course.id)) map.set(a.course.id, a.course);
    }
    return Array.from(map.values());
  }, [assignments]);

  const goToday = useCallback(() => setCurrentDate(new Date()), []);
  const goPrev = useCallback(() => {
    setCurrentDate((d) =>
      view === "month" ? subMonths(d, 1) : addWeeks(d, -1)
    );
  }, [view]);
  const goNext = useCallback(() => {
    setCurrentDate((d) =>
      view === "month" ? addMonths(d, 1) : addWeeks(d, 1)
    );
  }, [view]);

  const headerLabel = useMemo(() => {
    if (view === "month") return format(currentDate, "MMMM yyyy");
    const end = addDays(weekStart, 6);
    if (format(weekStart, "MMM yyyy") === format(end, "MMM yyyy")) {
      return `${format(weekStart, "MMM d")} – ${format(end, "d, yyyy")}`;
    }
    return `${format(weekStart, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
  }, [view, currentDate, weekStart]);

  const assignmentsForDay = useCallback(
    (day: Date) => {
      const key = format(day, "yyyy-MM-dd");
      return assignments.filter((a) => a.dueDate === key);
    },
    [assignments]
  );

  const eventsForDay = useCallback(
    (day: Date) => {
      const key = format(day, "yyyy-MM-dd");
      return calendarEvents.filter((e) => e.start.startsWith(key));
    },
    [calendarEvents]
  );

  // --- Mutation handlers (optimistic + API) ---

  const handleEventMove = useCallback(
    async (eventId: string, newStart: string, newEnd: string) => {
      const prev = calendarEvents;
      setCalendarEvents((evts) =>
        evts.map((e) =>
          e.id === eventId ? { ...e, start: newStart, end: newEnd } : e
        )
      );

      const evt = calendarEvents.find((e) => e.id === eventId);
      const label = evt?.summary ?? "Event";
      const timeLabel = new Date(newStart).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });

      toast(`${label} moved to ${timeLabel}`, {
        action: {
          label: "Undo",
          onClick: () => setCalendarEvents(prev),
        },
        duration: 5000,
      });

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

  const handleEventResize = useCallback(
    async (eventId: string, newEnd: string) => {
      const prev = calendarEvents;
      setCalendarEvents((evts) =>
        evts.map((e) => (e.id === eventId ? { ...e, end: newEnd } : e))
      );

      const evt = calendarEvents.find((e) => e.id === eventId);
      const label = evt?.summary ?? "Event";
      const endLabel = new Date(newEnd).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });

      toast(`${label} now ends at ${endLabel}`, {
        action: {
          label: "Undo",
          onClick: () => setCalendarEvents(prev),
        },
        duration: 5000,
      });

      try {
        const res = await fetch(`/api/calendar/events/${eventId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ end: newEnd }),
        });
        if (!res.ok) throw new Error();
      } catch {
        setCalendarEvents(prev);
        toast.error("Failed to save — change reverted");
      }
    },
    [calendarEvents]
  );

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              onClick={goToday}
              className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-muted"
            >
              Today
            </button>
            <button
              onClick={goPrev}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Previous"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={goNext}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Next"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <h2 className="text-[17px] font-semibold tracking-tight">
            {headerLabel}
          </h2>

          <div className="ml-auto flex rounded-lg border border-border p-0.5">
            {(["week", "month"] as ViewMode[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  "rounded-md px-3.5 py-1 text-[13px] font-medium capitalize transition-all",
                  view === v
                    ? "bg-foreground text-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {!googleConnected && !loading && (
          /* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, not a page */
          <a
            href="/api/auth/google?returnTo=%2Fschedule"
            className="mb-4 flex items-center gap-3 rounded-xl border border-dashed border-border/80 px-4 py-3 transition-colors hover:bg-muted/40 lg:hidden"
          >
            <CalendarPlus className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-[13px] font-medium">
                Connect Google Calendar
              </p>
              <p className="text-[12px] text-muted-foreground">
                See your events alongside assignments
              </p>
            </div>
          </a>
        )}

        {loading ? (
          <LoadingSkeleton view={view} />
        ) : view === "week" ? (
          <WeekView
            weekStart={weekStart}
            assignmentsForDay={assignmentsForDay}
            eventsForDay={eventsForDay}
            courses={courses}
            gridRef={weekGridRef}
            onSelectEvent={setSelectedEvent}
            onEventMove={handleEventMove}
            onEventResize={handleEventResize}
          />
        ) : (
          <MonthView
            monthStart={monthStart}
            assignmentsForDay={assignmentsForDay}
            eventsForDay={eventsForDay}
            onDayClick={(day) => {
              setCurrentDate(day);
              setView("week");
            }}
          />
        )}
      </div>

      {/* Sidebar */}
      <aside className="hidden w-[272px] shrink-0 space-y-5 overflow-y-auto lg:block">
        {!googleConnected && !loading && (
          /* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, not a page */
          <a
            href="/api/auth/google?returnTo=%2Fschedule"
            className="flex items-center gap-3 rounded-xl border border-dashed border-border/80 px-4 py-3 transition-colors hover:bg-muted/40"
          >
            <CalendarPlus className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-[13px] font-medium">
                Connect Google Calendar
              </p>
              <p className="text-[12px] text-muted-foreground">
                See your events
              </p>
            </div>
          </a>
        )}

        <MiniCalendar
          currentDate={currentDate}
          assignments={assignments}
          calendarEvents={calendarEvents}
          onSelectDate={(d) => {
            setCurrentDate(d);
            if (view === "month") setView("week");
          }}
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

function LoadingSkeleton({ view }: { view: ViewMode }) {
  if (view === "week") {
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

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid grid-cols-7 border-b border-border">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="border-l border-border px-2 py-3 first:border-l-0"
          >
            <div className="mx-auto h-3 w-6 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      {Array.from({ length: 5 }).map((_, ri) => (
        <div
          key={ri}
          className="grid grid-cols-7 border-b border-border last:border-b-0"
        >
          {Array.from({ length: 7 }).map((_, ci) => (
            <div
              key={ci}
              className="h-24 border-l border-border p-2 first:border-l-0"
            >
              <div className="h-4 w-4 animate-pulse rounded-full bg-muted" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
