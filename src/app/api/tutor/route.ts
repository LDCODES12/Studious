import { NextRequest } from "next/server";
import { streamText, convertToModelMessages } from "ai";
import { modelConfig } from "@/lib/ai-models";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { buildStudyContext } from "@/lib/course-context";
import { db } from "@/lib/db";
import { computeInterventionOutcomes } from "@/lib/intervention-outcomes";
import type { StudyTargetEvidence } from "@/lib/study-targets";
import { extractTextFromParts, sanitizeUiMessages } from "@/lib/ui-message-utils";
import { formatStudyEvidenceForPrompt, resolveStudyEvidence } from "@/lib/source-aware-evidence";

export const maxDuration = 60;

const SOCRATIC_INSTRUCTIONS = `You are a Socratic tutor. Your job is to help the student discover understanding through questions — NOT by explaining.

Core rules:
- NEVER give a direct answer or full explanation upfront. Ask a question instead.
- Ask ONE question at a time. Wait for their response before continuing.
- Start by asking what they already know about the topic — meet them where they are.
- If they're wrong, don't say "wrong." Ask a follow-up question that gently exposes the gap in their reasoning.
- If they're stuck, give a small hint (a nudge, not the answer) and ask again.
- If they've genuinely tried 3+ times and are still stuck, give a brief explanation (2-3 sentences max), then immediately ask a follow-up question to check they understood.
- Reference their course materials and readings when relevant — "Your textbook covers this in Chapter 5" etc.
- Prefer canonical materials for clean explanations and use lecture transcripts for instructor emphasis, examples, clarifications, and review-session details.
- If the student asks what happened in lecture or what the professor emphasized, transcript evidence may be the primary source for that part of the answer.
- Keep your responses SHORT. 1-3 sentences, usually ending with a question.
- Be warm, encouraging, and patient. Never condescending. Celebrate when they get it.
- Use plain text with line breaks — no markdown formatting.

Questioning patterns:
- "What do you think happens when...?"
- "Can you explain why...?"
- "What's the relationship between X and Y?"
- "If that were true, what would you expect to see?"
- "You're close — what about [specific aspect]?"
- "Good! Now can you apply that to...?"

Using student data (if present):
- If confidence is low on this topic, start with simpler foundational questions and build up.
- If they reported "confused by the material" as a blocker, be extra patient with hints.
- If confidence is high, skip basics and go straight to application or edge-case questions.
- If no data exists, start with an open "what do you know about X?" question.`;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const log = apiLogger("POST /api/tutor", session.user.id);

  const body = await request.json() as {
    messages?: unknown;
    courseId?: string;
    topicName?: string;
    targetEvidence?: StudyTargetEvidence;
    previousResponseId?: string;
  };
  const uiMessages = sanitizeUiMessages(body.messages);
  const {
    courseId,
    topicName,
    targetEvidence,
    previousResponseId,
  } = body;
  log.info("tutor request", {
    courseId,
    topicName,
    evidenceSource: targetEvidence?.source ?? null,
    hasPrevResponse: !!previousResponseId,
    messageCount: uiMessages?.length ?? 0,
  });

  // Log first message as a tutoring session event
  const userMessages = (uiMessages ?? []).filter((m: { role: string }) => m.role === "user");
  if (userMessages.length === 1) {
    db.learningEvent.create({
      data: {
        userId: session.user.id,
        type: "tutor_session",
        metadata: JSON.parse(
          JSON.stringify({
            courseId: courseId ?? null,
            topicName: topicName ?? null,
            targetSource: targetEvidence?.source ?? null,
          })
        ),
      },
    }).catch(() => {});
  }

  // Build course context
  const { promptText } = await buildStudyContext(session.user.id, courseId ?? undefined);

  let materialContext = "";
  if (courseId) {
    try {
      const lastUserMsg = [...uiMessages].reverse().find((m) => m.role === "user");
      const lastUserText = extractTextFromParts(lastUserMsg?.parts);
      const evidence = await resolveStudyEvidence({
        courseId,
        topicName,
        questionText: lastUserText,
        targetEvidence,
      });
      materialContext = `\n\nSource-aware study evidence:\n${formatStudyEvidenceForPrompt(evidence)}`;
    } catch {
      materialContext = "\n\nNote: Could not search course materials. If the student asks about specific documents, be honest that you cannot access them right now.";
    }
  }

  // Adaptive rules
  let adaptiveRules = "";
  try {
    const outcomes = await computeInterventionOutcomes(session.user.id, courseId ?? undefined);
    if (outcomes.effectiveInterventions.length > 0) {
      const rules: string[] = [];
      if (outcomes.effectiveInterventions.includes("Reflections")) {
        rules.push("This student benefits from self-reflection. After key insights, ask them to summarize what they learned.");
      }
      if (outcomes.effectiveInterventions.includes("Study plans")) {
        rules.push("This student responds well to structure. When wrapping up, suggest what to study next.");
      }
      if (rules.length > 0) {
        adaptiveRules = `\n\nAdaptive notes:\n${rules.map((r) => `- ${r}`).join("\n")}`;
      }
    }
  } catch { /* non-fatal */ }

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const topicContext = topicName
    ? `\n\nThe student wants to study: "${topicName}". Start by asking what they already know about this topic.`
    : "";

  const system = `${SOCRATIC_INSTRUCTIONS}

Today is ${today}.${topicContext}${adaptiveRules}
${promptText}${materialContext}`;

  // ── Responses API conversation chaining ──────────────────────────────────
  const config = modelConfig("high");

  const result = previousResponseId
    ? (() => {
        const lastMsg = uiMessages[uiMessages.length - 1];
        const lastText = extractTextFromParts(lastMsg?.parts);
        log.info("streaming tutor continuation", { previousResponseId });
        return streamText({
          ...config,
          prompt: lastText,
          providerOptions: {
            openai: {
              ...config.providerOptions.openai,
              previousResponseId,
              instructions: system,
            },
          },
        });
      })()
    : await (async () => {
        log.info("streaming new tutor session", { courseId: courseId ?? "none", topicName: topicName ?? "free-form" });
        const messages = await convertToModelMessages(uiMessages);
        return streamText({ ...config, system, messages });
      })();

  return result.toUIMessageStreamResponse({
    messageMetadata: ({ part }) => {
      if (part.type === "finish-step" && "providerMetadata" in part) {
        const rid = (part.providerMetadata?.openai as { responseId?: string } | undefined)?.responseId;
        if (rid) return { responseId: rid };
      }
      return undefined;
    },
  });
}
