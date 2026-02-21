import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { TasksView } from "@/components/tasks/tasks-view";

export default async function TasksPage() {
  const session = await auth();
  if (!session?.user?.id) notFound();

  const cookieStore = await cookies();
  const googleConnected = !!cookieStore.get("google_tokens");

  const [tasks, courses] = await Promise.all([
    db.task.findMany({
      where: { userId: session.user.id },
      include: {
        course: { select: { id: true, name: true, shortName: true, color: true } },
      },
      orderBy: [{ completed: "asc" }, { dueDate: "asc" }],
    }),
    db.course.findMany({
      where: { userId: session.user.id },
      select: { id: true, name: true, shortName: true, color: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // Serialize for client component
  const serializedTasks = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    dueDate: t.dueDate,
    dueTime: t.dueTime,
    priority: t.priority,
    completed: t.completed,
    source: t.source,
    sourceType: t.sourceType,
    googleEventId: t.googleEventId,
    course: t.course,
  }));

  return (
    <div className="mx-auto max-w-[1200px]">
      <h1 className="mb-6 text-lg font-semibold">Tasks</h1>
      <TasksView
        initialTasks={serializedTasks}
        courses={courses}
        googleConnected={googleConnected}
      />
    </div>
  );
}
