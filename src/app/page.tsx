import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { GreetingBanner } from "@/components/dashboard/greeting-banner";
import { QuickStats } from "@/components/dashboard/quick-stats";
import { CourseGrid } from "@/components/dashboard/course-grid";
import { UpcomingDeadlines } from "@/components/dashboard/upcoming-deadlines";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;

  const courses = userId
    ? await db.course.findMany({
        where: { userId },
        include: { assignments: { orderBy: { dueDate: "asc" } } },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const assignments = courses.flatMap((c) =>
    c.assignments.map((a) => ({ ...a, course: c }))
  );

  return (
    <div className="mx-auto max-w-[1200px] space-y-7">
      <GreetingBanner name={session?.user?.name ?? "there"} />
      <QuickStats courses={courses} assignments={assignments} />
      <div className="grid grid-cols-5 gap-7">
        <div className="col-span-3">
          <CourseGrid courses={courses} />
        </div>
        <div className="col-span-2">
          <UpcomingDeadlines assignments={assignments} />
        </div>
      </div>
    </div>
  );
}
