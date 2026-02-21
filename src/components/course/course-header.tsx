import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { courseColors } from "@/lib/constants";
import { DeleteCourseButton } from "./delete-course-button";
import { AddClassTimesButton } from "./add-class-times-button";

interface Course {
  name: string;
  shortName: string | null;
  instructor: string | null;
  term: string | null;
  color: string;
  schedule: string | null;
  location: string | null;
}

interface CourseHeaderProps {
  course: Course;
  courseId: string;
  googleConnected?: boolean;
  hasClassSchedule?: boolean;
}

export function CourseHeader({
  course,
  courseId,
  googleConnected,
  hasClassSchedule,
}: CourseHeaderProps) {
  const colors = courseColors[course.color];
  const details = [course.instructor, course.schedule, course.location]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Dashboard
        </Link>
        <div className="flex items-center gap-2">
          <DeleteCourseButton courseId={courseId} />
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${colors?.dot ?? "bg-gray-400"}`} />
              <span className="text-[12px] text-muted-foreground">
                {[course.shortName, course.term].filter(Boolean).join(" · ")}
              </span>
            </div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight">{course.name}</h1>
            {details && (
              <p className="mt-2 text-[13px] text-muted-foreground">{details}</p>
            )}
          </div>

          {/* Show "Add class times to Calendar" if schedule is extracted + Google connected */}
          {googleConnected && hasClassSchedule && (
            <div className="shrink-0 pt-0.5">
              <AddClassTimesButton courseId={courseId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
