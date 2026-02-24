import { differenceInCalendarDays, format, parseISO, subDays } from "date-fns";

export function isMidnightDeadline(dueDate: string | Date): boolean {
  const due = typeof dueDate === "string" ? parseISO(dueDate) : dueDate;
  return (
    Number.isFinite(due.getTime()) &&
    due.getHours() === 0 &&
    due.getMinutes() === 0
  );
}

export function effectivePlanningDate(dueDate: string | Date): Date {
  const due = typeof dueDate === "string" ? parseISO(dueDate) : dueDate;
  if (!Number.isFinite(due.getTime())) return due;
  return isMidnightDeadline(due) ? subDays(due, 1) : due;
}

export function formatAcademicDueDateShort(dueDate: string): string {
  const due = parseISO(dueDate);
  if (!Number.isFinite(due.getTime())) return "";
  const planning = effectivePlanningDate(due);
  if (isMidnightDeadline(due)) {
    return `${format(planning, "MMM d")} (midnight)`;
  }
  return format(due, "MMM d");
}

export function formatAcademicMidnightLabel(dueDate: string): string | null {
  const due = parseISO(dueDate);
  if (!Number.isFinite(due.getTime()) || !isMidnightDeadline(due)) return null;
  const planning = effectivePlanningDate(due);
  return `Due ${format(planning, "EEEE")} at midnight (${format(due, "h:mm a EEE")})`;
}

export function differenceInPlanningDays(dueDate: string, now: Date): number {
  const due = parseISO(dueDate);
  if (!Number.isFinite(due.getTime())) return Number.NaN;
  return differenceInCalendarDays(effectivePlanningDate(due), now);
}

