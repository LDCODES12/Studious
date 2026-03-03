import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";
import type { WeekOverviewData, WeekCourseData, WeekDeadlineDay } from "@/lib/week-overview";

interface WeekOverviewProps {
  overview: WeekOverviewData;
  courses: WeekCourseData[];
  deadlineDays: WeekDeadlineDay[];
}

export function WeekOverview({ overview, courses, deadlineDays }: WeekOverviewProps) {
  const courseNoteMap = new Map(overview.courseNotes.map((n) => [n.courseName, n.note]));

  // Only show deadline days that have items or are today
  const relevantDays = deadlineDays.filter((d) => d.deadlines.length > 0 || d.isToday);

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      {/* Summary */}
      <div>
        <h2 className="text-[14px] font-semibold">This Week</h2>
        <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">{overview.summary}</p>
      </div>

      {/* Per-course breakdown */}
      <div className="space-y-3">
        {courses.map((course) => {
          const colors = courseColors[course.courseColor];
          const aiNote = courseNoteMap.get(course.courseName) ?? null;

          return (
            <div key={course.courseId} className="rounded-md border border-border/60 bg-background px-4 py-3">
              {/* Course header */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className={cn("h-2 w-2 rounded-full shrink-0", colors?.dot ?? "bg-gray-400")} />
                <span className="text-[13px] font-medium">{course.courseName}</span>
                {course.weekLabel && (
                  <span className="text-[11px] text-muted-foreground/70 ml-auto truncate max-w-[200px]">
                    {course.weekLabel}
                  </span>
                )}
              </div>

              {/* Topics */}
              {course.topics.length > 0 && (
                <p className="text-[12px] text-muted-foreground ml-4 line-clamp-1">
                  {course.topics.join(", ")}
                </p>
              )}

              {/* Readings */}
              {course.readings.length > 0 && (
                <p className="text-[11px] text-muted-foreground/70 ml-4 line-clamp-1">
                  {course.readings.join(", ")}
                </p>
              )}

              {/* Deadlines for this course */}
              {course.deadlines.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 ml-4">
                  {course.deadlines.map((dl, i) => (
                    <span key={i} className="text-[11px]">
                      <span className={cn(
                        "font-medium",
                        dl.status === "submitted" || dl.status === "graded"
                          ? "text-green-600 dark:text-green-400 line-through"
                          : "text-amber-600 dark:text-amber-400"
                      )}>
                        {dl.title}
                      </span>
                      <span className="text-muted-foreground/60"> · {dl.dueDay}</span>
                    </span>
                  ))}
                </div>
              )}

              {/* AI note */}
              {aiNote && (
                <p className="text-[11px] text-muted-foreground/80 italic mt-1.5 ml-4">
                  {aiNote}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Deadline timeline strip */}
      {relevantDays.length > 0 && (
        <div className="flex gap-1.5 pt-1">
          {deadlineDays.map((day) => (
            <div
              key={day.dayName}
              className={cn(
                "flex-1 rounded px-2 py-1.5 text-center",
                day.isToday
                  ? "bg-accent/60 border border-foreground/20"
                  : day.isPast
                    ? "opacity-50"
                    : "bg-background"
              )}
            >
              <span className={cn(
                "text-[10px] font-medium block",
                day.isToday ? "text-foreground" : "text-muted-foreground/70"
              )}>
                {day.dayName}
              </span>
              {day.deadlines.length > 0 && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium block mt-0.5">
                  {day.deadlines.length} due
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
