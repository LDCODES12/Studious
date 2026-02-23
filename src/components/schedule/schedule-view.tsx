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
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  differenceInMinutes,
  getHours,
  getMinutes,
} from "date-fns";
import { ChevronLeft, ChevronRight, Calendar, Clock, Sparkles, CalendarPlus } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface Assignment {
  id: string;
  title: string;
  dueDate: string | null;
  type: string;
  status: string;
  course: {
    id: string;
    name: string;
    shortName: string | null;
    color: string;
  };
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
}

interface Suggestion {
  day: string;
  time: string;
  task: string;
  reason: string;
}

type ViewMode = "month" | "week";

const COURSE_BG: Record<string, string> = {
  blue: "bg-blue-500",
  green: "bg-green-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
};

const COURSE_BG_LIGHT: Record<string, string> = {
  blue: "bg-blue-100 text-blue-800 border-blue-300",
  green: "bg-green-100 text-green-800 border-green-300",
  purple: "bg-purple-100 text-purple-800 border-purple-300",
  orange: "bg-orange-100 text-orange-800 border-orange-300",
  rose: "bg-rose-100 text-rose-800 border-rose-300",
};

const COURSE_BG_SOLID: Record<string, string> = {
  blue: "bg-blue-500 text-white",
  green: "bg-green-500 text-white",
  purple: "bg-purple-500 text-white",
  orange: "bg-orange-500 text-white",
  rose: "bg-rose-500 text-white",
};

const HOURS = Array.from({ length: 17 }, (_, i) => i + 6); // 6 AM → 10 PM
const HOUR_HEIGHT = 60; // px per hour in week view

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseEventTime(iso: string): Date | null {
  if (!iso) return null;
  try {
    return new Date(iso);
  } catch {
    return null;
  }
}

function isAllDayEvent(start: string, end: string): boolean {
  return start.length === 10 || (!start.includes("T") && !end.includes("T"));
}

function getEventTop(date: Date): number {
  const h = getHours(date);
  const m = getMinutes(date);
  return ((h - 6) * HOUR_HEIGHT) + (m / 60) * HOUR_HEIGHT;
}

function getEventHeight(start: Date, end: Date): number {
  const mins = differenceInMinutes(end, start);
  return Math.max((mins / 60) * HOUR_HEIGHT, 22);
}

// ── Main Component ───────────────────────────────────────────────────────────

export function ScheduleView() {
  const [view, setView] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Assignment | CalendarEvent | null>(null);
  const weekGridRef = useRef<HTMLDivElement>(null);

  // Clean URL after OAuth return (remove ?google=connected)
  useEffect(() => {
    if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("google") === "connected") {
      window.history.replaceState({}, "", "/schedule");
    }
  }, []);

  const weekStart = useMemo(
    () => startOfWeek(currentDate, { weekStartsOn: 0 }),
    [currentDate]
  );
  const monthStart = useMemo(() => startOfMonth(currentDate), [currentDate]);

  // Fetch range covers visible window + buffer
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
    return {
      start: format(ms, "yyyy-MM-dd"),
      end: format(me, "yyyy-MM-dd"),
    };
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
            /* ignore */
          } finally {
            setSuggestionsLoading(false);
          }
        }
      })
      .catch(() => setLoading(false));
  }, [fetchRange, view]);

  // Auto-scroll week view to current time on mount
  useEffect(() => {
    if (view === "week" && weekGridRef.current && !loading) {
      const now = new Date();
      const top = getEventTop(now) - 100;
      weekGridRef.current.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
  }, [view, loading]);

  const goToday = useCallback(() => setCurrentDate(new Date()), []);

  const goPrev = useCallback(() => {
    setCurrentDate((d) => (view === "month" ? subMonths(d, 1) : addWeeks(d, -1)));
  }, [view]);

  const goNext = useCallback(() => {
    setCurrentDate((d) => (view === "month" ? addMonths(d, 1) : addWeeks(d, 1)));
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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-8">
      {/* Main calendar area */}
      <div className="min-w-0 flex-1">
        {/* Header toolbar */}
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex items-center gap-1">
            <button
              onClick={goToday}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-accent transition-colors"
            >
              Today
            </button>
            <button
              onClick={goPrev}
              className="rounded-lg p-2 hover:bg-accent transition-colors"
              aria-label="Previous"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={goNext}
              className="rounded-lg p-2 hover:bg-accent transition-colors"
              aria-label="Next"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <h2 className="min-w-[180px] text-base font-semibold">{headerLabel}</h2>

          <div className="ml-auto flex rounded-lg bg-muted/50 p-0.5">
            <button
              onClick={() => setView("week")}
              className={cn(
                "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                view === "week"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Week
            </button>
            <button
              onClick={() => setView("month")}
              className={cn(
                "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                view === "month"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Month
            </button>
          </div>
        </div>

        {!googleConnected && !loading && (
          <a
            href="/api/auth/google?returnTo=%2Fschedule"
            className="mb-4 flex items-center gap-3 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4 transition-colors hover:bg-primary/10 hover:border-primary/50 lg:hidden"
          >
            <CalendarPlus className="h-5 w-5 shrink-0 text-primary" />
            <div>
              <p className="text-[13px] font-medium">Connect Google Calendar</p>
              <p className="text-[11px] text-muted-foreground">
                See your events alongside assignments
              </p>
            </div>
          </a>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          </div>
        ) : view === "week" ? (
          <WeekView
            weekStart={weekStart}
            assignments={assignments}
            calendarEvents={calendarEvents}
            gridRef={weekGridRef}
            assignmentsForDay={assignmentsForDay}
            eventsForDay={eventsForDay}
            onSelectEvent={setSelectedEvent}
          />
        ) : (
          <MonthView
            currentDate={currentDate}
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

      {/* Right sidebar */}
      <div className="hidden w-[280px] shrink-0 space-y-6 lg:block">
        {!googleConnected && (
          <a
            href="/api/auth/google?returnTo=%2Fschedule"
            className="flex items-center gap-3 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4 transition-colors hover:bg-primary/10 hover:border-primary/50"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <CalendarPlus className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-[13px] font-medium">Connect Google Calendar</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                See your events alongside assignments
              </p>
            </div>
          </a>
        )}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <MiniCalendar
            currentDate={currentDate}
            onSelectDate={(d) => {
              setCurrentDate(d);
              if (view === "month") setView("week");
            }}
          />
        </div>

        {/* Upcoming deadlines */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h3 className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Upcoming
          </h3>
          <UpcomingList assignments={assignments} />
        </div>

        {/* AI Suggestions */}
        {(suggestionsLoading || suggestions.length > 0) && (
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h3 className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              Study Suggestions
            </h3>
            {suggestionsLoading ? (
              <p className="text-[12px] text-muted-foreground">Generating...</p>
            ) : (
              <div className="space-y-2">
                {suggestions.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-border bg-muted/30 p-3 transition-colors hover:bg-muted/50"
                  >
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {format(new Date(s.day + "T12:00:00"), "EEE, MMM d")} · {s.time}
                    </p>
                    <p className="mt-1 text-[12px] font-medium">{s.task}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{s.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Event detail popover */}
      {selectedEvent && (
        <EventPopover event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}

// ── Week View ────────────────────────────────────────────────────────────────

function WeekView({
  weekStart,
  assignments,
  calendarEvents,
  gridRef,
  assignmentsForDay,
  eventsForDay,
  onSelectEvent,
}: {
  weekStart: Date;
  assignments: Assignment[];
  calendarEvents: CalendarEvent[];
  gridRef: React.RefObject<HTMLDivElement | null>;
  assignmentsForDay: (day: Date) => Assignment[];
  eventsForDay: (day: Date) => CalendarEvent[];
  onSelectEvent: (e: Assignment | CalendarEvent) => void;
}) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const [, setTick] = useState(0);

  // Re-render every minute so the current-time indicator stays accurate
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  const nowTop = getEventTop(new Date());
  const todayIndex = days.findIndex((d) => isToday(d));

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Day headers */}
      <div className="grid border-b border-border bg-muted/30" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
        <div className="border-r border-border py-2" />
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={cn(
              "border-r border-border px-2 py-3 text-center last:border-r-0",
              isToday(day) && "bg-primary/5"
            )}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {format(day, "EEE")}
            </div>
            <div
              className={cn(
                "mx-auto mt-1 flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors",
                isToday(day)
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground"
              )}
            >
              {format(day, "d")}
            </div>
          </div>
        ))}
      </div>

      {/* All-day events row */}
      <AllDayRow days={days} assignmentsForDay={assignmentsForDay} eventsForDay={eventsForDay} />

      {/* Time grid — scrollable with momentum on touch devices */}
      <div
        ref={gridRef}
        className="relative overflow-y-auto overscroll-contain"
        style={{
          minHeight: 320,
          maxHeight: "min(calc(100vh - 260px), 720px)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div className="relative" style={{ height: HOURS.length * HOUR_HEIGHT }}>
          {/* Hour lines */}
          {HOURS.map((hour) => (
            <div
              key={hour}
              className="absolute w-full"
              style={{ top: (hour - 6) * HOUR_HEIGHT }}
            >
              <div className="grid" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
                <div className="relative border-r border-border pr-2">
                  <span className="absolute -top-2.5 right-2 text-[10px] font-medium text-muted-foreground">
                    {hour < 12 ? `${hour === 0 ? 12 : hour} AM` : `${hour === 12 ? 12 : hour - 12} PM`}
                  </span>
                </div>
                {days.map((day, i) => (
                  <div
                    key={i}
                    className={cn(
                      "h-px border-t border-border",
                      i < 6 && "border-r border-border"
                    )}
                    style={{ height: HOUR_HEIGHT }}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Current time indicator */}
          {todayIndex >= 0 && (
            <div
              className="absolute z-20 pointer-events-none"
              style={{
                top: nowTop,
                left: `calc(60px + ${todayIndex} * (100% - 60px) / 7)`,
                width: `calc((100% - 60px) / 7)`,
              }}
            >
              <div className="flex items-center">
                <div className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                <div className="h-px flex-1 bg-red-500" />
              </div>
            </div>
          )}

          {/* Timed events */}
          {days.map((day, dayIndex) => {
            const dayEvents = eventsForDay(day).filter(
              (e) => !isAllDayEvent(e.start, e.end)
            );
            const dayAssignments = assignmentsForDay(day);

            return (
              <div
                key={day.toISOString()}
                className="absolute top-0"
                style={{
                  left: `calc(60px + ${dayIndex} * (100% - 60px) / 7)`,
                  width: `calc((100% - 60px) / 7)`,
                  height: "100%",
                }}
              >
                {/* GCal events */}
                {dayEvents.map((event) => {
                  const start = parseEventTime(event.start);
                  const end = parseEventTime(event.end);
                  if (!start || !end) return null;
                  const top = getEventTop(start);
                  const height = getEventHeight(start, end);
                  return (
                    <button
                      key={event.id}
                      onClick={() => onSelectEvent(event)}
                      className="absolute left-1 right-1 z-10 cursor-pointer overflow-hidden rounded-md border border-indigo-200/80 bg-indigo-50 px-2 py-1 text-left transition-all hover:bg-indigo-100 hover:shadow-sm"
                      style={{ top, height: Math.max(height, 24) }}
                    >
                      <p className="truncate text-[10px] font-medium text-indigo-800">
                        {event.summary}
                      </p>
                      {height >= 40 && (
                        <p className="mt-0.5 text-[9px] text-indigo-600">
                          {format(start, "h:mm a")} – {format(end, "h:mm a")}
                        </p>
                      )}
                    </button>
                  );
                })}

                {/* Assignment deadlines */}
                {dayAssignments.map((a, ai) => {
                  const top = 2 + ai * 24;
                  return (
                    <button
                      key={a.id}
                      onClick={() => onSelectEvent(a)}
                      className={cn(
                        "absolute left-1 right-1 z-10 cursor-pointer truncate rounded-md px-2 py-1 text-left text-[10px] font-medium transition-all hover:shadow-sm",
                        COURSE_BG_SOLID[a.course.color] ?? "bg-gray-500 text-white"
                      )}
                      style={{ top, height: 22 }}
                      title={`${a.title} — ${a.course.shortName ?? a.course.name}`}
                    >
                      {a.title}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── All Day Row ──────────────────────────────────────────────────────────────

function AllDayRow({
  days,
  assignmentsForDay,
  eventsForDay,
}: {
  days: Date[];
  assignmentsForDay: (day: Date) => Assignment[];
  eventsForDay: (day: Date) => CalendarEvent[];
}) {
  const hasAnyAllDay = days.some((day) => {
    const allDayEvents = eventsForDay(day).filter((e) => isAllDayEvent(e.start, e.end));
    return allDayEvents.length > 0;
  });

  if (!hasAnyAllDay) return null;

  return (
    <div
      className="grid border-b border-border bg-muted/20"
      style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}
    >
      <div className="flex items-center justify-center border-r border-border py-2">
        <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">All day</span>
      </div>
      {days.map((day) => {
        const allDay = eventsForDay(day).filter((e) => isAllDayEvent(e.start, e.end));
        return (
          <div key={day.toISOString()} className="min-h-[28px] border-r border-border px-1 py-0.5 last:border-r-0">
            {allDay.map((e) => (
              <div
                key={e.id}
                className="truncate rounded bg-indigo-100 px-1 py-0.5 text-[10px] font-medium text-indigo-700"
              >
                {e.summary}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── Month View ───────────────────────────────────────────────────────────────

function MonthView({
  currentDate,
  monthStart,
  assignmentsForDay,
  eventsForDay,
  onDayClick,
}: {
  currentDate: Date;
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
  const weeks = [];
  for (let i = 0; i < allDays.length; i += 7) {
    weeks.push(allDays.slice(i, i + 7));
  }

  const MAX_VISIBLE = 3;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 border-b border-border bg-muted/30">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="border-r border-border px-2 py-2.5 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground last:border-r-0"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Week rows */}
      {weeks.map((week, wi) => (
        <div
          key={wi}
          className="grid grid-cols-7 border-b border-border last:border-b-0"
        >
          {week.map((day) => {
            const dayAssignments = assignmentsForDay(day);
            const dayEvents = eventsForDay(day);
            const allItems = [...dayAssignments.map((a) => ({ type: "assignment" as const, item: a })), ...dayEvents.map((e) => ({ type: "event" as const, item: e }))];
            const visible = allItems.slice(0, MAX_VISIBLE);
            const overflow = allItems.length - MAX_VISIBLE;
            const inMonth = isSameMonth(day, monthStart);

            return (
              <button
                key={day.toISOString()}
                onClick={() => onDayClick(day)}
                className={cn(
                  "group relative min-h-[110px] border-r border-border p-2 text-left transition-colors hover:bg-accent/50 last:border-r-0",
                  !inMonth && "bg-muted/20"
                )}
              >
                <div
                  className={cn(
                    "mb-1.5 flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-semibold transition-colors",
                    isToday(day)
                      ? "bg-primary text-primary-foreground"
                      : inMonth
                        ? "text-foreground"
                        : "text-muted-foreground/40"
                  )}
                >
                  {format(day, "d")}
                </div>

                <div className="space-y-1">
                  {visible.map((entry, i) => {
                    if (entry.type === "assignment") {
                      const a = entry.item as Assignment;
                      return (
                        <div
                          key={a.id}
                          className={cn(
                            "truncate rounded px-1.5 py-0.5 text-[10px] font-medium",
                            COURSE_BG_LIGHT[a.course.color] ?? "bg-gray-100 text-gray-700"
                          )}
                        >
                          {a.title}
                        </div>
                      );
                    }
                    const e = entry.item as CalendarEvent;
                    return (
                      <div
                        key={e.id}
                        className="truncate rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                      >
                        {e.summary}
                      </div>
                    );
                  })}
                  {overflow > 0 && (
                    <div className="text-[10px] font-medium text-muted-foreground">
                      +{overflow} more
                    </div>
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

// ── Mini Calendar (sidebar) ──────────────────────────────────────────────────

function MiniCalendar({
  currentDate,
  onSelectDate,
}: {
  currentDate: Date;
  onSelectDate: (d: Date) => void;
}) {
  const [miniMonth, setMiniMonth] = useState(startOfMonth(currentDate));

  useEffect(() => {
    setMiniMonth(startOfMonth(currentDate));
  }, [currentDate]);

  const calStart = startOfWeek(miniMonth, { weekStartsOn: 0 });
  const calEnd = addDays(
    startOfWeek(addDays(endOfMonth(miniMonth), 1), { weekStartsOn: 0 }),
    6
  );
  const allDays = eachDayOfInterval({ start: calStart, end: calEnd });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">{format(miniMonth, "MMMM yyyy")}</h3>
        <div className="flex gap-0.5">
          <button
            onClick={() => setMiniMonth((m) => subMonths(m, 1))}
            className="rounded p-0.5 hover:bg-accent"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setMiniMonth((m) => addMonths(m, 1))}
            className="rounded p-0.5 hover:bg-accent"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-0">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="py-1 text-center text-[10px] font-medium text-muted-foreground">
            {d}
          </div>
        ))}
        {allDays.map((day) => {
          const inMonth = isSameMonth(day, miniMonth);
          const selected = isSameDay(day, currentDate);
          return (
            <button
              key={day.toISOString()}
              onClick={() => onSelectDate(day)}
              className={cn(
                "mx-auto flex h-7 w-7 items-center justify-center rounded-full text-[11px] transition-colors",
                !inMonth && "text-muted-foreground/40",
                inMonth && !selected && !isToday(day) && "hover:bg-accent",
                isToday(day) && !selected && "bg-blue-100 text-blue-700 font-semibold",
                selected && "bg-blue-600 text-white font-semibold"
              )}
            >
              {format(day, "d")}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Upcoming Deadlines ───────────────────────────────────────────────────────

function UpcomingList({ assignments }: { assignments: Assignment[] }) {
  const upcoming = assignments
    .filter((a) => a.dueDate && a.dueDate >= format(new Date(), "yyyy-MM-dd"))
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
    .slice(0, 6);

  if (upcoming.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">No upcoming deadlines</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {upcoming.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/50"
        >
          <div
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              COURSE_BG[a.course.color] ?? "bg-gray-400"
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium">{a.title}</p>
            <p className="text-[10px] text-muted-foreground">
              {a.course.shortName ?? a.course.name} · {a.dueDate ? format(parseISO(a.dueDate), "EEE, MMM d") : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Event Popover ────────────────────────────────────────────────────────────

function EventPopover({
  event,
  onClose,
}: {
  event: Assignment | CalendarEvent;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const isAssignment = "course" in event;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div
        ref={ref}
        className="w-[360px] rounded-2xl border border-border bg-card p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold leading-snug">
              {isAssignment ? (event as Assignment).title : (event as CalendarEvent).summary}
            </h3>
            {isAssignment && (
              <p className="mt-1 text-[13px] text-muted-foreground">
                {(event as Assignment).course.shortName ?? (event as Assignment).course.name}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <span className="text-xl leading-none">&times;</span>
          </button>
        </div>

        {isAssignment ? (
          <div className="space-y-3 text-[13px]">
            <div className="flex items-center gap-2.5 rounded-lg bg-muted/50 px-3 py-2">
              <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                {(event as Assignment).dueDate
                  ? format(parseISO((event as Assignment).dueDate!), "EEEE, MMMM d, yyyy")
                  : "No due date"}
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <div
                className={cn(
                  "h-3 w-3 shrink-0 rounded-sm",
                  COURSE_BG[(event as Assignment).course.color] ?? "bg-gray-400"
                )}
              />
              <span className="text-muted-foreground capitalize">
                {(event as Assignment).type}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-lg bg-muted/50 px-3 py-2 text-[13px]">
            <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              {(event as CalendarEvent).start.includes("T")
                ? `${format(new Date((event as CalendarEvent).start), "h:mm a")} – ${format(new Date((event as CalendarEvent).end), "h:mm a")}`
                : format(new Date((event as CalendarEvent).start + "T12:00:00"), "EEEE, MMMM d")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
