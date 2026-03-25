"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { Send, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";
import Link from "next/link";

interface TutorSessionProps {
  courseId?: string;
  courseName?: string;
  courseColor?: string;
  topicName?: string;
  readings?: string[];
}

export function TutorSession({
  courseId,
  courseName,
  courseColor,
  topicName,
  readings,
}: TutorSessionProps) {
  const [input, setInput] = useState("");
  const colors = courseColor ? courseColors[courseColor] : null;

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/tutor",
      body: {
        ...(courseId ? { courseId } : {}),
        ...(topicName ? { topicName } : {}),
      },
      prepareSendMessagesRequest: ({ messages: msgs, body }) => {
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        const rid = (lastAssistant?.metadata as { responseId?: string } | undefined)?.responseId;
        return { body: { ...body, ...(rid ? { previousResponseId: rid } : {}) } };
      },
    }),
  });

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isLoading = status === "streaming" || status === "submitted";
  const hasStarted = messages.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-start: send initial prompt when topic is provided
  const startedRef = useRef(false);
  useEffect(() => {
    if (topicName && !startedRef.current) {
      startedRef.current = true;
      sendMessage({
        text: `I want to study: ${topicName}`,
      });
    }
  }, [topicName, sendMessage]);

  function handleSubmit() {
    if (input.trim() && !isLoading) {
      sendMessage({ text: input });
      setInput("");
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // Free-form start
  function handleFreeStart() {
    if (input.trim() && !isLoading) {
      sendMessage({ text: input });
      setInput("");
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 pb-4">
        <Link
          href="/study-tools"
          className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="h-3 w-3" />
          Study Tools
        </Link>

        {topicName && (
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex items-center gap-2">
              {colors && (
                <span className={cn("h-2 w-2 rounded-full shrink-0", colors.dot)} />
              )}
              {courseName && (
                <span className="text-[12px] font-medium text-muted-foreground">
                  {courseName}
                </span>
              )}
            </div>
            <p className="mt-1 text-[14px] font-medium">{topicName}</p>
            {readings && readings.length > 0 && (
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                {readings.join(", ")}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {!hasStarted && !topicName && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4">
            <p className="text-sm text-muted-foreground">
              Describe what you want to study and your tutor will guide you through it with questions.
            </p>
          </div>
        )}

        {messages.map((m) => {
          const role = m.role;
          const content = m.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("");

          if (role === "user") {
            // Skip the auto-start message
            if (topicName && content === `I want to study: ${topicName}`) {
              return null;
            }
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm whitespace-pre-wrap">
                  {content}
                </div>
              </div>
            );
          }

          // Tutor message — distinct styling
          return (
            <div key={m.id} className="flex justify-start gap-3">
              <div className="shrink-0 mt-1">
                <div className="h-7 w-7 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                  <span className="text-[13px]">T</span>
                </div>
              </div>
              <div className="max-w-[85%] text-sm whitespace-pre-wrap leading-relaxed text-foreground">
                {content}
              </div>
            </div>
          );
        })}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start gap-3">
            <div className="shrink-0 mt-1">
              <div className="h-7 w-7 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                <span className="text-[13px]">T</span>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">Thinking...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border pt-3 flex gap-2 items-end">
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
          onClick={hasStarted ? handleSubmit : handleFreeStart}
          disabled={isLoading || !input.trim()}
          className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
