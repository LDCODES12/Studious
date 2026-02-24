"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { format, parseISO } from "date-fns";
import { X, Calendar, BookOpen, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCENT_BAR, ACCENT_CHIP } from "./calendar-constants";
import type { Assignment, CalendarEvent, ScheduleItem } from "./calendar-types";
import { isAssignment } from "./calendar-types";

export function EventDetailPanel({
  event,
  onClose,
}: {
  event: ScheduleItem;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        handleClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [handleClose]);

  const isA = isAssignment(event);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-end bg-black/10 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <div
        ref={ref}
        className={cn(
          "mr-4 mt-16 w-[360px] rounded-xl border border-border bg-card shadow-xl transition-all duration-200",
          visible ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
        )}
      >
        <div className="flex items-start gap-3 border-b border-border p-5">
          {isA && (
            <div
              className={cn(
                "mt-1 h-10 w-[3px] shrink-0 rounded-full",
                ACCENT_BAR[(event as Assignment).course.color] ?? "bg-gray-400"
              )}
            />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-semibold leading-snug">
              {isA
                ? (event as Assignment).title
                : (event as CalendarEvent).summary}
            </h3>
            {isA && (
              <p className="mt-1 text-[13px] text-muted-foreground">
                {(event as Assignment).course.shortName ??
                  (event as Assignment).course.name}
              </p>
            )}
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          {isA ? (
            <>
              <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3.5 py-2.5">
                <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-[13px]">
                  {(event as Assignment).dueDate
                    ? format(
                        parseISO((event as Assignment).dueDate!),
                        "EEEE, MMMM d, yyyy"
                      )
                    : "No due date"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[12px] font-medium capitalize",
                    ACCENT_CHIP[(event as Assignment).course.color] ??
                      "bg-muted text-muted-foreground"
                  )}
                >
                  {(event as Assignment).type}
                </span>
                {(event as Assignment).status !== "not_started" && (
                  <span className="rounded-md bg-muted px-2 py-0.5 text-[12px] font-medium capitalize text-muted-foreground">
                    {(event as Assignment).status.replace("_", " ")}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3.5 py-2.5">
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-[13px]">
                {(event as CalendarEvent).start.includes("T")
                  ? `${format(new Date((event as CalendarEvent).start), "h:mm a")} – ${format(new Date((event as CalendarEvent).end), "h:mm a")}`
                  : format(
                      new Date((event as CalendarEvent).start + "T12:00:00"),
                      "EEEE, MMMM d"
                    )}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
