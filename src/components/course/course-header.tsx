import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { courseColors } from "@/lib/constants";

interface Course {
  name: string;
  shortName: string | null;
  instructor: string | null;
  term: string | null;
  color: string;
  schedule: string | null;
  location: string | null;
}

export function CourseHeader({ course }: { course: Course }) {
  const colors = courseColors[course.color];
  const details = [course.instructor, course.schedule, course.location]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        Dashboard
      </Link>

      <div className="mt-4 rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${colors?.dot ?? "bg-gray-400"}`} />
          <span className="text-[12px] text-muted-foreground">
            {[course.shortName, course.term].filter(Boolean).join(" · ")}
          </span>
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{course.name}</h1>
        {details && (
          <p className="mt-2 text-[13px] text-muted-foreground">{details}</p>
        )}
      </div>
    </div>
  );
}
