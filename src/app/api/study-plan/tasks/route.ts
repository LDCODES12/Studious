import { NextRequest } from "next/server";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { format, addDays } from "date-fns";

export const maxDuration = 30;

interface ExtractedTask {
  title: string;
  courseName?: string;
  dueDate?: string;
  priority?: "low" | "medium" | "high";
}

/**
 * Extracts structured tasks from a study plan and creates Task records.
 * Tasks get source: "plan" for follow-through tracking.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const log = apiLogger("POST /api/study-plan/tasks", session.user.id);

  const { planText } = await request.json();
  if (!planText || typeof planText !== "string") {
    return Response.json({ error: "planText is required" }, { status: 400 });
  }

  // Load user's courses for fuzzy matching
  const courses = await db.course.findMany({
    where: { userId: session.user.id },
    select: { id: true, name: true, shortName: true },
  });

  const today = format(new Date(), "yyyy-MM-dd");
  const weekFromNow = format(addDays(new Date(), 7), "yyyy-MM-dd");

  // Extract structured tasks from plan text
  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    system: `You extract actionable study tasks from a study plan. Return valid JSON only.

Available courses: ${courses.map((c) => c.shortName ?? c.name).join(", ")}
Today's date: ${today}

Return a JSON object with a "tasks" array. Each task has:
- "title": concise task title (e.g., "Review Chapter 5 notes", "Start essay outline")
- "courseName": the course name from the available courses list (exact match preferred)
- "dueDate": YYYY-MM-DD format, based on when the plan says to do it (default to "${today}" if unclear)
- "priority": "low", "medium", or "high" based on urgency/importance

Extract 3-8 tasks. Focus on concrete, actionable items — skip vague items like "take breaks" or "priorities summary". Each task should be something the student can check off.`,
    messages: [
      {
        role: "user",
        content: `Extract study tasks from this plan:\n\n${planText.slice(0, 3000)}`,
      },
    ],
  });

  let extracted: ExtractedTask[] = [];
  try {
    const parsed = JSON.parse(text);
    extracted = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    log.info("failed to parse extracted tasks", { text: text.slice(0, 200) });
    return Response.json({ error: "Failed to extract tasks" }, { status: 500 });
  }

  if (extracted.length === 0) {
    return Response.json({ tasks: [] });
  }

  // Fuzzy match course names to IDs
  function matchCourse(name?: string): string | null {
    if (!name) return null;
    const lower = name.toLowerCase();
    // Exact shortName match
    const exact = courses.find(
      (c) => c.shortName?.toLowerCase() === lower || c.name.toLowerCase() === lower
    );
    if (exact) return exact.id;
    // Substring match
    const partial = courses.find(
      (c) =>
        c.shortName?.toLowerCase().includes(lower) ||
        c.name.toLowerCase().includes(lower) ||
        lower.includes(c.shortName?.toLowerCase() ?? "") ||
        lower.includes(c.name.toLowerCase())
    );
    return partial?.id ?? null;
  }

  // Create tasks
  const createdTasks = await Promise.all(
    extracted.slice(0, 8).map(async (t) => {
      const courseId = matchCourse(t.courseName);
      const dueDate = t.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)
        ? t.dueDate
        : today;
      const priority = ["low", "medium", "high"].includes(t.priority ?? "")
        ? t.priority!
        : "medium";

      return db.task.create({
        data: {
          userId: session.user!.id!,
          title: t.title,
          courseId,
          dueDate,
          priority,
          source: "plan",
        },
        select: {
          id: true,
          title: true,
          courseId: true,
          dueDate: true,
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
