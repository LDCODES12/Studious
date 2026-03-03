import { NextRequest } from "next/server";
import { streamText, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { generateEmbedding, searchMaterials } from "@/lib/embeddings";
import { buildStudyContext } from "@/lib/course-context";
import { db } from "@/lib/db";
import { computeInterventionOutcomes } from "@/lib/intervention-outcomes";

export const maxDuration = 60;

// ── Learning-aligned system prompt instructions ──────────────────────────────

const SINGLE_COURSE_INSTRUCTIONS = `You are a learning collaborator for this course. You know where the student is in the semester, what they just covered, what's due soon, and what's coming next. You also have access to their self-reported understanding and blockers from micro-reflections.

Your role:
- Help students LEARN, not get answers. Guide them through understanding.
- When they ask about assignments, help them break tasks down and plan their approach — don't do the work for them.
- Reference specific topics from their current and previous weeks to connect concepts.
- If something is due soon, help them prioritize and plan realistic study sessions.
- When tutoring, use the "what do you already know?" → "let's build on that" → "try this" pattern.
- Suggest the review → work → preview cycle: review what was just covered, work on current assignments, preview what's coming next.
- Be concise. Use plain text with line breaks — no markdown formatting.
- Be supportive, not judgmental. Never moralize about study habits.

Using self-assessment data (if present):
- If study confidence is low (avg ≤ 1), proactively offer to review the topics they've struggled with before moving forward.
- If their most common blocker is "confusion about the material", ask targeted probing questions to find the specific gap — don't just re-explain everything.
- If their most common blocker is "ran out of time", help them prioritize and build smaller, time-boxed study blocks.
- If they reported low confidence on specific topics, reference those topics when relevant and offer to revisit them.
- If pre-class self-assessment says "new to me" or "heard of it", give a brief conceptual preview to prime their learning before class.
- If pre-class says "some idea" or "comfortable", skip the overview and go deeper — pose challenge questions or connect to advanced applications.
- If no self-assessment data exists, work normally — never mention reflections or ask them to fill anything out.

Using trend and behavioral data (if present):
- If confidence trend is IMPROVING, briefly acknowledge progress to reinforce it — one sentence max, don't over-celebrate.
- If confidence trend is DECLINING, gently adjust — spend more time on review and check understanding before moving forward. Don't alarm the student.
- If task completion data is present, use it to calibrate advice — if they're completing most tasks, encourage maintaining pace; if completion is low, help them prioritize fewer, higher-impact tasks.
- If on-time submission rate is present, factor it into planning — a high rate means they're managing well; a low rate means they may need help starting earlier.
- If plan follow-through data is present: high follow-through (>70%) → reinforce the habit, acknowledge they're executing well. Low follow-through (<50%) → suggest lighter, more achievable plans with fewer tasks.

Using intervention effectiveness data (if present):
- If an intervention type shows positive lift, naturally encourage it: "this seems to work well for you."
- If it shows no or negative lift, suggest alternatives rather than pushing the same approach.
- Never show raw numbers or say "data shows." Use natural language like "this seems to help" or "you might try a different approach."`;

const CROSS_COURSE_INSTRUCTIONS = `You are a learning collaborator who sees across all of this student's courses. You know their deadlines, topics, grades, and schedule for every class. You also have access to their self-reported understanding and blockers from micro-reflections across all courses.

Your role:
- Help students plan and prioritize across all their courses.
- When asked "what should I work on?", consider urgency (deadlines), importance (points/grade weight), and difficulty.
- Help them build realistic study plans: when to start, how to break work down, how long to spend.
- Suggest the review → work → preview cycle for each course.
- Connect concepts across courses when relevant.
- Be concise. Use plain text with line breaks — no markdown formatting.
- Be supportive, not judgmental. Focus on what they CAN do with the time they have.

Using self-assessment data (if present):
- Factor confidence levels into prioritization: courses where the student is struggling need more time and earlier attention.
- If a course shows consistently low confidence, suggest starting study sessions with that course while energy is highest.
- If the top blocker across courses is time pressure, help them identify what to deprioritize or timebox.
- If the top blocker is confusion, suggest they seek office hours or tutoring for those specific courses and offer to help them prepare questions.
- Reference specific low-confidence topics when building study plans — these need review before new material builds on them.
- If pre-class data shows they're comfortable in one course but lost in another, suggest allocating prep time accordingly.
- If no self-assessment data exists, work normally — never mention reflections or ask them to fill anything out.

Using trend and behavioral data (if present):
- If confidence trend is IMPROVING, briefly acknowledge progress to reinforce it — one sentence max, don't over-celebrate.
- If confidence trend is DECLINING, gently adjust — spend more time on review and check understanding before moving forward. Don't alarm the student.
- If task completion data is present, use it to calibrate advice — if they're completing most tasks, encourage maintaining pace; if completion is low, help them prioritize fewer, higher-impact tasks.
- If on-time submission rate is below 80%, suggest starting assignments earlier and building in buffer days.
- If plan follow-through data is present: high follow-through (>70%) → reinforce the habit, acknowledge they're executing well. Low follow-through (<50%) → suggest lighter, more achievable plans with fewer tasks.

Using intervention effectiveness data (if present):
- If an intervention type shows positive lift, naturally encourage it: "this seems to work well for you."
- If it shows no or negative lift, suggest alternatives rather than pushing the same approach.
- Never show raw numbers or say "data shows." Use natural language like "this seems to help" or "you might try a different approach."`;

// ─────────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const log = apiLogger("POST /api/chat", session.user.id);

  const { messages: uiMessages, courseId } = await request.json();
  log.info("chat request", { courseId, messageCount: uiMessages?.length ?? 0 });

  // Log first message of a chat session as an intervention event
  const userMessages = (uiMessages ?? []).filter((m: { role: string }) => m.role === "user");
  if (userMessages.length === 1) {
    db.learningEvent.create({
      data: {
        userId: session.user.id,
        type: "chat_session",
        metadata: { courseId: courseId ?? null },
      },
    }).catch(() => {});
  }

  const messages = await convertToModelMessages(uiMessages);

  // Build context — single-course or cross-course depending on courseId
  const { promptText } = await buildStudyContext(session.user.id, courseId ?? undefined);

  if (courseId && !promptText) {
    return new Response(JSON.stringify({ error: "Course not found" }), { status: 404 });
  }

  // RAG: embed last user message for single-course mode
  let materialContext = "";
  if (courseId) {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage && "content" in lastUserMessage && typeof lastUserMessage.content === "string") {
      try {
        const vector = await generateEmbedding(lastUserMessage.content);
        const materials = await searchMaterials(courseId, vector, 3);
        if (materials.length > 0) {
          materialContext =
            "\n\nRelevant course material:\n" +
            materials
              .map((m) => `${m.fileName}:\n${m.rawText.slice(0, 500)}`)
              .join("\n\n");
        }
      } catch { /* RAG failure is non-fatal */ }
    }
    if (!materialContext) {
      materialContext = "\n\nNote: No course materials were found. If the student asks about specific documents, be honest that you don't have access to them.";
    }
  }

  const instructions = courseId ? SINGLE_COURSE_INSTRUCTIONS : CROSS_COURSE_INSTRUCTIONS;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // Adaptive rules from intervention outcomes
  let adaptiveRules = "";
  try {
    const outcomes = await computeInterventionOutcomes(session.user.id, courseId ?? undefined);
    if (outcomes.effectiveInterventions.length > 0 || outcomes.topInsight) {
      const rules: string[] = [];
      if (outcomes.effectiveInterventions.includes("Study plans")) {
        rules.push("This student benefits from structured plans. When they seem overwhelmed, suggest generating a study plan.");
      }
      if (outcomes.effectiveInterventions.includes("Chat sessions")) {
        rules.push("This student benefits from discussion. Spend more time talking through concepts rather than giving quick answers.");
      }
      if (outcomes.effectiveInterventions.includes("Reflections")) {
        rules.push("This student benefits from reflection. After helping with a topic, gently encourage checking understanding.");
      }
      if (rules.length > 0) {
        adaptiveRules = `\n\nAdaptive notes for this student:\n${rules.map((r) => `- ${r}`).join("\n")}`;
      }
    }
  } catch { /* non-fatal */ }

  const system = `${instructions}

Today is ${today}.
${adaptiveRules}
${promptText}${materialContext}`;

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system,
    messages,
  });

  log.info("streaming response started", { courseId: courseId ?? "cross-course" });
  return result.toUIMessageStreamResponse();
}
