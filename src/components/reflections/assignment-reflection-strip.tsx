"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

interface AssignmentReflectionStripProps {
  assignmentId: string;
  courseId: string;
}

const UNDERSTANDING = [
  { label: "Lost", key: 0, style: "border-red-400 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30 dark:hover:bg-red-500/25" },
  { label: "Shaky", key: 1, style: "border-orange-400 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30 dark:hover:bg-orange-500/25" },
  { label: "Mostly", key: 2, style: "border-blue-400 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30 dark:hover:bg-blue-500/25" },
  { label: "Got it", key: 3, style: "border-green-400 bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/30 dark:hover:bg-green-500/25" },
] as const;

const HARDEST_PART = [
  { label: "Content", value: "content" },
  { label: "Applying", value: "application" },
  { label: "Time", value: "time_pressure" },
  { label: "Directions", value: "directions_unclear" },
] as const;

export function AssignmentReflectionStrip({ assignmentId, courseId }: AssignmentReflectionStripProps) {
  const [hidden, setHidden] = useState(true);
  const [phase, setPhase] = useState<"understanding" | "hardest" | "done">("understanding");
  const [confidence, setConfidence] = useState<number | null>(null);

  // Check if reflection already exists
  useEffect(() => {
    fetch(`/api/reflections?assignmentId=${assignmentId}&type=post_assignment&limit=1`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.reflections?.length) setHidden(false);
      })
      .catch(() => setHidden(false));
  }, [assignmentId]);

  if (hidden || phase === "done") return null;

  const handleConfidence = (value: number) => {
    setConfidence(value);
    setPhase("hardest");
  };

  const handleHardest = (blocker: string) => {
    fetch("/api/reflections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "post_assignment",
        assignmentId,
        courseId,
        confidence,
        blocker,
      }),
    }).catch(() => {});
    setPhase("done");
  };

  return (
    <div className="rounded-lg border border-border bg-accent/20 p-3 space-y-1.5">
      {phase === "understanding" && (
        <>
          <p className="text-[11px] text-muted-foreground">How well do you understand this material?</p>
          <div className="grid grid-cols-4 gap-1.5">
            {UNDERSTANDING.map((u) => (
              <button
                key={u.key}
                onClick={() => handleConfidence(u.key)}
                className={cn("rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors", u.style)}
              >
                {u.label}
              </button>
            ))}
          </div>
        </>
      )}
      {phase === "hardest" && (
        <>
          <p className="text-[11px] text-muted-foreground">What was hardest?</p>
          <div className="grid grid-cols-4 gap-1.5">
            {HARDEST_PART.map((h) => (
              <button
                key={h.value}
                onClick={() => handleHardest(h.value)}
                className="rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent transition-colors"
              >
                {h.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
