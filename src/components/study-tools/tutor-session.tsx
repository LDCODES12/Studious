"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { formatDistanceToNow } from "date-fns";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Send, ArrowLeft, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";
import Link from "next/link";
import type { StudyTargetEvidence } from "@/lib/study-targets";
import {
  getImportableCandidate,
  summarizeStudyTargetEvidence,
} from "@/lib/study-target-presenters";
import {
  buildTutorConversationPreview,
  buildTutorConversationTitle,
  extractTextFromMessageParts,
  type TutorConversationMessageMetadata,
  type TutorConversationSummary,
} from "@/lib/tutor-conversations";

interface TutorSessionProps {
  activeConversationId?: string;
  conversationSummaries: TutorConversationSummary[];
  courseId?: string;
  courseName?: string;
  courseColor?: string;
  draftKey: string;
  initialMessages: UIMessage[];
  initialPrompt?: string;
  topicName?: string;
  readings?: string[];
  targetEvidence?: StudyTargetEvidence;
}

interface TutorRouteContext {
  conversationId?: string;
  draft?: string;
  courseId?: string;
  courseName?: string;
  courseColor?: string;
  topicName?: string;
  readings?: string[];
  targetEvidence?: StudyTargetEvidence;
}

function buildTutorHref({
  conversationId,
  draft,
  courseId,
  courseName,
  courseColor,
  topicName,
  readings,
  targetEvidence,
}: TutorRouteContext): string {
  const params = new URLSearchParams();

  if (conversationId) params.set("conversationId", conversationId);
  if (draft) params.set("draft", draft);
  if (courseId) params.set("courseId", courseId);
  if (courseName) params.set("courseName", courseName);
  if (courseColor) params.set("courseColor", courseColor);
  if (topicName) params.set("topic", topicName);
  if (readings && readings.length > 0) params.set("readings", readings.join("|||"));
  if (targetEvidence) params.set("evidence", JSON.stringify(targetEvidence));

  const query = params.toString();
  return query ? `/study-tools/tutor?${query}` : "/study-tools/tutor";
}

function formatConversationAge(isoDate: string): string {
  try {
    return formatDistanceToNow(new Date(isoDate), { addSuffix: true });
  } catch {
    return "recently";
  }
}

export function TutorSession({
  activeConversationId,
  conversationSummaries,
  courseId,
  courseName,
  courseColor,
  draftKey,
  initialMessages,
  initialPrompt,
  topicName,
  readings,
  targetEvidence,
}: TutorSessionProps) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [candidateState, setCandidateState] = useState(targetEvidence?.candidates ?? []);
  const [conversationCards, setConversationCards] = useState(conversationSummaries);
  const [requestingCandidateId, setRequestingCandidateId] = useState<string | null>(null);

  const colors = courseColor ? courseColors[courseColor] : null;
  const evidenceForDisplay = targetEvidence
    ? { ...targetEvidence, candidates: candidateState }
    : undefined;
  const evidenceLines = evidenceForDisplay
    ? summarizeStudyTargetEvidence(evidenceForDisplay)
    : [];
  const importCandidate = evidenceForDisplay
    ? getImportableCandidate(evidenceForDisplay)
    : null;
  const autoStartMessage = initialPrompt ?? (topicName ? `I want to study: ${topicName}` : undefined);
  const chatId = activeConversationId ?? `tutor-draft:${draftKey}`;

  const { messages, sendMessage, status } = useChat({
    id: chatId,
    messages: initialMessages,
    onFinish: ({ message, messages: allMessages, isAbort, isDisconnect, isError }) => {
      if (isAbort || isDisconnect || isError) return;

      const metadata = (message.metadata ?? {}) as TutorConversationMessageMetadata;
      const conversationId = metadata.conversationId ?? activeConversationId;
      if (!conversationId) return;

      const assistantText = extractTextFromMessageParts(
        message.parts as Array<{ type?: string; text?: string }>
      ).trim();
      const firstUserText = allMessages.find((entry) => entry.role === "user")
        ? extractTextFromMessageParts(
            allMessages.find((entry) => entry.role === "user")!.parts as Array<{
              type?: string;
              text?: string;
            }>
          )
        : "";
      const title =
        conversationCards.find((conversation) => conversation.id === conversationId)?.title ??
        buildTutorConversationTitle({
          topicName,
          firstUserText,
        });
      const preview = buildTutorConversationPreview({
        latestAssistantText: assistantText,
        latestUserText: extractTextFromMessageParts(
          [...allMessages]
            .reverse()
            .find((entry) => entry.role === "user")
            ?.parts as Array<{ type?: string; text?: string }> | undefined
        ),
        topicName,
      });
      const timestamp = new Date().toISOString();

      setConversationCards((prev) => {
        const nextSummary: TutorConversationSummary = {
          id: conversationId,
          courseId,
          courseName,
          courseColor,
          topicName,
          title,
          preview,
          readings: readings ?? [],
          createdAt:
            prev.find((conversation) => conversation.id === conversationId)?.createdAt ??
            timestamp,
          updatedAt: timestamp,
          lastMessageAt: timestamp,
        };

        const others = prev.filter((conversation) => conversation.id !== conversationId);
        return [nextSummary, ...others];
      });

      if (!activeConversationId && metadata.conversationId) {
        router.replace(
          buildTutorHref({
            conversationId: metadata.conversationId,
            courseId,
            courseName,
            courseColor,
            topicName,
            readings,
            targetEvidence,
          })
        );
      }
    },
    transport: new DefaultChatTransport({
      api: "/api/tutor",
      body: {
        ...(activeConversationId ? { conversationId: activeConversationId } : {}),
        ...(courseId ? { courseId } : {}),
        ...(topicName ? { topicName } : {}),
        ...(readings && readings.length > 0 ? { readings } : {}),
        ...(targetEvidence ? { targetEvidence } : {}),
      },
      prepareSendMessagesRequest: ({ messages: msgs, body }) => {
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        const metadata = (lastAssistant?.metadata as TutorConversationMessageMetadata | undefined) ?? {};
        return {
          body: {
            ...body,
            messages: msgs,
            ...(metadata.responseId ? { previousResponseId: metadata.responseId } : {}),
          },
        };
      },
    }),
  });

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const autoStartedChatIdRef = useRef<string | null>(null);
  const isLoading = status === "streaming" || status === "submitted";
  const hasStarted = messages.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setCandidateState(targetEvidence?.candidates ?? []);
  }, [targetEvidence]);

  useEffect(() => {
    setConversationCards(conversationSummaries);
  }, [conversationSummaries]);

  useEffect(() => {
    if (!autoStartMessage || initialMessages.length > 0) return;
    if (autoStartedChatIdRef.current === chatId) return;

    autoStartedChatIdRef.current = chatId;
    sendMessage({ text: autoStartMessage });
  }, [autoStartMessage, chatId, initialMessages.length, sendMessage]);

  function handleSubmit() {
    if (!input.trim() || isLoading) return;

    sendMessage({ text: input.trim() });
    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleRequestCandidate() {
    if (!courseId || !importCandidate || requestingCandidateId) return;

    setRequestingCandidateId(importCandidate.id);
    try {
      const res = await fetch(
        `/api/courses/${courseId}/materials/candidates/${importCandidate.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requested: true }),
        }
      );

      if (res.ok) {
        setCandidateState((prev) =>
          prev.map((candidate) =>
            candidate.id === importCandidate.id
              ? { ...candidate, requested: true }
              : candidate
          )
        );
      }
    } finally {
      setRequestingCandidateId(null);
    }
  }

  function handleStartNewConversation() {
    router.push(
      buildTutorHref({
        courseId,
        courseName,
        courseColor,
        draft: `${Date.now()}`,
        topicName,
        readings,
        targetEvidence,
      })
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 pb-4">
        <Link
          href="/study-tools"
          className="mb-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Study Tools
        </Link>

        {(topicName || courseName) && (
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex items-center gap-2">
              {colors && (
                <span className={cn("h-2 w-2 shrink-0 rounded-full", colors.dot)} />
              )}
              {courseName && (
                <span className="text-[12px] font-medium text-muted-foreground">
                  {courseName}
                </span>
              )}
            </div>
            {topicName && <p className="mt-1 text-[14px] font-medium">{topicName}</p>}
            {readings && readings.length > 0 && (
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                {readings.join(", ")}
              </p>
            )}
            {evidenceLines.length > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {evidenceLines.join(" • ")}
              </p>
            )}
            {courseId && importCandidate && !evidenceForDisplay?.materials.length && (
              <div className="mt-3 rounded-md border border-dashed border-border px-3 py-2">
                <p className="text-[11px] text-muted-foreground">
                  Best supporting Canvas file: {importCandidate.fileName}
                </p>
                <button
                  onClick={handleRequestCandidate}
                  disabled={!!requestingCandidateId}
                  className="mt-2 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  {requestingCandidateId === importCandidate.id
                    ? "Adding..."
                    : "Add top Canvas file"}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-medium text-muted-foreground">
                Saved conversations
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                Come back to any thread or start a fresh one for the same topic.
              </p>
            </div>
            <button
              onClick={handleStartNewConversation}
              disabled={isLoading}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              New conversation
            </button>
          </div>

          {conversationCards.length > 0 ? (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {conversationCards.map((conversation) => {
                const isActive = conversation.id === activeConversationId;
                return (
                  <button
                    key={conversation.id}
                    onClick={() =>
                      router.push(
                        buildTutorHref({
                          conversationId: conversation.id,
                        })
                      )
                    }
                    className={cn(
                      "rounded-md border px-3 py-2 text-left transition-colors",
                      isActive
                        ? "border-primary/40 bg-primary/5"
                        : "border-border hover:bg-muted/60"
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        {conversation.courseName && (
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {conversation.courseName}
                          </p>
                        )}
                        <p className="truncate text-[13px] font-medium">
                          {conversation.title}
                        </p>
                      </div>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatConversationAge(conversation.lastMessageAt)}
                      </span>
                    </div>
                    {conversation.preview && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                        {conversation.preview}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 text-[11px] text-muted-foreground">
              This tutor thread will stick around once the first exchange lands.
            </p>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto pb-4">
        {!hasStarted && !autoStartMessage && (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              Describe what you want to study and your tutor will guide you through it with questions.
            </p>
          </div>
        )}

        {messages.map((message) => {
          const role = message.role;
          const content = extractTextFromMessageParts(
            message.parts as Array<{ type?: string; text?: string }>
          );

          if (role === "user") {
            if (topicName && content === `I want to study: ${topicName}`) {
              return null;
            }

            return (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">
                  {content}
                </div>
              </div>
            );
          }

          return (
            <div key={message.id} className="flex justify-start gap-3">
              <div className="mt-1 shrink-0">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                  <span className="text-[13px]">T</span>
                </div>
              </div>
              <div className="max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {content}
              </div>
            </div>
          );
        })}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start gap-3">
            <div className="mt-1 shrink-0">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                <span className="text-[13px]">T</span>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">Thinking...</div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border pt-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hasStarted ? "Type your answer..." : "Describe what you want to study..."}
            disabled={isLoading}
            rows={1}
            className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            style={{ maxHeight: "120px", overflowY: "auto" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${el.scrollHeight}px`;
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={isLoading || !input.trim()}
            className="rounded-md bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
