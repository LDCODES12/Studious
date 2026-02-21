import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { GreetingBanner } from "@/components/dashboard/greeting-banner";
import { QuickStats } from "@/components/dashboard/quick-stats";
import { CourseGrid } from "@/components/dashboard/course-grid";
import { UpcomingDeadlines } from "@/components/dashboard/upcoming-deadlines";
import { TodayTasks } from "@/components/dashboard/today-tasks";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;

  const today = new Date().toISOString().slice(0, 10);
  const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [courses, tasks] = await Promise.all([
    userId
      ? db.course.findMany({
          where: { userId },
          include: { assignments: { orderBy: { dueDate: "asc" } } },
          orderBy: { createdAt: "asc" },
        })
      : [],
    userId
      ? db.task.findMany({
          where: {
            userId,
            completed: false,
            dueDate: { gte: today, lte: threeDaysFromNow },
          },
          include: {
            course: { select: { shortName: true, color: true } },
          },
          orderBy: { dueDate: "asc" },
          take: 6,
        })
      : [],
  ]);

  const assignments = (courses as Awaited<typeof courses>).flatMap((c) =>
    c.assignments.map((a) => ({ ...a, course: c }))
  );

  const dashboardTasks = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    dueDate: t.dueDate,
    completed: t.completed,
    priority: t.priority,
    source: t.source,
    course: t.course,
  }));

  return (
    <div className="mx-auto max-w-[1200px] space-y-7">
      <GreetingBanner name={session?.user?.name ?? "there"} />
      <QuickStats courses={courses} assignments={assignments} />
      <div className="grid grid-cols-5 gap-7">
        <div className="col-span-3">
          <CourseGrid courses={courses} />
        </div>
        <div className="col-span-2 space-y-7">
          <TodayTasks initialTasks={dashboardTasks} />
          <UpcomingDeadlines assignments={assignments} />
        </div>
      </div>
    </div>
  );
}
