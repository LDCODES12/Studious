"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";
import { Send } from "lucide-react";
import type { StudyTargetEvidence } from "@/lib/study-targets";
import { summarizeStudyTargetEvidence } from "@/lib/study-target-presenters";

export interface TutorTopic {
  courseId: string;
  courseName: string;
  courseColor: string;
  topicName: string;
  readings: string[];
  evidence: StudyTargetEvidence;
}

export function TutorTopicPicker({ topics }: { topics: TutorTopic[] }) {
  const router = useRouter();
  const [freeInput, setFreeInput] = useState("");

  function handleTopicClick(topic: TutorTopic) {
    const params = new URLSearchParams({
      courseId: topic.courseId,
      topic: topic.topicName,
      courseName: topic.courseName,
      courseColor: topic.courseColor,
      ...(topic.readings.length > 0 ? { readings: topic.readings.join("|||") } : {}),
      evidence: JSON.stringify(topic.evidence),
    });
    router.push(`/study-tools/tutor?${params.toString()}`);
  }

  function handleFreeStart() {
    if (freeInput.trim()) {
      const params = new URLSearchParams({ q: freeInput.trim() });
      router.push(`/study-tools/tutor?${params.toString()}`);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleFreeStart();
    }
  }

  return (
    <div className="space-y-6">
      {/* Topic cards */}
      {topics.length > 0 && (
        <div>
          <p className="text-[13px] text-muted-foreground mb-3">
            Pick a topic from this week to start a tutoring session
          </p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {topics.map((topic) => {
              const colors = courseColors[topic.courseColor];
              const evidenceLines = summarizeStudyTargetEvidence(topic.evidence);
              return (
                <button
                  key={`${topic.courseId}-${topic.topicName}`}
                  onClick={() => handleTopicClick(topic)}
                  className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent/30 group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full shrink-0",
                        colors?.dot ?? "bg-gray-400"
                      )}
                    />
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {topic.courseName}
                    </span>
                  </div>
                  <p className="text-[13px] font-medium leading-snug line-clamp-2">
                    {topic.topicName}
                  </p>
                  {topic.readings.length > 0 && (
                    <p className="mt-1 text-[11px] text-muted-foreground/70 line-clamp-1">
                      {topic.readings.join(", ")}
                    </p>
                  )}
                  {!topic.readings.length && evidenceLines.length > 0 && (
                    <p className="mt-1 text-[11px] text-muted-foreground/70 line-clamp-2">
                      {evidenceLines.join(" • ")}
                    </p>
                  )}
                  <span className="mt-2 inline-block text-[11px] font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                    Start session →
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Free-form input */}
      <div>
        <p className="text-[13px] text-muted-foreground mb-2">
          {topics.length > 0 ? "Or describe what you want to study" : "Describe what you want to study"}
        </p>
        <div className="flex gap-2">
          <input
            value={freeInput}
            onChange={(e) => setFreeInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g., Help me understand thermodynamics..."
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={handleFreeStart}
            disabled={!freeInput.trim()}
            className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            aria-label="Start session"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
