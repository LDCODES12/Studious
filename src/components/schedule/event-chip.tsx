"use client";

import { format } from "date-fns";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import {
  ACCENT_EVENT_BG,
  ACCENT_EVENT_TEXT,
  ACCENT_EVENT_BORDER,
  DEFAULT_EVENT_COLOR,
} from "./calendar-constants";
import type { CalendarEvent } from "./calendar-types";

export interface EventChipProps {
  event: CalendarEvent;
  topY: number;
  height: number;
  left: string;
  width: string;
  color: string;
  startTime: Date;
  endTime: Date;
  resizeHeight?: number;
  onSelect: (e: CalendarEvent) => void;
  onResizeStart: (e: React.PointerEvent, event: CalendarEvent) => void;
}

export function EventChip({
  event,
  topY,
  height,
  left,
  width,
  color,
  startTime,
  endTime,
  resizeHeight,
  onSelect,
  onResizeStart,
}: EventChipProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `event-${event.id}`,
    data: { type: "calendar-event", event },
  });

  const displayHeight = resizeHeight ?? height;
  const isShort = displayHeight < 40;
  const bgClass = ACCENT_EVENT_BG[color] ?? ACCENT_EVENT_BG[DEFAULT_EVENT_COLOR];
  const textClass = ACCENT_EVENT_TEXT[color] ?? ACCENT_EVENT_TEXT[DEFAULT_EVENT_COLOR];
  const borderClass = ACCENT_EVENT_BORDER[color] ?? ACCENT_EVENT_BORDER[DEFAULT_EVENT_COLOR];

  const style: React.CSSProperties = {
    top: topY,
    height: displayHeight,
    left,
    width,
    ...(transform ? { transform: CSS.Translate.toString(transform) } : {}),
  };

  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        if (!isDragging) onSelect(event);
      }}
      className={cn(
        "group/chip absolute z-10 cursor-pointer overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left transition-shadow select-none",
        bgClass,
        borderClass,
        isDragging && "opacity-40 shadow-none"
      )}
      style={style}
    >
      <div className="flex h-full min-w-0 flex-col">
        <p
          className={cn(
            "truncate font-semibold leading-tight",
            textClass,
            isShort ? "text-[11px]" : "text-[12px]"
          )}
        >
          {event.summary}
        </p>
        {!isShort && (
          <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
            {format(startTime, "h:mm")} – {format(endTime, "h:mm a")}
          </p>
        )}
      </div>

      {/* Resize handle */}
      <div
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onResizeStart(e, event);
        }}
        className="absolute right-0 bottom-0 left-0 z-20 flex h-2 cursor-s-resize items-center justify-center opacity-0 transition-opacity group-hover/chip:opacity-100"
      >
        <div className="h-[2px] w-5 rounded-full bg-current opacity-40" />
      </div>
    </button>
  );
}

export function EventChipGhost({
  event,
  height,
  color,
  startTime,
  endTime,
}: {
  event: CalendarEvent;
  height: number;
  color: string;
  startTime: Date;
  endTime: Date;
}) {
  const bgClass = ACCENT_EVENT_BG[color] ?? ACCENT_EVENT_BG[DEFAULT_EVENT_COLOR];
  const textClass = ACCENT_EVENT_TEXT[color] ?? ACCENT_EVENT_TEXT[DEFAULT_EVENT_COLOR];
  const borderClass = ACCENT_EVENT_BORDER[color] ?? ACCENT_EVENT_BORDER[DEFAULT_EVENT_COLOR];
  const isShort = height < 40;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border-l-[3px] px-2 py-1 shadow-lg",
        bgClass,
        borderClass
      )}
      style={{ height, width: 180 }}
    >
      <p
        className={cn(
          "truncate font-semibold leading-tight",
          textClass,
          isShort ? "text-[11px]" : "text-[12px]"
        )}
      >
        {event.summary}
      </p>
      {!isShort && (
        <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
          {format(startTime, "h:mm")} – {format(endTime, "h:mm a")}
        </p>
      )}
    </div>
  );
}
