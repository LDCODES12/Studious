import type { Prisma } from "@prisma/client";
import type { UIMessage } from "ai";
import type { StudyTargetEvidence } from "@/lib/study-targets";

export interface TutorConversationSummary {
  id: string;
  courseId?: string;
  courseName?: string;
  courseColor?: string;
  topicName?: string;
  title: string;
  preview: string | null;
  readings: string[];
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface TutorConversationMessageMetadata {
  responseId?: string;
  conversationId?: string;
  title?: string;
  preview?: string | null;
  updatedAt?: string;
}

type TutorConversationSummarySource = {
  id: string;
  courseId: string | null;
  topicName: string | null;
  title: string;
  preview: string | null;
  readings: string[];
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  course: { name: string; color: string } | null;
};

type TutorConversationDetailSource = TutorConversationSummarySource & {
  targetEvidence: Prisma.JsonValue | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    responseId: string | null;
  }>;
};

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function extractTextFromMessageParts(
  parts: Array<{ type?: string; text?: string }> | undefined
): string {
  return (parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

export function buildTutorConversationTitle({
  topicName,
  firstUserText,
}: {
  topicName?: string | null;
  firstUserText?: string | null;
}): string {
  if (topicName) return truncateText(topicName, 80);

  const cleaned = collapseWhitespace(firstUserText ?? "");
  if (!cleaned) return "Tutor conversation";

  const fromTopicPrompt = cleaned.match(/^I want to study:\s*(.+)$/i);
  if (fromTopicPrompt?.[1]) {
    return truncateText(fromTopicPrompt[1], 80);
  }

  return truncateText(cleaned, 80);
}

export function buildTutorConversationPreview({
  latestAssistantText,
  latestUserText,
  topicName,
}: {
  latestAssistantText?: string | null;
  latestUserText?: string | null;
  topicName?: string | null;
}): string | null {
  const previewSource = [
    collapseWhitespace(latestAssistantText ?? ""),
    collapseWhitespace(latestUserText ?? ""),
    collapseWhitespace(topicName ?? ""),
  ].find(Boolean);

  if (!previewSource) return null;
  return truncateText(previewSource, 140);
}

export function serializeTutorEvidence(
  evidence: StudyTargetEvidence | undefined
): Prisma.InputJsonValue | undefined {
  if (!evidence) return undefined;
  return JSON.parse(JSON.stringify(evidence)) as Prisma.InputJsonValue;
}

export function parseTutorEvidence(
  evidence: Prisma.JsonValue | null | undefined
): StudyTargetEvidence | undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  return evidence as unknown as StudyTargetEvidence;
}

export function buildTutorConversationSummary(
  conversation: TutorConversationSummarySource
): TutorConversationSummary {
  return {
    id: conversation.id,
    courseId: conversation.courseId ?? undefined,
    courseName: conversation.course?.name ?? undefined,
    courseColor: conversation.course?.color ?? undefined,
    topicName: conversation.topicName ?? undefined,
    title: conversation.title,
    preview: conversation.preview,
    readings: conversation.readings,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt.toISOString(),
  };
}

export function buildTutorConversationDetail(conversation: TutorConversationDetailSource) {
  return {
    ...buildTutorConversationSummary(conversation),
    targetEvidence: parseTutorEvidence(conversation.targetEvidence),
    messages: conversation.messages.map((message) => {
      const metadata: TutorConversationMessageMetadata | undefined = message.responseId
        ? { responseId: message.responseId }
        : undefined;

      return {
        id: message.id,
        role: message.role as UIMessage["role"],
        parts: [{ type: "text" as const, text: message.content }],
        ...(metadata ? { metadata } : {}),
      } as UIMessage;
    }),
  };
}
