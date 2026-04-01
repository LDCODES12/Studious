import { differenceInCalendarDays, format, parseISO, subDays } from "date-fns";

function hasExplicitTime(dueDate: string): boolean {
  return /T\d{2}:\d{2}/.test(dueDate);
}

export function isMidnightDeadline(dueDate: string): boolean {
  if (!hasExplicitTime(dueDate)) return false;
  const due = parseISO(dueDate);
  return (
    Number.isFinite(due.getTime()) &&
    due.getHours() === 0 &&
    due.getMinutes() === 0
  );
}

export function effectivePlanningDate(dueDate: string): Date {
  const due = parseISO(dueDate);
  if (!Number.isFinite(due.getTime())) return due;
  return isMidnightDeadline(dueDate) ? subDays(due, 1) : due;
}

export function formatAcademicDueDateShort(dueDate: string): string {
  const due = parseISO(dueDate);
  if (!Number.isFinite(due.getTime())) return "";
  const planning = effectivePlanningDate(dueDate);
  if (isMidnightDeadline(dueDate)) {
    return `${format(planning, "MMM d")} (midnight)`;
  }
  return format(due, "MMM d");
}

export function formatAcademicDueDateWithWeekday(dueDate: string): string {
  const due = parseISO(dueDate);
  if (!Number.isFinite(due.getTime())) return "";
  const planning = effectivePlanningDate(dueDate);
  if (isMidnightDeadline(dueDate)) {
    return `${format(planning, "EEE")} · ${format(planning, "MMM d")} (midnight)`;
  }
  return `${format(due, "EEE")} · ${format(due, "MMM d")}`;
}

export function formatAcademicMidnightLabel(dueDate: string): string | null {
  const due = parseISO(dueDate);
  if (!Number.isFinite(due.getTime()) || !isMidnightDeadline(dueDate)) return null;
  const planning = effectivePlanningDate(dueDate);
  return `Due ${format(planning, "EEEE")} at midnight (${format(due, "h:mm a EEE")})`;
}

export function differenceInPlanningDays(dueDate: string, now: Date): number {
  const due = parseISO(dueDate);
  if (!Number.isFinite(due.getTime())) return Number.NaN;
  return differenceInCalendarDays(effectivePlanningDate(dueDate), now);
}
