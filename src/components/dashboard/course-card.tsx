import Link from "next/link";
import { courseColors } from "@/lib/constants";

interface Course {
  id: string;
  name: string;
  shortName: string | null;
  instructor: string | null;
  color: string;
  assignments: { id: string; status: string }[];
}

export function CourseCard({ course }: { course: Course }) {
  const colors = courseColors[course.color];
  const total = course.assignments.length;
  const completed = course.assignments.filter(
    (a) => a.status === "submitted" || a.status === "graded"
  ).length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <Link href={`/courses/${course.id}`} className="group block">
      <div className="rounded-lg border border-border bg-card p-5 transition-colors hover:bg-accent/30">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${colors?.dot ?? "bg-gray-400"}`} />
              <span className="text-[12px] font-medium text-muted-foreground">
                {course.shortName ?? course.name}
              </span>
            </div>
            <h3 className="mt-2 text-[14px] font-medium leading-snug">{course.name}</h3>
            {course.instructor && (
              <p className="mt-1 text-[12px] text-muted-foreground">{course.instructor}</p>
            )}
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{completed}/{total} done</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
            <div
              className={`h-full rounded-full ${colors?.dot ?? "bg-gray-400"}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    </Link>
  );
}
