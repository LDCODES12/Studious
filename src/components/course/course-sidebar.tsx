import { courseColors } from "@/lib/constants";

interface Course {
  color: string;
  instructor: string | null;
  schedule: string | null;
  location: string | null;
}

interface Assignment {
  status: string;
}

export function CourseSidebar({
  course,
  assignments,
}: {
  course: Course;
  assignments: Assignment[];
}) {
  const colors = courseColors[course.color];
  const total = assignments.length;
  const completed = assignments.filter(
    (a) => a.status === "submitted" || a.status === "graded"
  ).length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="space-y-6">
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
    </div>
  );
}
