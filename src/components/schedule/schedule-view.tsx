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
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Sparkles,
  CalendarPlus,
  X,
  Calendar,
  BookOpen,
} from "lucide-react";
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

// ── Color Maps ───────────────────────────────────────────────────────────────

const ACCENT_DOT: Record<string, string> = {
  blue: "bg-blue-500",
  green: "bg-green-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
};

const ACCENT_CHIP: Record<string, string> = {
  blue: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  green: "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  purple: "bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
  orange: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  rose: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};

const ACCENT_BAR: Record<string, string> = {
  blue: "bg-blue-500",
  green: "bg-green-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
};

const ACCENT_EVENT_BG: Record<string, string> = {
  blue: "bg-blue-500/10 hover:bg-blue-500/[0.15] dark:bg-blue-400/15 dark:hover:bg-blue-400/20",
  green: "bg-green-500/10 hover:bg-green-500/[0.15] dark:bg-green-400/15 dark:hover:bg-green-400/20",
  purple: "bg-purple-500/10 hover:bg-purple-500/[0.15] dark:bg-purple-400/15 dark:hover:bg-purple-400/20",
  orange: "bg-orange-500/10 hover:bg-orange-500/[0.15] dark:bg-orange-400/15 dark:hover:bg-orange-400/20",
  rose: "bg-rose-500/10 hover:bg-rose-500/[0.15] dark:bg-rose-400/15 dark:hover:bg-rose-400/20",
};

const ACCENT_EVENT_TEXT: Record<string, string> = {
  blue: "text-blue-700 dark:text-blue-300",
  green: "text-green-700 dark:text-green-300",
  purple: "text-purple-700 dark:text-purple-300",
  orange: "text-orange-700 dark:text-orange-300",
  rose: "text-rose-700 dark:text-rose-300",
};

// ── Constants ────────────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 18 }, (_, i) => i + 5); // 5 AM → 10 PM
const HOUR_HEIGHT = 64;
const GUTTER_WIDTH = 52;

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

function timeToY(date: Date): number {
  return (getHours(date) - 5) * HOUR_HEIGHT + (getMinutes(date) / 60) * HOUR_HEIGHT;
}

function eventHeight(start: Date, end: Date): number {
  const mins = differenceInMinutes(end, start);
  return Math.max((mins / 60) * HOUR_HEIGHT, 24);
}

function formatHour(hour: number): string {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

interface LayoutSlot {
  column: number;
  totalColumns: number;
}

function layoutOverlapping<T extends { topY: number; height: number }>(
  items: T[]
): (T & LayoutSlot)[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.topY - b.topY || b.height - a.height);

  const columns: { endY: number }[] = [];
  const result: (T & LayoutSlot)[] = [];

  for (const item of sorted) {
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      if (item.topY >= columns[c].endY - 1) {
        columns[c].endY = item.topY + item.height;
        result.push({ ...item, column: c, totalColumns: 0 });
        placed = true;
        break;
      }
    }
    if (!placed) {
      result.push({ ...item, column: columns.length, totalColumns: 0 });
      columns.push({ endY: item.topY + item.height });
    }
  }

  // Assign total columns per overlap group
  const groups: number[][] = [];
  for (let i = 0; i < result.length; i++) {
    let foundGroup = false;
    for (const group of groups) {
      const overlaps = group.some((gi) => {
        const a = result[gi];
        const b = result[i];
        return a.topY < b.topY + b.height && b.topY < a.topY + a.height;
      });
      if (overlaps) {
        group.push(i);
        foundGroup = true;
        break;
      }
    }
    if (!foundGroup) groups.push([i]);
  }

  for (const group of groups) {
    const maxCol = Math.max(...group.map((i) => result[i].column)) + 1;
    for (const i of group) result[i].totalColumns = maxCol;
  }

  return result;
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

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      {/* Main calendar area */}
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

          <h2 className="text-[17px] font-semibold tracking-tight">{headerLabel}</h2>

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
              <p className="text-[13px] font-medium">Connect Google Calendar</p>
              <p className="text-[12px] text-muted-foreground">See your events alongside assignments</p>
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
            gridRef={weekGridRef}
            onSelectEvent={setSelectedEvent}
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
      <aside className="hidden w-[272px] shrink-0 space-y-5 lg:block">
        {!googleConnected && !loading && (
          /* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, not a page */
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
          onSelectDate={(d) => {
            setCurrentDate(d);
            if (view === "month") setView("week");
          }}
        />

        <UpcomingList assignments={assignments} onSelect={setSelectedEvent} />

        {(suggestionsLoading || suggestions.length > 0) && (
          <SuggestionsPanel suggestions={suggestions} loading={suggestionsLoading} />
        )}
      </aside>

      {/* Event detail panel */}
      {selectedEvent && (
        <EventDetailPanel event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}

// ── Loading Skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton({ view }: { view: ViewMode }) {
  if (view === "week") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex shrink-0 border-b border-border">
          <div className="w-[52px] shrink-0" />
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
          <div key={i} className="border-l border-border px-2 py-3 first:border-l-0">
            <div className="mx-auto h-3 w-6 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      {Array.from({ length: 5 }).map((_, ri) => (
        <div key={ri} className="grid grid-cols-7 border-b border-border last:border-b-0">
          {Array.from({ length: 7 }).map((_, ci) => (
            <div key={ci} className="h-24 border-l border-border p-2 first:border-l-0">
              <div className="h-4 w-4 animate-pulse rounded-full bg-muted" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Week View ────────────────────────────────────────────────────────────────

function WeekView({
  weekStart,
  assignmentsForDay,
  eventsForDay,
  gridRef,
  onSelectEvent,
}: {
  weekStart: Date;
  assignmentsForDay: (day: Date) => Assignment[];
  eventsForDay: (day: Date) => CalendarEvent[];
  gridRef: React.RefObject<HTMLDivElement | null>;
  onSelectEvent: (e: Assignment | CalendarEvent) => void;
}) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const todayIndex = days.findIndex((d) => isToday(d));

  const hasAllDay = days.some((day) => {
    const allDayGcal = eventsForDay(day).filter((e) => isAllDayEvent(e.start, e.end));
    const dayAssignments = assignmentsForDay(day);
    return allDayGcal.length > 0 || dayAssignments.length > 0;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
      {/* Day column headers */}
      <div className="flex shrink-0 border-b border-border">
        <div className="w-[52px] shrink-0" />
        {days.map((day, i) => (
          <div
            key={day.toISOString()}
            className={cn(
              "flex flex-1 flex-col items-center border-l border-border py-2.5",
              i === 0 && "border-l-0"
            )}
          >
            <span
              className={cn(
                "text-[11px] font-medium uppercase tracking-wide",
                isToday(day) ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"
              )}
            >
              {format(day, "EEE")}
            </span>
            <span
              className={cn(
                "mt-1 flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-semibold",
                isToday(day)
                  ? "bg-blue-600 text-white dark:bg-blue-500"
                  : "text-foreground"
              )}
            >
              {format(day, "d")}
            </span>
          </div>
        ))}
      </div>

      {/* All-day / assignment row */}
      {hasAllDay && (
        <AllDayRow
          days={days}
          assignmentsForDay={assignmentsForDay}
          eventsForDay={eventsForDay}
          onSelectEvent={onSelectEvent}
        />
      )}

      {/* Scrollable time grid */}
      <div
        ref={gridRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          className="relative"
          style={{ height: HOURS.length * HOUR_HEIGHT }}
        >
          {/* Hour gridlines */}
          {HOURS.map((hour) => {
            const y = (hour - 5) * HOUR_HEIGHT;
            return (
              <div key={hour} className="absolute w-full" style={{ top: y }}>
                <div className="flex">
                  <div className="relative w-[52px] shrink-0">
                    <span className="absolute -top-[7px] right-3 text-[11px] tabular-nums text-muted-foreground">
                      {formatHour(hour)}
                    </span>
                  </div>
                  <div className="flex-1 border-t border-border" />
                </div>
                {/* Half-hour line */}
                <div className="flex" style={{ marginTop: HOUR_HEIGHT / 2 }}>
                  <div className="w-[52px] shrink-0" />
                  <div className="flex-1 border-t border-dashed border-border/50" />
                </div>
              </div>
            );
          })}

          {/* Vertical day separators */}
          {days.map((_, i) => {
            if (i === 0) return null;
            return (
              <div
                key={i}
                className="absolute top-0 bottom-0 border-l border-border"
                style={{ left: `calc(${GUTTER_WIDTH}px + ${i} * (100% - ${GUTTER_WIDTH}px) / 7)` }}
              />
            );
          })}

          {/* Current time indicator */}
          {todayIndex >= 0 && <NowIndicator todayIndex={todayIndex} />}

          {/* Timed events per day */}
          {days.map((day, dayIndex) => (
            <DayColumn
              key={day.toISOString()}
              day={day}
              dayIndex={dayIndex}
              eventsForDay={eventsForDay}
              onSelectEvent={onSelectEvent}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Now Indicator ────────────────────────────────────────────────────────────

function NowIndicator({ todayIndex }: { todayIndex: number }) {
  const y = timeToY(new Date());
  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{
        top: y,
        left: `calc(${GUTTER_WIDTH}px + ${todayIndex} * (100% - ${GUTTER_WIDTH}px) / 7)`,
        width: `calc((100% - ${GUTTER_WIDTH}px) / 7)`,
      }}
    >
      <div className="flex items-center">
        <div className="h-2.5 w-2.5 -ml-[5px] shrink-0 rounded-full bg-red-500" />
        <div className="h-[2px] flex-1 bg-red-500" />
      </div>
    </div>
  );
}

// ── Day Column (timed events) ────────────────────────────────────────────────

function DayColumn({
  day,
  dayIndex,
  eventsForDay,
  onSelectEvent,
}: {
  day: Date;
  dayIndex: number;
  eventsForDay: (day: Date) => CalendarEvent[];
  onSelectEvent: (e: CalendarEvent) => void;
}) {
  const timedEvents = eventsForDay(day).filter(
    (e) => !isAllDayEvent(e.start, e.end)
  );

  const items = timedEvents.map((event) => {
    const start = parseEventTime(event.start);
    const end = parseEventTime(event.end);
    if (!start || !end) return null;
    return { event, topY: timeToY(start), height: eventHeight(start, end), start, end };
  }).filter(Boolean) as { event: CalendarEvent; topY: number; height: number; start: Date; end: Date }[];

  const laid = layoutOverlapping(items);

  return (
    <div
      className="absolute top-0"
      style={{
        left: `calc(${GUTTER_WIDTH}px + ${dayIndex} * (100% - ${GUTTER_WIDTH}px) / 7)`,
        width: `calc((100% - ${GUTTER_WIDTH}px) / 7)`,
        height: "100%",
      }}
    >
      {laid.map((slot) => {
        const widthPct = 100 / slot.totalColumns;
        const leftPct = slot.column * widthPct;
        const isShort = slot.height < 40;

        return (
          <button
            key={slot.event.id}
            onClick={() => onSelectEvent(slot.event)}
            className="absolute z-10 cursor-pointer overflow-hidden rounded-lg bg-muted/80 px-2 py-1 text-left transition-colors hover:bg-muted dark:bg-muted/50 dark:hover:bg-muted/70"
            style={{
              top: slot.topY,
              height: slot.height,
              left: `calc(${leftPct}% + 2px)`,
              width: `calc(${widthPct}% - 4px)`,
            }}
          >
            <div className="flex h-full min-w-0 gap-1.5">
              <div className="mt-0.5 w-[3px] shrink-0 rounded-full bg-slate-400 dark:bg-slate-500" />
              <div className="min-w-0 flex-1">
                <p className={cn(
                  "truncate font-medium text-foreground",
                  isShort ? "text-[11px]" : "text-[12px]"
                )}>
                  {slot.event.summary}
                </p>
                {!isShort && (
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {format(slot.start, "h:mm")} – {format(slot.end, "h:mm a")}
                  </p>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── All-Day Row ──────────────────────────────────────────────────────────────

function AllDayRow({
  days,
  assignmentsForDay,
  eventsForDay,
  onSelectEvent,
}: {
  days: Date[];
  assignmentsForDay: (day: Date) => Assignment[];
  eventsForDay: (day: Date) => CalendarEvent[];
  onSelectEvent: (e: Assignment | CalendarEvent) => void;
}) {
  return (
    <div className="flex shrink-0 border-b border-border">
      <div className="flex w-[52px] shrink-0 items-start justify-end pr-2 pt-1.5">
        <span className="text-[11px] text-muted-foreground">All day</span>
      </div>
      {days.map((day, i) => {
        const allDayGcal = eventsForDay(day).filter((e) => isAllDayEvent(e.start, e.end));
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
                  ACCENT_EVENT_BG[a.course.color] ?? "bg-muted hover:bg-muted/80",
                  ACCENT_EVENT_TEXT[a.course.color] ?? "text-foreground"
                )}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", ACCENT_DOT[a.course.color] ?? "bg-gray-400")} />
                <span className="truncate">{a.title}</span>
              </button>
            ))}
            {allDayGcal.map((e) => (
              <button
                key={e.id}
                onClick={() => onSelectEvent(e)}
                className="flex items-center gap-1 truncate rounded-md bg-muted/60 px-1.5 py-0.5 text-left text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                <span className="truncate">{e.summary}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── Month View ───────────────────────────────────────────────────────────────

function MonthView({
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
      {/* Weekday headers */}
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

      {/* Weeks */}
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
              ...dayAssignments.map((a) => ({ type: "assignment" as const, item: a })),
              ...dayEvents.map((e) => ({ type: "event" as const, item: e })),
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
                        ? "bg-blue-600 text-white font-semibold dark:bg-blue-500"
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
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", ACCENT_DOT[a.course.color] ?? "bg-gray-400")} />
                          <span className="truncate text-[11px] font-medium text-foreground">{a.title}</span>
                        </div>
                      );
                    }
                    const e = entry.item as CalendarEvent;
                    return (
                      <div
                        key={e.id}
                        className="flex items-center gap-1 truncate rounded px-1 py-px"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                        <span className="truncate text-[11px] text-muted-foreground">{e.summary}</span>
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

// ── Mini Calendar ────────────────────────────────────────────────────────────

function MiniCalendar({
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
  const miniMonth = miniMonthOverride && format(miniMonthOverride, "yyyy-MM") !== format(derivedMonth, "yyyy-MM")
    ? miniMonthOverride
    : derivedMonth;

  const calStart = startOfWeek(miniMonth, { weekStartsOn: 0 });
  const calEnd = addDays(startOfWeek(addDays(endOfMonth(miniMonth), 1), { weekStartsOn: 0 }), 6);
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
        <h3 className="text-[13px] font-semibold">{format(miniMonth, "MMMM yyyy")}</h3>
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
          <div key={i} className="py-1 text-center text-[11px] font-medium text-muted-foreground">
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
                  inMonth && !selected && !isToday(day) && "text-foreground group-hover:bg-muted",
                  isToday(day) && !selected && "bg-blue-600 text-white font-semibold dark:bg-blue-500",
                  selected && !isToday(day) && "bg-foreground text-background font-semibold",
                  selected && isToday(day) && "bg-blue-600 text-white font-semibold ring-2 ring-blue-600/30 dark:bg-blue-500 dark:ring-blue-500/30"
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

// ── Upcoming List ────────────────────────────────────────────────────────────

function UpcomingList({
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
        <p className="py-2 text-center text-[12px] text-muted-foreground">No upcoming deadlines</p>
      ) : (
        <div className="space-y-0.5">
          {upcoming.map((a) => (
            <button
              key={a.id}
              onClick={() => onSelect(a)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60"
            >
              <div className={cn("h-8 w-[3px] shrink-0 rounded-full", ACCENT_BAR[a.course.color] ?? "bg-gray-400")} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{a.title}</p>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className={cn("rounded px-1.5 py-px text-[10px] font-medium", ACCENT_CHIP[a.course.color] ?? "bg-muted text-muted-foreground")}>
                    {a.course.shortName ?? a.course.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {a.dueDate ? format(parseISO(a.dueDate), "EEE, MMM d") : ""}
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

// ── Suggestions Panel ────────────────────────────────────────────────────────

function SuggestionsPanel({
  suggestions,
  loading,
}: {
  suggestions: Suggestion[];
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        Study Suggestions
      </h3>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg bg-muted/40 p-3">
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              <div className="mt-2 h-3.5 w-full animate-pulse rounded bg-muted" />
              <div className="mt-1.5 h-3 w-3/4 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {suggestions.map((s, i) => (
            <div
              key={i}
              className="rounded-lg bg-muted/30 p-2.5 transition-colors hover:bg-muted/50"
            >
              <p className="text-[11px] font-medium text-muted-foreground">
                {format(new Date(s.day + "T12:00:00"), "EEE, MMM d")} · {s.time}
              </p>
              <p className="mt-1 text-[13px] font-medium leading-snug">{s.task}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{s.reason}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Event Detail Panel ───────────────────────────────────────────────────────

function EventDetailPanel({
  event,
  onClose,
}: {
  event: Assignment | CalendarEvent;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) handleClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [handleClose]);

  const isAssignment = "course" in event;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-end bg-black/10 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <div
        ref={ref}
        className={cn(
          "mr-4 mt-16 w-[360px] rounded-xl border border-border bg-card shadow-xl transition-all duration-200",
          visible ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border p-5">
          {isAssignment && (
            <div className={cn("mt-1 h-10 w-[3px] shrink-0 rounded-full", ACCENT_BAR[(event as Assignment).course.color] ?? "bg-gray-400")} />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-semibold leading-snug">
              {isAssignment ? (event as Assignment).title : (event as CalendarEvent).summary}
            </h3>
            {isAssignment && (
              <p className="mt-1 text-[13px] text-muted-foreground">
                {(event as Assignment).course.shortName ?? (event as Assignment).course.name}
              </p>
            )}
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-3 p-5">
          {isAssignment ? (
            <>
              <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3.5 py-2.5">
                <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-[13px]">
                  {(event as Assignment).dueDate
                    ? format(parseISO((event as Assignment).dueDate!), "EEEE, MMMM d, yyyy")
                    : "No due date"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className={cn(
                  "rounded-md px-2 py-0.5 text-[12px] font-medium capitalize",
                  ACCENT_CHIP[(event as Assignment).course.color] ?? "bg-muted text-muted-foreground"
                )}>
                  {(event as Assignment).type}
                </span>
                {(event as Assignment).status !== "not_started" && (
                  <span className="rounded-md bg-muted px-2 py-0.5 text-[12px] font-medium capitalize text-muted-foreground">
                    {(event as Assignment).status.replace("_", " ")}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3.5 py-2.5">
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-[13px]">
                {(event as CalendarEvent).start.includes("T")
                  ? `${format(new Date((event as CalendarEvent).start), "h:mm a")} – ${format(new Date((event as CalendarEvent).end), "h:mm a")}`
                  : format(new Date((event as CalendarEvent).start + "T12:00:00"), "EEEE, MMMM d")}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
