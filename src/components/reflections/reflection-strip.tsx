"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

interface ReflectionStripProps {
  taskId: string;
  courseId: string | null;
  onDone: () => void;
}

const CONFIDENCE = [
  { label: "Lost", key: 0, style: "border-red-400 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30 dark:hover:bg-red-500/25" },
  { label: "Shaky", key: 1, style: "border-orange-400 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30 dark:hover:bg-orange-500/25" },
  { label: "Solid", key: 2, style: "border-blue-400 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30 dark:hover:bg-blue-500/25" },
  { label: "Nailed it", key: 3, style: "border-green-400 bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/30 dark:hover:bg-green-500/25" },
] as const;

const BLOCKERS = [
  { label: "Nothing", value: "none" },
  { label: "Confused", value: "confused_by_topic" },
  { label: "No time", value: "ran_out_of_time" },
  { label: "Missing prereq", value: "missing_prereq" },
] as const;

export function ReflectionStrip({ taskId, courseId, onDone }: ReflectionStripProps) {
  const [phase, setPhase] = useState<"confidence" | "blocker">("confidence");
  const [confidence, setConfidence] = useState<number | null>(null);

  // Auto-dismiss after 10 seconds
  useEffect(() => {
    const timer = setTimeout(onDone, 10000);
    return () => clearTimeout(timer);
  }, [onDone]);

  const handleConfidence = (value: number) => {
    setConfidence(value);
    setPhase("blocker");
  };

  const handleBlocker = (blocker: string) => {
    fetch("/api/reflections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "task_completion",
        taskId,
        courseId,
        confidence,
        blocker,
      }),
    }).catch(() => {});
    onDone();
  };

  const handleSkip = () => {
    if (confidence !== null) {
      fetch("/api/reflections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "task_completion",
          taskId,
          courseId,
          confidence,
          blocker: "none",
        }),
      }).catch(() => {});
    }
    onDone();
  };

  return (
    <div className="px-3 py-2 bg-accent/30 border-t border-border">
      {phase === "confidence" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">How confident?</p>
            <button
              onClick={handleSkip}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Skip
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {CONFIDENCE.map((c) => (
              <button
                key={c.key}
                onClick={() => handleConfidence(c.key)}
                className={cn(
                  "rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors",
                  c.style
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === "blocker" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">Anything block you?</p>
            <button
              onClick={() => handleBlocker("none")}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Skip
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {BLOCKERS.map((b) => (
              <button
                key={b.value}
                onClick={() => handleBlocker(b.value)}
                className="rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent transition-colors"
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
