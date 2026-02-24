import { getHours, getMinutes, differenceInMinutes } from "date-fns";
import {
  HOUR_HEIGHT,
  GUTTER_WIDTH,
  DAY_COUNT,
  SNAP_MINUTES,
  TOTAL_GRID_HEIGHT,
} from "./calendar-constants";
import type { CalendarEvent, CourseRef } from "./calendar-types";

export function parseEventTime(iso: string): Date | null {
  if (!iso) return null;
  try {
    return new Date(iso);
  } catch {
    return null;
  }
}

export function isAllDayEvent(start: string, end: string): boolean {
  return start.length === 10 || (!start.includes("T") && !end.includes("T"));
}

export function timeToY(date: Date): number {
  return getHours(date) * HOUR_HEIGHT + (getMinutes(date) / 60) * HOUR_HEIGHT;
}

export function minutesToY(minutes: number): number {
  return (minutes / 60) * HOUR_HEIGHT;
}

export function yToMinutes(y: number): number {
  return (y / HOUR_HEIGHT) * 60;
}

export function snapMinutes(raw: number): number {
  return Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
}

export function eventHeight(start: Date, end: Date): number {
  const mins = differenceInMinutes(end, start);
  return Math.max((mins / 60) * HOUR_HEIGHT, 22);
}

export function formatHour(hour: number): string {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

export function minutesToTimeStr(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export interface GridPosition {
  dayIndex: number;
  minutes: number;
}

export function pointerToGrid(
  clientX: number,
  clientY: number,
  gridRect: DOMRect,
  scrollTop: number
): GridPosition | null {
  const x = clientX - gridRect.left - GUTTER_WIDTH;
  const y = clientY - gridRect.top + scrollTop;

  if (x < 0 || y < 0) return null;

  const dayWidth = (gridRect.width - GUTTER_WIDTH) / DAY_COUNT;
  const dayIndex = Math.min(DAY_COUNT - 1, Math.max(0, Math.floor(x / dayWidth)));
  const rawMinutes = yToMinutes(y);
  const minutes = snapMinutes(Math.max(0, Math.min(24 * 60 - SNAP_MINUTES, rawMinutes)));

  return { dayIndex, minutes };
}

export function gridPositionToCSS(dayIndex: number) {
  return {
    left: `calc(${GUTTER_WIDTH}px + ${dayIndex} * (100% - ${GUTTER_WIDTH}px) / ${DAY_COUNT})`,
    width: `calc((100% - ${GUTTER_WIDTH}px) / ${DAY_COUNT})`,
  };
}

export function matchEventToCourse(
  event: CalendarEvent,
  courses: CourseRef[]
): string | null {
  const summary = event.summary.toLowerCase();
  for (const c of courses) {
    if (c.shortName && summary.includes(c.shortName.toLowerCase())) return c.color;
    const words = c.name.toLowerCase().split(/\s+/);
    if (words.length >= 2 && summary.includes(words.slice(0, 2).join(" "))) return c.color;
  }
  return null;
}

interface LayoutSlot {
  column: number;
  totalColumns: number;
}

export function layoutOverlapping<T extends { topY: number; height: number }>(
  items: T[]
): (T & LayoutSlot)[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.topY - b.topY || b.height - a.height);

  const columns: { endY: number }[] = [];
  const result: (T & LayoutSlot)[] = [];

  for (const item of sorted) {
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      if (item.topY >= columns[c].endY - 1) {
        columns[c].endY = item.topY + item.height;
        result.push({ ...item, column: c, totalColumns: 0 });
        placed = true;
        break;
      }
    }
    if (!placed) {
      result.push({ ...item, column: columns.length, totalColumns: 0 });
      columns.push({ endY: item.topY + item.height });
    }
  }

  const groups: number[][] = [];
  for (let i = 0; i < result.length; i++) {
    let foundGroup = false;
    for (const group of groups) {
      const overlaps = group.some((gi) => {
        const a = result[gi];
        const b = result[i];
        return a.topY < b.topY + b.height && b.topY < a.topY + a.height;
      });
      if (overlaps) {
        group.push(i);
        foundGroup = true;
        break;
      }
    }
    if (!foundGroup) groups.push([i]);
  }

  for (const group of groups) {
    const maxCol = Math.max(...group.map((i) => result[i].column)) + 1;
    for (const i of group) result[i].totalColumns = maxCol;
  }

  return result;
}

export { TOTAL_GRID_HEIGHT };
