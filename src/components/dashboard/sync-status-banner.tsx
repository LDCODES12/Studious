"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Check } from "lucide-react";

export function SyncStatusBanner({
  initialProcessing,
}: {
  initialProcessing: boolean;
}) {
  const [processing, setProcessing] = useState(initialProcessing);
  const [done, setDone] = useState(false);
  const [visible, setVisible] = useState(initialProcessing);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/sync-status");
      const data = await res.json();
      return data.processing as boolean;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!processing && !initialProcessing) return;

    const interval = setInterval(async () => {
      const isProcessing = await poll();

      if (isProcessing && !processing) {
        // Processing just started (e.g. user synced while on dashboard)
        setProcessing(true);
        setVisible(true);
      } else if (!isProcessing && processing) {
        // Processing just finished
        setProcessing(false);
        setDone(true);
        clearInterval(interval);
        setTimeout(() => setVisible(false), 3000);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [processing, initialProcessing, poll]);

  // Also poll on mount if not initially processing — catch syncs that start after page load
  useEffect(() => {
    if (initialProcessing) return;

    const interval = setInterval(async () => {
      const isProcessing = await poll();
      if (isProcessing) {
        setProcessing(true);
        setVisible(true);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [initialProcessing, poll]);

  if (!visible) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5">
      {done ? (
        <>
          <Check className="h-3.5 w-3.5 text-green-500" />
          <span className="text-[13px] text-muted-foreground">
            Syllabus analysis complete — course content updated.
          </span>
        </>
      ) : (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[13px] text-muted-foreground">
            Analyzing syllabi… Course content will update shortly.
          </span>
        </>
      )}
    </div>
  );
}
