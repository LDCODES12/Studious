"use client";

import { useState, useEffect } from "react";
import { format, addDays, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const COLOR_MAP: Record<string, string> = {
  blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  purple: "bg-purple-100 text-purple-700",
  orange: "bg-orange-100 text-orange-700",
  rose: "bg-rose-100 text-rose-700",
};

interface Assignment {
  id: string;
  title: string;
  dueDate: string | null;
  type: string;
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

export function ScheduleView() {
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 1 })
  );
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setSuggestions([]);
    const start = format(weekStart, "yyyy-MM-dd");
    const end = format(addDays(weekStart, 13), "yyyy-MM-dd");

    fetch(`/api/schedule?start=${start}&end=${end}`)
      .then((r) => r.json())
      .then(async (data) => {
        const fetchedAssignments = data.assignments ?? [];
        const fetchedEvents = data.calendarEvents ?? [];
        setAssignments(fetchedAssignments);
        setCalendarEvents(fetchedEvents);
        setLoading(false);

        // Fetch AI study suggestions
        if (fetchedAssignments.length > 0) {
          setSuggestionsLoading(true);
          try {
            const res = await fetch("/api/schedule/suggestions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                assignments: fetchedAssignments,
                calendarEvents: fetchedEvents,
              }),
            });
            const sData = await res.json();
            setSuggestions(sData.suggestions ?? []);
          } catch {
            // Silently ignore
          } finally {
            setSuggestionsLoading(false);
          }
        }
      })
      .catch(() => setLoading(false));
  }, [weekStart]);

  const days = Array.from({ length: 14 }, (_, i) => addDays(weekStart, i));

  const assignmentsForDay = (day: Date) => {
    const key = format(day, "yyyy-MM-dd");
    return assignments.filter((a) => a.dueDate === key);
  };

  const eventsForDay = (day: Date) => {
    const key = format(day, "yyyy-MM-dd");
    return calendarEvents.filter((e) => e.start.startsWith(key));
  };

  const renderDay = (day: Date) => {
    const dayAssignments = assignmentsForDay(day);
    const dayEvents = eventsForDay(day);
    const isToday = format(day, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");

    return (
      <div
        key={day.toISOString()}
        className="min-h-[110px] rounded-lg border border-border bg-card p-2"
      >
        <div
          className={cn(
            "mb-1.5 text-center",
            isToday ? "text-foreground" : "text-muted-foreground"
          )}
        >
          <div className="text-[10px] font-medium uppercase tracking-wide">
            {format(day, "EEE")}
          </div>
          <div
            className={cn(
              "mx-auto mt-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium",
              isToday ? "bg-foreground text-background" : ""
            )}
          >
            {format(day, "d")}
          </div>
        </div>

        <div className="space-y-0.5">
          {dayAssignments.map((a) => (
            <div
              key={a.id}
              className={cn(
                "truncate rounded px-1 py-0.5 text-[10px] font-medium",
                COLOR_MAP[a.course.color] ?? COLOR_MAP.blue
              )}
              title={`${a.title} — ${a.course.shortName ?? a.course.name}`}
            >
              {a.title}
            </div>
          ))}
          {dayEvents.map((e) => (
            <div
              key={e.id}
              className="truncate rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-600"
              title={e.summary}
            >
              {e.summary}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Week navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setWeekStart((w) => addDays(w, -7))}
          className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium hover:bg-accent"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Prev Week
        </button>
        <span className="text-[13px] font-medium text-muted-foreground">
          {format(weekStart, "MMM d")} – {format(addDays(weekStart, 13), "MMM d, yyyy")}
        </span>
        <button
          onClick={() => setWeekStart((w) => addDays(w, 7))}
          className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium hover:bg-accent"
        >
          Next Week
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Calendar grid — 2 weeks */}
      {loading ? (
        <div className="py-10 text-center text-[13px] text-muted-foreground">
          Loading schedule...
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-7 gap-1.5">{days.slice(0, 7).map(renderDay)}</div>
          <div className="grid grid-cols-7 gap-1.5">{days.slice(7, 14).map(renderDay)}</div>
        </div>
      )}

      {/* AI Study Suggestions */}
      <div>
        <h2 className="mb-3 text-[14px] font-semibold">Suggested Study Sessions</h2>
        {suggestionsLoading ? (
          <p className="text-[13px] text-muted-foreground">Generating suggestions...</p>
        ) : suggestions.length === 0 && !loading ? (
          <p className="text-[13px] text-muted-foreground">
            {assignments.length === 0
              ? "No upcoming deadlines — add courses and upload syllabi to get study suggestions."
              : "No suggestions available."}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {suggestions.map((s, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-medium text-muted-foreground">
                    {format(new Date(s.day + "T12:00:00"), "EEE, MMM d")}
                  </p>
                  <p className="text-[12px] text-muted-foreground">{s.time}</p>
                </div>
                <p className="mt-1.5 text-[13px] font-medium">{s.task}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">{s.reason}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
