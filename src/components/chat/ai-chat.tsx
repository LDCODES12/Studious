"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StudyTargetEvidence } from "@/lib/study-targets";
import { summarizeStudyTargetEvidence } from "@/lib/study-target-presenters";

export interface AIChatPromptOption {
  label: string;
  prompt: string;
  context?: {
    courseId?: string;
    courseName?: string;
    topicName?: string;
    targetEvidence?: StudyTargetEvidence;
  };
  note?: string;
}

interface AIChatProps {
  courseId?: string;
  suggestedPrompts: AIChatPromptOption[];
  placeholder?: string;
  emptyMessage?: string;
}

export function AIChat({
  courseId,
  suggestedPrompts,
  placeholder = "Ask a question... (Enter to send, Shift+Enter for newline)",
  emptyMessage = "Ask anything — topics, assignments, study planning.",
}: AIChatProps) {
  const [input, setInput] = useState("");
  const baseContext = courseId ? { courseId } : undefined;
  const [activeContext, setActiveContext] = useState<AIChatPromptOption["context"] | undefined>(baseContext);
  const activeContextRef = useRef<AIChatPromptOption["context"] | undefined>(baseContext);
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ messages: msgs, body }) => {
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        const rid = (lastAssistant?.metadata as { responseId?: string } | undefined)?.responseId;
        const context = activeContextRef.current;
        return {
          body: {
            ...body,
            messages: msgs,
            ...(context?.courseId ? { courseId: context.courseId } : {}),
            ...(context?.topicName ? { topicName: context.topicName } : {}),
            ...(context?.targetEvidence ? { targetEvidence: context.targetEvidence } : {}),
            ...(rid ? { previousResponseId: rid } : {}),
          },
        };
      },
    }),
  });

  const bottomRef = useRef<HTMLDivElement>(null);
  const isLoading = status === "streaming" || status === "submitted";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    activeContextRef.current = activeContext;
  }, [activeContext]);

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) {
        handleSubmit();
      }
    }
  }

  function handleSubmit() {
    if (input.trim() && !isLoading) {
      sendMessage({ text: input });
      setInput("");
    }
  }

  function handleSuggestedPrompt(prompt: AIChatPromptOption) {
    const nextContext = prompt.context ?? baseContext;
    activeContextRef.current = nextContext;
    setActiveContext(nextContext);
    sendMessage({ text: prompt.prompt });
  }

  function clearFocus() {
    activeContextRef.current = baseContext;
    setActiveContext(baseContext);
  }

  const focusLines = activeContext?.targetEvidence
    ? summarizeStudyTargetEvidence(activeContext.targetEvidence)
    : [];

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-card"
      style={{ height: "60vh", minHeight: "400px" }}
    >
      {activeContext?.topicName && (
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-muted-foreground">
                Focused study context
              </p>
              <p className="text-sm font-medium leading-snug">
                {activeContext.courseName ? `${activeContext.courseName}: ` : ""}
                {activeContext.topicName}
              </p>
              {focusLines.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                  {focusLines.join(" • ")}
                </p>
              )}
            </div>
            <button
              onClick={clearFocus}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Clear focus
            </button>
          </div>
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <p className="text-sm text-muted-foreground">{emptyMessage}</p>
            <div className="flex flex-col gap-2 w-full max-w-sm">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={`${prompt.label}-${prompt.prompt}`}
                  onClick={() => handleSuggestedPrompt(prompt)}
                  disabled={isLoading}
                  className="rounded-lg border border-border bg-muted px-4 py-2 text-sm text-left hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <span className="block">{prompt.label}</span>
                  {prompt.note && (
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {prompt.note}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => {
            const role = m.role;
            const content = m.parts
              .filter((part) => part.type === "text")
              .map((part) => (part as { text: string }).text)
              .join("");
            return (
              <div
                key={m.id}
                className={cn(
                  "flex",
                  role === "user" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "max-w-[80%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap",
                    role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  )}
                >
                  {content}
                </div>
              </div>
            );
          })
        )}
        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-2 text-sm text-muted-foreground">
              Thinking...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-border p-3 flex gap-2 items-end">
        <textarea
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
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
          className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
