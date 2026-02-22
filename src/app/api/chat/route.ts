import { NextRequest } from "next/server";
import { streamText, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateEmbedding, searchMaterials } from "@/lib/embeddings";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const { messages: uiMessages, courseId } = await request.json();

  // Convert UI messages to model messages (async in v6)
  const messages = await convertToModelMessages(uiMessages);

  // Verify the course belongs to this user
  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
    select: {
      name: true,
      currentGrade: true,
      currentScore: true,
      topics: {
        orderBy: { weekNumber: "asc" },
        select: { weekNumber: true, weekLabel: true, startDate: true, topics: true },
      },
      assignments: {
        where: {
          status: { notIn: ["submitted", "graded"] },
          dueDate: { gte: new Date().toISOString().split("T")[0] },
          omitFromFinalGrade: false,
        },
        orderBy: { dueDate: "asc" },
        take: 10,
        select: { title: true, type: true, dueDate: true, pointsPossible: true },
      },
    },
  });

  if (!course) {
    return new Response(JSON.stringify({ error: "Course not found" }), { status: 404 });
  }

  // RAG: embed the last user message and retrieve relevant materials
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  let materialContext = "";
  if (lastUserMessage && "content" in lastUserMessage && typeof lastUserMessage.content === "string") {
    try {
      const vector = await generateEmbedding(lastUserMessage.content);
      const materials = await searchMaterials(courseId, vector, 3);
      if (materials.length > 0) {
        materialContext =
          "\nRelevant course material:\n" +
          materials
            .map((m) => `${m.fileName}:\n${m.rawText.slice(0, 500)}`)
            .join("\n\n");
      }
    } catch { /* RAG failure is non-fatal */ }
  }

  // Build schedule section
  const scheduleLines = course.topics
    .map((t) => {
      const label = t.startDate ? `Week ${t.weekNumber} (${t.startDate})` : `Week ${t.weekNumber}`;
      return `${label}: ${t.topics.join(", ")}`;
    })
    .join("\n");

  // Build upcoming assignments section
  const assignmentLines = course.assignments
    .map((a) => {
      const pts = a.pointsPossible ? ` — ${a.pointsPossible}pts` : "";
      return `- ${a.title} (${a.type}) — due ${a.dueDate}${pts}`;
    })
    .join("\n");

  const gradeInfo =
    course.currentScore != null
      ? `${course.currentScore}%${course.currentGrade ? ` (${course.currentGrade})` : ""}`
      : course.currentGrade ?? "not available";

  const system = `You are a personal study assistant for ${course.name}.
Current grade: ${gradeInfo}

Course schedule (week by week):
${scheduleLines || "No schedule available yet."}

Upcoming assignments:
${assignmentLines || "No upcoming assignments."}
${materialContext}
Help the student understand concepts, explain topics, generate practice problems, and create study plans. Be specific to their actual course content. Be concise and use plain text with line breaks — no markdown formatting.`;

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system,
    messages,
  });

  return result.toUIMessageStreamResponse();
}
