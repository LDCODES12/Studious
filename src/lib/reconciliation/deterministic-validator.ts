/**
 * Deterministic validator — the final gate before DB persistence.
 *
 * Enforces ONLY hard invariants. Never makes ambiguity decisions.
 * Never inserts breaks, repairs dates, deduplicates topics, or merges content.
 * All of those are the AI's job.
 *
 * A student with a barebones Canvas course shouldn't get zero output
 * because the validator demands 14 dated weeks.
 */

import type { ReconciliationResult, ValidationResult } from "./types.ts";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function validateOutput(
  result: ReconciliationResult,
  termStartDate: string | null,
  termEndDate: string | null,
): ValidationResult {
  const hardErrors: string[] = [];
  const softWarnings: string[] = [];

  // Empty weeks are valid if evidence is truly absent
  if (result.weeks.length === 0) {
    if (result.scheduleMode !== "unknown") {
      softWarnings.push(`Empty weeks with scheduleMode "${result.scheduleMode}" — expected "unknown"`);
    }
    return { valid: true, hardErrors: [], softWarnings };
  }

  // weekNumbers must be sequential 1..N
  for (let i = 0; i < result.weeks.length; i++) {
    if (result.weeks[i].weekNumber !== i + 1) {
      hardErrors.push(
        `Week at index ${i} has weekNumber ${result.weeks[i].weekNumber}, expected ${i + 1}`,
      );
    }
  }

  // startDates must be valid format where present
  const datedWeeks = result.weeks.filter((w) => w.startDate !== null);
  for (const week of datedWeeks) {
    if (!DATE_REGEX.test(week.startDate!)) {
      hardErrors.push(`Week ${week.weekNumber}: invalid startDate format "${week.startDate}"`);
    }
  }

  // startDates must be chronologically ordered
  const validDatedWeeks = datedWeeks.filter((w) => DATE_REGEX.test(w.startDate!));
  for (let i = 1; i < validDatedWeeks.length; i++) {
    if (validDatedWeeks[i].startDate! <= validDatedWeeks[i - 1].startDate!) {
      hardErrors.push(
        `Week ${validDatedWeeks[i].weekNumber} startDate ${validDatedWeeks[i].startDate} is not after week ${validDatedWeeks[i - 1].weekNumber} startDate ${validDatedWeeks[i - 1].startDate}`,
      );
    }
  }

  // No duplicate startDates
  const dateSet = new Set<string>();
  for (const week of validDatedWeeks) {
    if (dateSet.has(week.startDate!)) {
      hardErrors.push(`Duplicate startDate ${week.startDate} on week ${week.weekNumber}`);
    }
    dateSet.add(week.startDate!);
  }

  // scheduleMode must be valid
  const validModes = ["weekly", "sparse", "inferred", "unknown"];
  if (!validModes.includes(result.scheduleMode)) {
    hardErrors.push(`Invalid scheduleMode "${result.scheduleMode}"`);
  }

  // ─── Soft warnings (log but persist) ─────────────────────────────────────

  // Week count
  if (result.weeks.length > 20) {
    softWarnings.push(`Unusually high week count: ${result.weeks.length}`);
  }

  // Large gaps between dated weeks without breaks
  for (let i = 1; i < validDatedWeeks.length; i++) {
    const prev = validDatedWeeks[i - 1];
    const curr = validDatedWeeks[i];
    const gapDays = daysBetween(prev.startDate!, curr.startDate!);

    if (gapDays > 21) {
      // Check if there's a break week between them
      const hasBetweenBreak = result.weeks.some(
        (w) =>
          !w.isInstructional &&
          w.weekNumber > prev.weekNumber &&
          w.weekNumber < curr.weekNumber,
      );
      if (!hasBetweenBreak) {
        softWarnings.push(
          `${gapDays}-day gap between week ${prev.weekNumber} and ${curr.weekNumber} with no break`,
        );
      }
    }
  }

  // Generic week labels
  const genericLabelCount = result.weeks.filter(
    (w) => /^Week\s+\d+$/i.test(w.weekLabel),
  ).length;
  if (genericLabelCount > result.weeks.length * 0.5) {
    softWarnings.push(`${genericLabelCount}/${result.weeks.length} weeks have generic "Week N" labels`);
  }

  // Dates outside term bounds
  if (termStartDate && termEndDate) {
    for (const week of validDatedWeeks) {
      const daysBefore = daysBetween(week.startDate!, termStartDate);
      const daysAfter = daysBetween(termEndDate, week.startDate!);
      if (daysBefore > 14) {
        softWarnings.push(
          `Week ${week.weekNumber} startDate ${week.startDate} is ${daysBefore} days before term start`,
        );
      }
      if (daysAfter > 14) {
        softWarnings.push(
          `Week ${week.weekNumber} startDate ${week.startDate} is ${daysAfter} days after term end`,
        );
      }
    }
  }

  return {
    valid: hardErrors.length === 0,
    hardErrors,
    softWarnings,
  };
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T12:00:00");
  const b = new Date(dateB + "T12:00:00");
  return Math.round(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
