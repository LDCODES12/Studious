"use client";

import { useState } from "react";
import { Brain, CalendarClock, GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";
import { AIChat } from "@/components/chat/ai-chat";
import { StudyPlanPanel } from "@/components/study-tools/study-plan-panel";
import { TutorTopicPicker, type TutorTopic } from "@/components/study-tools/tutor-topic-picker";

const CROSS_COURSE_PROMPTS = [
  "What should I focus on today?",
  "Which assignments are most urgent right now?",
  "Help me plan my study sessions for this week",
  "What topics should I review before my next class?",
];

type Tab = "tutor" | "chat" | "plan";

export function StudyToolsClient({ tutorTopics }: { tutorTopics: TutorTopic[] }) {
  const [tab, setTab] = useState<Tab>("tutor");

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-hidden">
      {/* Tab header */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => setTab("tutor")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            tab === "tutor"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <GraduationCap className="h-3.5 w-3.5" />
          Tutor
        </button>
        <button
          onClick={() => setTab("chat")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            tab === "chat"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <Brain className="h-3.5 w-3.5" />
          Study Assistant
        </button>
        <button
          onClick={() => setTab("plan")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            tab === "plan"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <CalendarClock className="h-3.5 w-3.5" />
          Study Plan
        </button>
      </div>

      {/* Tab content */}
      {tab === "tutor" ? (
        <TutorTopicPicker topics={tutorTopics} />
      ) : tab === "chat" ? (
        <AIChat
          suggestedPrompts={CROSS_COURSE_PROMPTS}
          emptyMessage="Ask about any of your courses — planning, priorities, study strategies, exam prep."
          placeholder="Ask across all your courses... (Enter to send)"
        />
      ) : (
        <StudyPlanPanel />
      )}
    </div>
  );
}
