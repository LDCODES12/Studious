import { db } from "@/lib/db";

interface TaskTemplate {
  sourceType: string;
  prefix: string;
  leadDays: number;
  priority: string;
}

const TEMPLATES: Record<string, TaskTemplate> = {
  exam:       { sourceType: "study",    prefix: "Study for",    leadDays: 3, priority: "high" },
  project:    { sourceType: "start",    prefix: "Start",        leadDays: 7, priority: "high" },
  quiz:       { sourceType: "review",   prefix: "Review for",   leadDays: 1, priority: "medium" },
  assignment: { sourceType: "complete", prefix: "Complete",      leadDays: 2, priority: "medium" },
  lab:        { sourceType: "complete", prefix: "Complete",      leadDays: 2, priority: "medium" },
  reading:    { sourceType: "complete", prefix: "Complete",      leadDays: 1, priority: "low" },
};

/**
 * Auto-generate smart tasks from a user's Canvas assignments.
 * Idempotent — uses @@unique([assignmentId, sourceType]) to avoid duplicates.
 * Returns the number of tasks created.
 */
export async function generateTasksForUser(userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  const assignments = await db.assignment.findMany({
    where: {
      course: { userId },
      dueDate: { not: null, gte: today },
    },
    select: {
      id: true,
      title: true,
      type: true,
      dueDate: true,
      courseId: true,
    },
  });

  let created = 0;

  for (const assignment of assignments) {
    const template = TEMPLATES[assignment.type] ?? TEMPLATES["assignment"];

    // Calculate task due date (leadDays before assignment due date)
    const assignmentDate = new Date(assignment.dueDate! + "T00:00:00");
    const taskDate = new Date(assignmentDate);
    taskDate.setDate(taskDate.getDate() - template.leadDays);

    // Don't create tasks in the past — clamp to today
    const taskDueDate = taskDate.toISOString().slice(0, 10) < today
      ? today
      : taskDate.toISOString().slice(0, 10);

    try {
      await db.task.create({
        data: {
          userId,
          courseId: assignment.courseId,
          assignmentId: assignment.id,
          title: `${template.prefix} ${assignment.title}`,
          dueDate: taskDueDate,
          priority: template.priority,
          source: "auto",
          sourceType: template.sourceType,
        },
      });
      created++;
    } catch (e: unknown) {
      // @@unique constraint violation = task already exists, skip
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") continue;
      throw e;
    }
  }

  return created;
}
