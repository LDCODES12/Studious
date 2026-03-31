/**
 * Reconcile AI-extracted schedule against Canvas ground truth.
 *
 * Purely deterministic — no AI calls. Compares extracted topics against
 * Canvas assignment due dates and produces verification states:
 *   verified    — title match + date within 1 day
 *   corroborated — some title overlap + date within same week
 *   unverified  — no Canvas match nearby (not wrong, just unconfirmed)
 *   conflicted  — clear title match but dates differ >7 days
 *   gap         — no data for this week at all
 */

import { parseISO, differenceInCalendarDays, startOfWeek, addDays } from "date-fns";
import type { ParsedTopic } from "./parse-syllabus.ts";
import type { AssignmentDateInfo, SyllabusEventInfo, ClassScheduleInfo } from "./topic-pipeline.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export type VerificationStatus =
  | "verified"
  | "corroborated"
  | "unverified"
  | "conflicted"
  | "gap";

export interface ReconciledTopic extends ParsedTopic {
  verificationStatus: VerificationStatus;
  sourceBlock: string;
  matchedAssignment?: { title: string; dueDate: string };
}

export interface ReconciliationInput {
  extractedTopics: ParsedTopic[];
  assignments: AssignmentDateInfo[];
  syllabusEvents: SyllabusEventInfo[];
  termStartDate: string | null;
  termEndDate: string | null;
  classSchedule: ClassScheduleInfo | null;
  sourceBlock: string; // schedule_table | syllabus_body | canvas_assignments | canvas_modules
}

export interface ReconciliationDiagnostics {
  verified: number;
  corroborated: number;
  unverified: number;
  conflicted: number;
  gaps: number;
  dayOfWeekMismatches: number;
  outOfTermBounds: number;
}

export interface ReconciliationResult {
  topics: ReconciledTopic[];
  diagnostics: ReconciliationDiagnostics;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const TOKEN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "in", "to", "on", "with",
  "unit", "module", "week", "lecture", "lectures", "chapter", "introduction",
  "due", "assignment", "homework", "hw", "quiz", "exam",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !TOKEN_STOPWORDS.has(w)),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count++;
  }
  return count;
}

function safeParseDate(dateStr: string): Date | null {
  const d = parseISO(`${dateStr.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mondayOfWeek(dateStr: string): string | null {
  const d = safeParseDate(dateStr);
  if (!d) return null;
  return startOfWeek(d, { weekStartsOn: 1 }).toISOString().slice(0, 10);
}

// ─── Canvas Date Index ──────────────────────────────────────────────────────

interface CanvasDateEntry {
  title: string;
  dueDate: string; // YYYY-MM-DD
  titleTokens: Set<string>;
  weekMonday: string;
}

function buildCanvasDateIndex(
  assignments: AssignmentDateInfo[],
  _syllabusEvents: SyllabusEventInfo[],
): CanvasDateEntry[] {
  const entries: CanvasDateEntry[] = [];

  for (const a of assignments) {
    if (!a.dueDate) continue;
    const dateStr = a.dueDate.slice(0, 10);
    const monday = mondayOfWeek(dateStr);
    if (!monday) continue;
    entries.push({
      title: a.title,
      dueDate: dateStr,
      titleTokens: tokenize(a.title),
      weekMonday: monday,
    });
  }

  return entries;
}

// ─── Day-of-Week Check ──────────────────────────────────────────────────────

const DAY_CODES: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

function getClassMeetingDays(classSchedule: ClassScheduleInfo | null): Set<number> | null {
  if (!classSchedule?.meetings?.length) return null;
  const days = new Set<number>();
  for (const m of classSchedule.meetings) {
    for (const d of m.days) {
      const code = DAY_CODES[d.toUpperCase()];
      if (code !== undefined) days.add(code);
    }
  }
  return days.size > 0 ? days : null;
}

// ─── Core Reconciliation ────────────────────────────────────────────────────

function matchTopicAgainstCanvas(
  topic: ParsedTopic,
  canvasEntries: CanvasDateEntry[],
  classDays: Set<number> | null,
  termStartDate: string | null,
  termEndDate: string | null,
): {
  status: VerificationStatus;
  match?: { title: string; dueDate: string };
  dayMismatch: boolean;
  outOfBounds: boolean;
} {
  const topicDate = topic.startDate;
  let dayMismatch = false;
  let outOfBounds = false;

  // No date — can't reconcile against Canvas
  if (!topicDate || !/^\d{4}-\d{2}-\d{2}$/.test(topicDate)) {
    return { status: "unverified", dayMismatch: false, outOfBounds: false };
  }

  const parsedTopicDate = safeParseDate(topicDate);
  if (!parsedTopicDate) {
    return { status: "unverified", dayMismatch: false, outOfBounds: false };
  }

  // Day-of-week check
  if (classDays && classDays.size > 0) {
    const dow = parsedTopicDate.getUTCDay();
    // startDate is typically the Monday of the week, not necessarily a class day.
    // Only flag if it's a weekend (and class doesn't meet on weekends).
    if ((dow === 0 || dow === 6) && !classDays.has(dow)) {
      dayMismatch = true;
    }
  }

  // Term bounds check (14-day grace period)
  if (termStartDate) {
    const termStart = safeParseDate(termStartDate);
    if (termStart && differenceInCalendarDays(termStart, parsedTopicDate) > 14) {
      outOfBounds = true;
    }
  }
  if (termEndDate) {
    const termEnd = safeParseDate(termEndDate);
    if (termEnd && differenceInCalendarDays(parsedTopicDate, termEnd) > 14) {
      outOfBounds = true;
    }
  }

  // Build tokens from topic text
  const topicTokens = tokenize(
    [topic.weekLabel, ...(topic.topics ?? []), ...(topic.readings ?? [])].join(" "),
  );

  const topicMonday = mondayOfWeek(topicDate);

  let bestMatch: { title: string; dueDate: string; overlap: number; dayDiff: number } | null = null;

  for (const entry of canvasEntries) {
    const entryDate = safeParseDate(entry.dueDate);
    if (!entryDate) continue;

    const dayDiff = Math.abs(differenceInCalendarDays(parsedTopicDate, entryDate));
    const overlap = tokenOverlap(topicTokens, entry.titleTokens);

    // Skip entries with no meaningful title overlap
    if (overlap < 2) continue;

    if (
      !bestMatch ||
      overlap > bestMatch.overlap ||
      (overlap === bestMatch.overlap && dayDiff < bestMatch.dayDiff)
    ) {
      bestMatch = { title: entry.title, dueDate: entry.dueDate, overlap, dayDiff };
    }
  }

  if (!bestMatch) {
    // No title match — check if any Canvas entry falls in the same week
    // (even without title overlap, same-week proximity is weak corroboration)
    if (topicMonday) {
      const sameWeek = canvasEntries.some((e) => e.weekMonday === topicMonday);
      if (sameWeek) {
        return { status: "unverified", dayMismatch, outOfBounds };
      }
    }
    return { status: "unverified", dayMismatch, outOfBounds };
  }

  // Title match found — classify by date proximity
  if (bestMatch.dayDiff <= 1) {
    return {
      status: "verified",
      match: { title: bestMatch.title, dueDate: bestMatch.dueDate },
      dayMismatch,
      outOfBounds,
    };
  }

  if (bestMatch.dayDiff <= 7) {
    return {
      status: "corroborated",
      match: { title: bestMatch.title, dueDate: bestMatch.dueDate },
      dayMismatch,
      outOfBounds,
    };
  }

  // Title match but dates are far apart
  return {
    status: "conflicted",
    match: { title: bestMatch.title, dueDate: bestMatch.dueDate },
    dayMismatch,
    outOfBounds,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function reconcileAgainstCanvas(input: ReconciliationInput): ReconciliationResult {
  const canvasEntries = buildCanvasDateIndex(input.assignments, input.syllabusEvents);
  const classDays = getClassMeetingDays(input.classSchedule);

  const diagnostics: ReconciliationDiagnostics = {
    verified: 0,
    corroborated: 0,
    unverified: 0,
    conflicted: 0,
    gaps: 0,
    dayOfWeekMismatches: 0,
    outOfTermBounds: 0,
  };

  const reconciledTopics: ReconciledTopic[] = [];

  for (const topic of input.extractedTopics) {
    const result = matchTopicAgainstCanvas(
      topic,
      canvasEntries,
      classDays,
      input.termStartDate,
      input.termEndDate,
    );

    if (result.status === "gap") {
      diagnostics.gaps++;
    } else {
      diagnostics[result.status]++;
    }
    if (result.dayMismatch) diagnostics.dayOfWeekMismatches++;
    if (result.outOfBounds) diagnostics.outOfTermBounds++;

    reconciledTopics.push({
      ...topic,
      verificationStatus: result.status,
      sourceBlock: input.sourceBlock,
      matchedAssignment: result.match,
    });
  }

  // Gap detection: walk term week-by-week, find weeks with no topic
  if (input.termStartDate && input.termEndDate) {
    const termStart = safeParseDate(input.termStartDate);
    const termEnd = safeParseDate(input.termEndDate);
    if (termStart && termEnd) {
      const topicMondays = new Set(
        reconciledTopics
          .filter((t) => t.startDate)
          .map((t) => mondayOfWeek(t.startDate!))
          .filter(Boolean) as string[],
      );

      let cursor = startOfWeek(termStart, { weekStartsOn: 1 });
      const endMonday = startOfWeek(termEnd, { weekStartsOn: 1 });

      while (cursor <= endMonday) {
        const mondayStr = cursor.toISOString().slice(0, 10);
        if (!topicMondays.has(mondayStr)) {
          diagnostics.gaps++;
        }
        cursor = addDays(cursor, 7);
      }
    }
  }

  return { topics: reconciledTopics, diagnostics };
}
