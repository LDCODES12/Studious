"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { format, addDays, addMinutes, isToday, setHours, setMinutes } from "date-fns";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  HOURS,
  HOUR_HEIGHT,
  GUTTER_WIDTH,
  DAY_COUNT,
  SNAP_MINUTES,
  DEFAULT_EVENT_COLOR,
} from "./calendar-constants";
import {
  timeToY,
  eventHeight,
  formatHour,
  layoutOverlapping,
  isAllDayEvent,
  parseEventTime,
  pointerToGrid,
  gridPositionToCSS,
  minutesToY,
  minutesToTimeStr,
  matchEventToCourse,
  TOTAL_GRID_HEIGHT,
} from "./calendar-utils";
import { EventChip, EventChipGhost } from "./event-chip";
import { AllDayRow } from "./all-day-row";
import type {
  Assignment,
  CalendarEvent,
  CourseRef,
  ScheduleItem,
} from "./calendar-types";

interface WeekViewProps {
  weekStart: Date;
  assignmentsForDay: (day: Date) => Assignment[];
  eventsForDay: (day: Date) => CalendarEvent[];
  courses: CourseRef[];
  gridRef: React.RefObject<HTMLDivElement | null>;
  onSelectEvent: (e: ScheduleItem) => void;
  onEventMove: (eventId: string, newStart: string, newEnd: string) => void;
  onEventResize: (eventId: string, newEnd: string) => void;
}

export function WeekView({
  weekStart,
  assignmentsForDay,
  eventsForDay,
  courses,
  gridRef,
  onSelectEvent,
  onEventMove,
  onEventResize,
}: WeekViewProps) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const todayIndex = days.findIndex((d) => isToday(d));

  const hasAllDay = days.some((day) => {
    const allDayGcal = eventsForDay(day).filter((e) =>
      isAllDayEvent(e.start, e.end)
    );
    return allDayGcal.length > 0 || assignmentsForDay(day).length > 0;
  });

  // --- Drag-and-drop ---
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const [activeEvent, setActiveEvent] = useState<{
    event: CalendarEvent;
    color: string;
    startTime: Date;
    endTime: Date;
    height: number;
  } | null>(null);

  const handleDragStart = useCallback(
    (e: DragStartEvent) => {
      const data = e.active.data.current;
      if (data?.type !== "calendar-event") return;
      const ev = data.event as CalendarEvent;
      const start = parseEventTime(ev.start);
      const end = parseEventTime(ev.end);
      if (!start || !end) return;
      const color = matchEventToCourse(ev, courses) ?? DEFAULT_EVENT_COLOR;
      setActiveEvent({
        event: ev,
        color,
        startTime: start,
        endTime: end,
        height: eventHeight(start, end),
      });
    },
    [courses]
  );

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveEvent(null);
      if (!gridRef.current) return;

      const data = e.active.data.current;
      if (data?.type !== "calendar-event") return;
      const ev = data.event as CalendarEvent;

      const rect = gridRef.current.getBoundingClientRect();
      const pointer = e.activatorEvent as PointerEvent | undefined;
      if (!pointer) return;

      const finalX = pointer.clientX + (e.delta?.x ?? 0);
      const finalY = pointer.clientY + (e.delta?.y ?? 0);
      const pos = pointerToGrid(finalX, finalY, rect, gridRef.current.scrollTop);
      if (!pos) return;

      const origStart = parseEventTime(ev.start);
      const origEnd = parseEventTime(ev.end);
      if (!origStart || !origEnd) return;

      const durationMin =
        (origEnd.getTime() - origStart.getTime()) / 60000;
      const targetDay = days[pos.dayIndex];
      const newStartDate = setMinutes(
        setHours(targetDay, Math.floor(pos.minutes / 60)),
        pos.minutes % 60
      );
      const newEndDate = addMinutes(newStartDate, durationMin);

      const newStart = newStartDate.toISOString();
      const newEnd = newEndDate.toISOString();

      if (newStart !== ev.start || newEnd !== ev.end) {
        onEventMove(ev.id, newStart, newEnd);
      }
    },
    [gridRef, days, onEventMove]
  );

  // --- Resize ---
  const [resizeState, setResizeState] = useState<{
    eventId: string;
    height: number;
  } | null>(null);
  const resizeRef = useRef<{
    eventId: string;
    eventStart: Date;
    origEndMinutes: number;
    startY: number;
  } | null>(null);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent, event: CalendarEvent) => {
      const start = parseEventTime(event.start);
      const end = parseEventTime(event.end);
      if (!start || !end || !gridRef.current) return;

      const endMinutes = end.getHours() * 60 + end.getMinutes();
      resizeRef.current = {
        eventId: event.id,
        eventStart: start,
        origEndMinutes: endMinutes,
        startY: e.clientY,
      };
      setResizeState({ eventId: event.id, height: eventHeight(start, end) });

      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [gridRef]
  );

  const handleResizeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return;
      const deltaY = e.clientY - resizeRef.current.startY;
      const deltaMin =
        Math.round((deltaY / HOUR_HEIGHT) * 60 / SNAP_MINUTES) * SNAP_MINUTES;
      const newEndMin = Math.max(
        resizeRef.current.eventStart.getHours() * 60 +
          resizeRef.current.eventStart.getMinutes() +
          SNAP_MINUTES,
        Math.min(24 * 60, resizeRef.current.origEndMinutes + deltaMin)
      );
      const newHeight = minutesToY(
        newEndMin -
          (resizeRef.current.eventStart.getHours() * 60 +
            resizeRef.current.eventStart.getMinutes())
      );
      setResizeState({ eventId: resizeRef.current.eventId, height: Math.max(22, newHeight) });
    },
    []
  );

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return;
      const deltaY = e.clientY - resizeRef.current.startY;
      const deltaMin =
        Math.round((deltaY / HOUR_HEIGHT) * 60 / SNAP_MINUTES) * SNAP_MINUTES;
      const newEndMin = Math.max(
        resizeRef.current.eventStart.getHours() * 60 +
          resizeRef.current.eventStart.getMinutes() +
          SNAP_MINUTES,
        Math.min(24 * 60, resizeRef.current.origEndMinutes + deltaMin)
      );

      const ev = resizeRef.current;
      const newEnd = new Date(ev.eventStart);
      newEnd.setHours(Math.floor(newEndMin / 60), newEndMin % 60, 0, 0);
      onEventResize(ev.eventId, newEnd.toISOString());

      resizeRef.current = null;
      setResizeState(null);
    },
    [onEventResize]
  );

  // --- Click-to-create ---
  const [createBlock, setCreateBlock] = useState<{
    dayIndex: number;
    startMin: number;
    endMin: number;
  } | null>(null);
  const createRef = useRef<{
    dayIndex: number;
    startMin: number;
    started: boolean;
    startClientY: number;
  } | null>(null);

  const handleGridPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-event-chip]")) return;
      if (!gridRef.current) return;

      const rect = gridRef.current.getBoundingClientRect();
      const pos = pointerToGrid(
        e.clientX,
        e.clientY,
        rect,
        gridRef.current.scrollTop
      );
      if (!pos) return;

      createRef.current = {
        dayIndex: pos.dayIndex,
        startMin: pos.minutes,
        started: false,
        startClientY: e.clientY,
      };
    },
    [gridRef]
  );

  const handleGridPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (resizeRef.current) {
        handleResizeMove(e);
        return;
      }
      if (!createRef.current || !gridRef.current) return;

      const dy = Math.abs(e.clientY - createRef.current.startClientY);
      if (dy < 5 && !createRef.current.started) return;
      createRef.current.started = true;

      const rect = gridRef.current.getBoundingClientRect();
      const pos = pointerToGrid(
        e.clientX,
        e.clientY,
        rect,
        gridRef.current.scrollTop
      );
      if (!pos) return;

      const startMin = Math.min(createRef.current.startMin, pos.minutes);
      const endMin = Math.max(
        createRef.current.startMin + SNAP_MINUTES,
        pos.minutes + SNAP_MINUTES
      );
      setCreateBlock({
        dayIndex: createRef.current.dayIndex,
        startMin,
        endMin,
      });
    },
    [gridRef, handleResizeMove]
  );

  const handleGridPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (resizeRef.current) {
        handleResizeEnd(e);
        return;
      }
      if (createRef.current?.started && createBlock) {
        setCreateBlock(null);
        createRef.current = null;
        return;
      }
      createRef.current = null;
      setCreateBlock(null);
    },
    [handleResizeEnd, createBlock]
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        {/* Day headers */}
        <div className="flex shrink-0 border-b border-border">
          <div className="shrink-0" style={{ width: GUTTER_WIDTH }} />
          {days.map((day, i) => (
            <div
              key={day.toISOString()}
              className={cn(
                "flex flex-1 flex-col items-center border-l border-border py-2.5",
                i === 0 && "border-l-0"
              )}
            >
              <span
                className={cn(
                  "text-[11px] font-medium uppercase tracking-wide",
                  isToday(day)
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-muted-foreground"
                )}
              >
                {format(day, "EEE")}
              </span>
              <span
                className={cn(
                  "mt-1 flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-semibold",
                  isToday(day)
                    ? "bg-blue-600 text-white dark:bg-blue-500"
                    : "text-foreground"
                )}
              >
                {format(day, "d")}
              </span>
            </div>
          ))}
        </div>

        {hasAllDay && (
          <AllDayRow
            days={days}
            assignmentsForDay={assignmentsForDay}
            eventsForDay={eventsForDay}
            onSelectEvent={onSelectEvent}
          />
        )}

        {/* Scrollable time grid */}
        <div
          ref={gridRef}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onPointerDown={handleGridPointerDown}
          onPointerMove={handleGridPointerMove}
          onPointerUp={handleGridPointerUp}
        >
          <div className="relative" style={{ height: TOTAL_GRID_HEIGHT }}>
            {/* Hour gridlines */}
            {HOURS.map((hour) => {
              const y = hour * HOUR_HEIGHT;
              return (
                <div key={hour} className="absolute w-full" style={{ top: y }}>
                  <div className="flex">
                    <div
                      className="relative shrink-0"
                      style={{ width: GUTTER_WIDTH }}
                    >
                      <span className="absolute -top-[7px] right-3 text-[11px] tabular-nums text-muted-foreground">
                        {formatHour(hour)}
                      </span>
                    </div>
                    <div className="flex-1 border-t border-border" />
                  </div>
                  <div
                    className="flex"
                    style={{ marginTop: HOUR_HEIGHT / 2 }}
                  >
                    <div className="shrink-0" style={{ width: GUTTER_WIDTH }} />
                    <div className="flex-1 border-t border-dashed border-border/40" />
                  </div>
                </div>
              );
            })}

            {/* Vertical day separators */}
            {days.map((_, i) => {
              if (i === 0) return null;
              return (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 border-l border-border"
                  style={{
                    left: `calc(${GUTTER_WIDTH}px + ${i} * (100% - ${GUTTER_WIDTH}px) / ${DAY_COUNT})`,
                  }}
                />
              );
            })}

            {/* Current time indicator */}
            {todayIndex >= 0 && <NowIndicator todayIndex={todayIndex} />}

            {/* Timed events per day */}
            {days.map((day, dayIndex) => (
              <DayColumn
                key={day.toISOString()}
                day={day}
                dayIndex={dayIndex}
                eventsForDay={eventsForDay}
                courses={courses}
                resizeState={resizeState}
                onSelectEvent={onSelectEvent}
                onResizeStart={handleResizeStart}
              />
            ))}

            {/* Create block preview */}
            {createBlock && (
              <div
                className="pointer-events-none absolute z-20 rounded-lg border-2 border-blue-400 bg-blue-500/10"
                style={{
                  ...gridPositionToCSS(createBlock.dayIndex),
                  top: minutesToY(createBlock.startMin),
                  height: minutesToY(createBlock.endMin - createBlock.startMin),
                }}
              >
                <div className="px-2 pt-1 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                  {minutesToTimeStr(createBlock.startMin)} –{" "}
                  {minutesToTimeStr(createBlock.endMin)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeEvent && (
          <EventChipGhost
            event={activeEvent.event}
            height={activeEvent.height}
            color={activeEvent.color}
            startTime={activeEvent.startTime}
            endTime={activeEvent.endTime}
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function NowIndicator({ todayIndex }: { todayIndex: number }) {
  const y = timeToY(new Date());
  const dotLeft = `calc(${GUTTER_WIDTH}px + ${todayIndex} * (100% - ${GUTTER_WIDTH}px) / ${DAY_COUNT})`;

  return (
    <>
      {/* Full-width line */}
      <div
        className="pointer-events-none absolute z-30"
        style={{ top: y, left: GUTTER_WIDTH, right: 0 }}
      >
        <div className="h-[2px] bg-red-500" />
      </div>
      {/* Red dot at today's column edge */}
      <div
        className="pointer-events-none absolute z-30"
        style={{ top: y, left: dotLeft }}
      >
        <div className="-ml-[5px] -mt-[4px] h-2.5 w-2.5 rounded-full bg-red-500" />
      </div>
    </>
  );
}

function DayColumn({
  day,
  dayIndex,
  eventsForDay,
  courses,
  resizeState,
  onSelectEvent,
  onResizeStart,
}: {
  day: Date;
  dayIndex: number;
  eventsForDay: (day: Date) => CalendarEvent[];
  courses: CourseRef[];
  resizeState: { eventId: string; height: number } | null;
  onSelectEvent: (e: ScheduleItem) => void;
  onResizeStart: (e: React.PointerEvent, event: CalendarEvent) => void;
}) {
  const timedEvents = eventsForDay(day).filter(
    (e) => !isAllDayEvent(e.start, e.end)
  );

  const items = timedEvents
    .map((event) => {
      const start = parseEventTime(event.start);
      const end = parseEventTime(event.end);
      if (!start || !end) return null;
      return {
        event,
        topY: timeToY(start),
        height: eventHeight(start, end),
        start,
        end,
        color: matchEventToCourse(event, courses) ?? DEFAULT_EVENT_COLOR,
      };
    })
    .filter(Boolean) as {
    event: CalendarEvent;
    topY: number;
    height: number;
    start: Date;
    end: Date;
    color: string;
  }[];

  const laid = layoutOverlapping(items);
  const pos = gridPositionToCSS(dayIndex);

  return (
    <div
      className="absolute top-0"
      style={{ left: pos.left, width: pos.width, height: "100%" }}
      data-event-chip
    >
      {laid.map((slot) => {
        const widthPct = 100 / slot.totalColumns;
        const leftPct = slot.column * widthPct;

        return (
          <EventChip
            key={slot.event.id}
            event={slot.event}
            topY={slot.topY}
            height={slot.height}
            left={`calc(${leftPct}% + 2px)`}
            width={`calc(${widthPct}% - 4px)`}
            color={slot.color}
            startTime={slot.start}
            endTime={slot.end}
            resizeHeight={
              resizeState?.eventId === slot.event.id
                ? resizeState.height
                : undefined
            }
            onSelect={onSelectEvent}
            onResizeStart={onResizeStart}
          />
        );
      })}
    </div>
  );
}
