import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";
import type { WeekOverviewData, WeekDayData } from "@/lib/week-overview";

interface WeekOverviewProps {
  overview: WeekOverviewData;
  days: Omit<WeekDayData, "aiNote">[];
}

export function WeekOverview({ overview, days }: WeekOverviewProps) {
  // Match AI notes to structured days
  const aiNoteMap = new Map(overview.days.map((d) => [d.day, d.note]));

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="text-[14px] font-semibold">Your Week</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{overview.summary}</p>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {days.map((day) => {
          const aiNote = aiNoteMap.get(day.dayName) ?? null;

          return (
            <div
              key={day.dayName}
              className={cn(
                "rounded-md border px-3 py-2.5 min-h-[120px] flex flex-col",
                day.isToday
                  ? "border-foreground/30 bg-accent/40"
                  : "border-border/60 bg-background"
              )}
            >
              {/* Day header */}
              <div className="flex items-baseline justify-between mb-2">
                <span className={cn(
                  "text-[12px] font-semibold",
                  day.isToday ? "text-foreground" : "text-muted-foreground"
                )}>
                  {day.dayName}
                </span>
                <span className="text-[10px] text-muted-foreground/70">{day.date}</span>
              </div>

              {/* Classes */}
              {day.classes.map((cls, i) => {
                const colors = courseColors[cls.courseColor];
                return (
                  <div key={i} className="mb-1.5">
                    <div className="flex items-center gap-1">
                      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", colors?.dot ?? "bg-gray-400")} />
                      <span className="text-[11px] font-medium truncate">{cls.courseName}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground/70 ml-2.5">
                      {cls.time}{cls.label !== "Class" ? ` · ${cls.label}` : ""}
                    </span>
                  </div>
                );
              })}

              {/* Deadlines */}
              {day.deadlines.map((dl, i) => {
                const colors = courseColors[dl.courseColor];
                return (
                  <div key={`dl-${i}`} className="mb-1.5">
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-amber-500 shrink-0">●</span>
                      <span className="text-[11px] text-amber-600 dark:text-amber-400 truncate font-medium">
                        {dl.title}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* AI note — pushed to bottom */}
              {aiNote && (
                <p className="mt-auto pt-2 text-[10px] text-muted-foreground/80 italic leading-tight">
                  {aiNote}
                </p>
              )}

              {/* Empty state */}
              {day.classes.length === 0 && day.deadlines.length === 0 && !aiNote && (
                <p className="mt-auto text-[10px] text-muted-foreground/50 italic">No classes</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
