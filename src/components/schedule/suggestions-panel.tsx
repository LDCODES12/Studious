"use client";

import { format } from "date-fns";
import { Sparkles } from "lucide-react";
import type { Suggestion } from "./calendar-types";

export function SuggestionsPanel({
  suggestions,
  loading,
}: {
  suggestions: Suggestion[];
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        Study Suggestions
      </h3>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg bg-muted/40 p-3">
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              <div className="mt-2 h-3.5 w-full animate-pulse rounded bg-muted" />
              <div className="mt-1.5 h-3 w-3/4 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {suggestions.map((s, i) => (
            <div
              key={i}
              className="rounded-lg bg-muted/30 p-2.5 transition-colors hover:bg-muted/50"
            >
              <p className="text-[11px] font-medium text-muted-foreground">
                {format(new Date(s.day + "T12:00:00"), "EEE, MMM d")} ·{" "}
                {s.time}
              </p>
              <p className="mt-1 text-[13px] font-medium leading-snug">
                {s.task}
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                {s.reason}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
