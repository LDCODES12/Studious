import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { format } from "date-fns";
import type { StudySession } from "@/lib/study-plan-engine";

export const maxDuration = 15;

/**
 * Creates tasks directly from the structured study plan — no AI extraction needed.
 * Each study session becomes a task with correct time and course linking.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const log = apiLogger("POST /api/study-plan/tasks", session.user.id);

  const { sessions } = await request.json();
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return Response.json({ error: "sessions array is required" }, { status: 400 });
  }

  // Filter to study sessions only
  const studySessions: StudySession[] = sessions.filter(
    (s: StudySession) => s.type === "study" && s.label
  );

  if (studySessions.length === 0) {
    return Response.json({ tasks: [] });
  }

  // Map priority from scores
  function getPriority(s: StudySession): "low" | "medium" | "high" {
    const score = s.item?.priorityScore ?? 0;
    if (score >= 4) return "high";
    if (score >= 2.5) return "medium";
    return "low";
  }

  const createdTasks = await Promise.all(
    studySessions.slice(0, 12).map(async (s) => {
      const startDate = new Date(s.start);
      const dueDate = format(startDate, "yyyy-MM-dd");
      const dueTime = format(startDate, "HH:mm");

      return db.task.create({
        data: {
          userId: session.user!.id!,
          title: s.label,
          courseId: s.item?.courseId ?? null,
          dueDate,
          dueTime,
          priority: getPriority(s),
          source: "plan",
          assignmentId: s.item?.assignmentId ?? null,
        },
        select: {
          id: true,
          title: true,
          courseId: true,
          dueDate: true,
          dueTime: true,
          priority: true,
          completed: true,
          source: true,
          course: { select: { shortName: true, color: true } },
        },
      });
    })
  );

  log.info("created plan tasks", { count: createdTasks.length });

  // Log as intervention event for outcome tracking
  db.learningEvent.create({
    data: {
      userId: session.user!.id!,
      type: "plan_tasks_created",
      metadata: {
        taskIds: createdTasks.map((t) => t.id),
        count: createdTasks.length,
      },
    },
  }).catch(() => {});

  return Response.json({ tasks: createdTasks });
}
