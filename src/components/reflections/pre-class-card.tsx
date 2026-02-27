"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";

interface PreClassCardProps {
  courseId: string;
  courseName: string;
  courseColor: string;
  topicName: string | null;
  classTime: string;
}

const PRIOR_KNOWLEDGE = [
  { label: "New to me", value: "nothing", style: "border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:bg-gray-500/15 dark:text-gray-300 dark:border-gray-500/30 dark:hover:bg-gray-500/25" },
  { label: "Heard of it", value: "heard_of_it", style: "border-orange-300 bg-orange-50 text-orange-600 hover:bg-orange-100 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30 dark:hover:bg-orange-500/25" },
  { label: "Some idea", value: "some_understanding", style: "border-blue-300 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30 dark:hover:bg-blue-500/25" },
  { label: "Comfortable", value: "comfortable", style: "border-green-300 bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/30 dark:hover:bg-green-500/25" },
] as const;

export function PreClassCard({ courseId, courseName, courseColor, topicName, classTime }: PreClassCardProps) {
  const [submitted, setSubmitted] = useState(false);
  const colors = courseColors[courseColor];

  const handleSelect = (value: string) => {
    fetch("/api/reflections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "pre_class",
        courseId,
        priorKnowledge: value,
        topics: topicName ? [topicName] : [],
      }),
    }).catch(() => {});
    setSubmitted(true);
  };

  if (submitted) return null;

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        {colors && <span className={cn("h-2 w-2 rounded-full", colors.dot)} />}
        <span className="text-[12px] font-medium">{courseName}</span>
        <span className="text-[11px] text-muted-foreground ml-auto">{classTime}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {topicName
          ? <>How much do you know about <span className="font-medium text-foreground">{topicName}</span>?</>
          : "How prepared do you feel for your next class?"}
      </p>
      <div className="grid grid-cols-4 gap-1.5">
        {PRIOR_KNOWLEDGE.map((pk) => (
          <button
            key={pk.value}
            onClick={() => handleSelect(pk.value)}
            className={cn("rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors", pk.style)}
          >
            {pk.label}
          </button>
        ))}
      </div>
    </div>
  );
}
