import { format, parseISO } from "date-fns";
import { courseColors } from "@/lib/constants";

interface Course {
  color: string;
  instructor: string | null;
  schedule: string | null;
  location: string | null;
  currentGrade: string | null;
  currentScore: number | null;
}

interface Assignment {
  status: string;
}

interface Announcement {
  id: string;
  title: string;
  body: string;
  postedAt: string;
}

export function CourseSidebar({
  course,
  assignments,
  announcements = [],
}: {
  course: Course;
  assignments: Assignment[];
  announcements?: Announcement[];
}) {
  const colors = courseColors[course.color];
  const total = assignments.length;
  const completed = assignments.filter(
    (a) => a.status === "submitted" || a.status === "graded"
  ).length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Grade */}
      {(course.currentGrade || course.currentScore != null) && (
        <div>
          <p className="text-[12px] text-muted-foreground">Current Grade</p>
          <div className="mt-2 flex items-baseline gap-2">
            {course.currentGrade && (
              <span className="text-2xl font-semibold">{course.currentGrade}</span>
            )}
            {course.currentScore != null && (
              <span className="text-[14px] tabular-nums text-muted-foreground">
                {course.currentScore.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      )}

      {/* Progress */}
      <div>
        <p className="text-[12px] text-muted-foreground">Progress</p>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-semibold tabular-nums">{progress}%</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
          <div
            className={`h-full rounded-full ${colors?.dot ?? "bg-gray-400"}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          {completed} of {total} assignments
        </p>
      </div>

      {/* Details */}
      <div>
        <p className="text-[12px] text-muted-foreground">Details</p>
        <div className="mt-2 space-y-2 text-[13px]">
          {course.instructor && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Instructor</span>
              <span>{course.instructor}</span>
            </div>
          )}
          {course.schedule && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Schedule</span>
              <span>{course.schedule}</span>
            </div>
          )}
          {course.location && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Location</span>
              <span>{course.location}</span>
            </div>
          )}
        </div>
      </div>

      {/* Announcements */}
      {announcements.length > 0 && (
        <div>
          <p className="text-[12px] text-muted-foreground">Announcements</p>
          <div className="mt-2 space-y-2">
            {announcements.slice(0, 5).map((ann) => (
              <div
                key={ann.id}
                className="rounded-lg border border-border bg-card px-3 py-2"
              >
                <p className="text-[13px] font-medium leading-snug">{ann.title}</p>
                {ann.body && (
                  <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">
                    {ann.body.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground/60">
                  {format(parseISO(ann.postedAt), "MMM d, yyyy")}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
