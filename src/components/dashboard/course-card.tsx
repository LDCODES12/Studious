import Link from "next/link";
import { courseColors } from "@/lib/constants";
import type { WeekPosition, DeadlineItem } from "@/lib/course-context";
import type { RecentCourseActivityItem } from "@/lib/recent-course-activity";

interface CourseCardProps {
  course: {
    id: string;
    name: string;
    color: string;
    currentGrade: string | null;
    currentScore: number | null;
  };
  context: {
    currentWeek: WeekPosition | null;
    urgentAssignments: DeadlineItem[];
    upcomingAssignments: DeadlineItem[];
    nextClassMeeting: string | null;
  };
  recentItems: RecentCourseActivityItem[];
}

function formatNextDue(item: DeadlineItem): string {
  const hrs = item.hoursUntilDue;
  if (hrs < 0) return "overdue";
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return `${days}d`;
}

export function CourseCard({ course, context, recentItems }: CourseCardProps) {
  const colors = courseColors[course.color];
  const { currentWeek } = context;
  const recentItem = recentItems[0] ?? null;

  // First not-started assignment due soonest
  const nextDue =
    context.urgentAssignments.find((a) => a.status === "not_started") ??
    context.upcomingAssignments.find((a) => a.status === "not_started") ??
    null;

  // Grade display
  const grade = course.currentGrade ?? (course.currentScore != null ? `${course.currentScore}%` : null);

  // Filter out generic labels like "Lecture 5" or "Module 3" from topics
  const isSemanticTopic = (name: string) =>
    !/^(Lecture|Module|Week|Unit|Chapter|Session|Class)\s*\d+$/i.test(name);
  const topics = (currentWeek?.topics ?? []).filter(isSemanticTopic);
  const readings = currentWeek?.readings ?? [];

  return (
    <Link href={`/courses/${course.id}`} className="group block">
      <div className="rounded-lg border border-border bg-card p-5 transition-colors hover:bg-accent/30">
        {/* Header: name + grade */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`h-2 w-2 shrink-0 rounded-full ${colors?.dot ?? "bg-gray-400"}`} />
            <h3 className="text-[14px] font-medium leading-snug truncate">{course.name}</h3>
          </div>
          {grade && (
            <span className="shrink-0 text-[13px] font-semibold tabular-nums text-muted-foreground">
              {grade}
            </span>
          )}
        </div>

        {/* Current week topic */}
        {currentWeek && (
          <div className="mt-3">
            {topics.length > 0 ? (
              <p className="text-[12px] text-muted-foreground line-clamp-1">
                {topics.slice(0, 3).join(", ")}
              </p>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                {currentWeek.weekLabel}
              </p>
            )}
            {readings.length > 0 && (
              <p className="mt-0.5 text-[11px] text-muted-foreground/70 line-clamp-1">
                {readings.slice(0, 3).join(", ")}
              </p>
            )}
          </div>
        )}

        {/* Next due */}
        {nextDue && (
          <div className="mt-3 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className="truncate">{nextDue.title}</span>
            <span className="shrink-0">· {formatNextDue(nextDue)}</span>
          </div>
        )}

        {recentItem && (
          <div className="mt-3 rounded-md bg-accent/40 px-2.5 py-2">
            <p className="text-[11px] font-medium text-foreground/90">
              {recentItem.label}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {recentItem.title}
              <span className="text-muted-foreground/60"> · {recentItem.freshnessLabel}</span>
            </p>
          </div>
        )}
      </div>
    </Link>
  );
}
