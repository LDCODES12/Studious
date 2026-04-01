"use client";

import { AIChat } from "@/components/chat/ai-chat";

const SUGGESTED_PROMPTS = [
  { label: "What topics should I review before next class?", prompt: "What topics should I review before next class?" },
  { label: "Help me break down my next assignment", prompt: "Help me break down my next assignment" },
  { label: "Generate practice problems on this week's material", prompt: "Generate practice problems on this week's material" },
];

export function CourseChat({ courseId }: { courseId: string }) {
  return (
    <AIChat
      courseId={courseId}
      suggestedPrompts={SUGGESTED_PROMPTS}
      emptyMessage="Ask about your course — topics, assignments, practice problems, study planning."
    />
  );
}
