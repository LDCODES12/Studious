import Link from "next/link";
import { CourseCard } from "./course-card";
import type { CourseContextSnapshot } from "@/lib/course-context";

interface CourseWithContext {
  course: {
    id: string;
    name: string;
    color: string;
    currentGrade: string | null;
    currentScore: number | null;
  };
  context: CourseContextSnapshot;
}

export function CourseGrid({ courses }: { courses: CourseWithContext[] }) {
  if (courses.length === 0) {
    return (
      <div>
        <h2 className="mb-4 text-[14px] font-semibold">Courses</h2>
        <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
          <p className="text-[13px] text-muted-foreground">No courses yet.</p>
          <Link
            href="/upload"
            className="mt-3 inline-block text-[13px] font-medium text-foreground underline underline-offset-2"
          >
            Upload a syllabus to get started
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-4 text-[14px] font-semibold">Courses</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {courses.map(({ course, context }) => (
          <CourseCard key={course.id} course={course} context={context} />
        ))}
      </div>
    </div>
  );
}
