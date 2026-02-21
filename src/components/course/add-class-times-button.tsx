"use client";

import { useState } from "react";
import { CalendarPlus, Check, Loader2 } from "lucide-react";

interface Props {
  courseId: string;
}

type State = "idle" | "loading" | "done" | "error";

export function AddClassTimesButton({ courseId }: Props) {
  const [state, setState] = useState<State>("idle");
  const [created, setCreated] = useState(0);

  const handleClick = async () => {
    if (state !== "idle") return;
    setState("loading");
    try {
      const resp = await fetch(`/api/courses/${courseId}/class-schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!resp.ok) throw new Error("Failed");
      const data = await resp.json();
      setCreated(data.created ?? 0);
      setState("done");
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  };

  if (state === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-green-50 px-3 py-1.5 text-[12px] font-medium text-green-700">
        <Check className="h-3.5 w-3.5" />
        {created > 0 ? `${created} event${created !== 1 ? "s" : ""} added` : "Already on Calendar"}
      </span>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={state === "loading"}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
    >
      {state === "loading" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <CalendarPlus className="h-3.5 w-3.5" />
      )}
      {state === "error" ? "Failed — try again" : "Add class times to Calendar"}
    </button>
  );
}
