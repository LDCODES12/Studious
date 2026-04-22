import { addDays, addYears, parseISO, startOfWeek, subDays } from "date-fns";
import { renumberSequentialWeeks, type ParsedTopic } from "./parse-syllabus.ts";
import { type ReconciliationDiagnostics } from "./reconcile-canvas.ts";

export type TimelineQuality = "strong" | "usable" | "weak";

export interface FinalizeTimelineResult {
  topics: ParsedTopic[];
  warnings: string[];
  repairActionsApplied: string[];
  timelineQuality: TimelineQuality;
}

const FULL_BREAK_RX = /\bspring break\b|\bacademic break\b|\bread(?:ing)? days?\b|\bbye week\b|\bholiday\b|\bno classes\b/i;
const PARTIAL_NO_CLASS_RX =
  /\bno class(?:es)?\s+(?:on|for)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}\/\d{1,2})/i;
const GENERIC_WEEK_LABEL_RX =
  /^(lectures?|course resources|report discussions|midterm exam prep materials|review materials|assignment descriptions)$/i;
const ASSIGNMENT_FALLBACK_LABEL_RX = /^assignments?(?:\s+due)?\s+week\s+of\s+\d{4}-\d{2}-\d{2}$/i;
const ADMIN_ENTRY_RX =
  /^(syllabus|course schedule|office hours?|course information|course resources|exam resources)$/i;
const BREAK_SEGMENT_RX =
  /\bspring break\b|\bacademic break\b|\bread(?:ing)? days?\b|\bbye week\b|\bholiday\b|\bno classes?\b|\bno lecture\b|\bno lab\b/i;

export function hasInstructionalContent(topic: ParsedTopic): boolean {
  return (topic.topics?.length ?? 0) > 0 || (topic.readings?.length ?? 0) > 0;
}

export function normalizeNotesValue(notes: unknown): string | null {
  if (typeof notes === "string") {
    return notes.trim() ? notes : null;
  }
  if (Array.isArray(notes)) {
    const flattened = notes
      .flatMap((item) => (typeof item === "string" ? [item.trim()] : []))
      .filter(Boolean);
    return flattened.length > 0 ? flattened.join("; ") : null;
  }
  return null;
}

export function isBreakTopic(topic: ParsedTopic): boolean {
  const label = topic.weekLabel ?? "";
  const notes = normalizeNotesValue(topic.notes) ?? "";
  const text = `${label} ${notes}`.trim();
  if (!text) return false;

  if (FULL_BREAK_RX.test(label)) return true;
  if (FULL_BREAK_RX.test(notes) && !hasInstructionalContent(topic)) return true;

  if (!/\bno class\b/i.test(text)) return false;
  if (PARTIAL_NO_CLASS_RX.test(text) && hasInstructionalContent(topic)) return false;
  return !hasInstructionalContent(topic);
}

export function isAdministrativeOnlyTopic(topic: ParsedTopic): boolean {
  const entries = [...(topic.topics ?? []), ...(topic.readings ?? [])]
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 && entries.every((entry) => ADMIN_ENTRY_RX.test(entry));
}

export function isAssignmentFallbackLabel(label?: string | null): boolean {
  return Boolean(label && ASSIGNMENT_FALLBACK_LABEL_RX.test(label.trim()));
}

export function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function shiftIsoDateYears(dateStr: string, years: number): string | null {
  const parsed = parseISO(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return addYears(parsed, years).toISOString().slice(0, 10);
}

function realignTopicDatesToTerm(
  topics: ParsedTopic[],
  termStart: string | null,
  termEnd: string | null,
): { topics: ParsedTopic[]; shiftYears: number } {
  if (!termStart || topics.length === 0) {
    return { topics, shiftYears: 0 };
  }

  const termStartDate = parseISO(`${termStart}T12:00:00Z`);
  const termEndDate = parseISO(`${(termEnd ?? termStart)}T12:00:00Z`);
  if (Number.isNaN(termStartDate.getTime()) || Number.isNaN(termEndDate.getTime())) {
    return { topics, shiftYears: 0 };
  }

  const datedIndexes = topics
    .map((topic, index) => ({ index, startDate: topic.startDate }))
    .filter(
      (topic): topic is { index: number; startDate: string } =>
        typeof topic.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(topic.startDate),
    );

  if (datedIndexes.length < 2) {
    return { topics, shiftYears: 0 };
  }

  const paddedStart = subDays(termStartDate, 21);
  const paddedEnd = addDays(termEndDate, 21);
  const termYears = new Set([termStartDate.getUTCFullYear(), termEndDate.getUTCFullYear()]);

  const scoreShift = (shiftYears: number) => {
    let inRange = 0;
    let monotonic = true;
    let previous: string | null = null;

    for (const { startDate } of datedIndexes) {
      const shifted = shiftYears === 0 ? startDate : shiftIsoDateYears(startDate, shiftYears);
      if (!shifted) return null;
      const shiftedDate = parseISO(`${shifted}T12:00:00Z`);
      if (Number.isNaN(shiftedDate.getTime())) return null;
      if (shiftedDate >= paddedStart && shiftedDate <= paddedEnd) {
        inRange++;
      }
      if (previous && shifted < previous) {
        monotonic = false;
      }
      previous = shifted;
    }

    return { inRange, monotonic };
  };

  const baseScore = scoreShift(0);
  if (!baseScore) {
    return { topics, shiftYears: 0 };
  }

  const candidateShifts = new Set<number>();
  for (const { startDate } of datedIndexes) {
    const year = Number.parseInt(startDate.slice(0, 4), 10);
    for (const termYear of termYears) {
      candidateShifts.add(termYear - year);
    }
  }
  for (let shift = -3; shift <= 3; shift++) {
    candidateShifts.add(shift);
  }
  candidateShifts.delete(0);

  let bestShift = 0;
  let bestScore = baseScore;

  for (const shift of candidateShifts) {
    const score = scoreShift(shift);
    if (!score || !score.monotonic) continue;
    if (
      score.inRange > bestScore.inRange ||
      (score.inRange === bestScore.inRange && !bestScore.monotonic && score.monotonic)
    ) {
      bestShift = shift;
      bestScore = score;
    }
  }

  const minimumReliableMatches = Math.max(2, Math.ceil(datedIndexes.length * 0.6));
  if (
    bestShift === 0 ||
    bestScore.inRange < minimumReliableMatches ||
    bestScore.inRange <= baseScore.inRange
  ) {
    return { topics, shiftYears: 0 };
  }

  const shiftedTopics = topics.map((topic) => {
    if (!topic.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(topic.startDate)) {
      return topic;
    }
    const shifted = shiftIsoDateYears(topic.startDate, bestShift);
    return shifted ? { ...topic, startDate: shifted } : topic;
  });

  return { topics: shiftedTopics, shiftYears: bestShift };
}

function stripBreakSegments(notes?: unknown): string | null {
  const normalized = normalizeNotesValue(notes);
  if (!normalized) return null;
  const cleaned = normalized
    .split(/[;\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !BREAK_SEGMENT_RX.test(segment));
  return cleaned.length > 0 ? cleaned.join("; ") : null;
}

function cleanBreakLabel(label: string): string {
  return label
    .replace(/\s*(?:and|\/)\s*(spring break|academic break|reading days?|bye week|no classes?|no class|no lab|no lecture)\b.*$/i, "")
    .replace(/\s*[—-]\s*(spring break|academic break|reading days?|bye week|no classes?|no class|no lab|no lecture)\b.*$/i, "")
    .trim();
}

function summarizeBreakSegments(notes?: unknown): string | null {
  const normalized = normalizeNotesValue(notes);
  if (!normalized) return null;
  const segments = normalized
    .split(/[;\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && BREAK_SEGMENT_RX.test(segment));
  return segments.length > 0 ? segments.join("; ") : null;
}

function inferBreakLabel(topic: ParsedTopic): string {
  const text = `${topic.weekLabel ?? ""} ${normalizeNotesValue(topic.notes) ?? ""}`;
  if (/\bspring break\b/i.test(text)) return "Spring Break — No Class";
  if (/\bread(?:ing)? days?\b/i.test(text)) return "Reading Days";
  if (/\bbye week\b/i.test(text)) return "Bye Week — No Class";
  if (/\bholiday\b/i.test(text)) return "Holiday — No Class";
  return "No Class / Academic Break";
}

const MONTH_TO_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function normalizeCalendarYear(yearRaw: string): number {
  const year = Number.parseInt(yearRaw, 10);
  if (yearRaw.length === 2) return year < 70 ? 2000 + year : 1900 + year;
  return year;
}

function inferYearsForMonth(
  monthIndex: number,
  termStartDate: string | null,
  termEndDate: string | null,
): number[] {
  const years = new Set<number>();
  const start = termStartDate ? parseISO(`${termStartDate}T12:00:00Z`) : null;
  const end = termEndDate ? parseISO(`${termEndDate}T12:00:00Z`) : null;

  if (start && !Number.isNaN(start.getTime())) {
    years.add(start.getUTCFullYear());
    if (monthIndex < start.getUTCMonth()) years.add(start.getUTCFullYear() + 1);
  }
  if (end && !Number.isNaN(end.getTime())) {
    years.add(end.getUTCFullYear());
    if (monthIndex > end.getUTCMonth()) years.add(end.getUTCFullYear() - 1);
  }
  if (years.size === 0) years.add(new Date().getUTCFullYear());
  return [...years];
}

export function inferIsoDateFromText(
  text: string,
  termStartDate: string | null,
  termEndDate: string | null,
): string | undefined {
  if (!text.trim()) return undefined;

  const termStart = termStartDate ? parseISO(`${termStartDate}T12:00:00Z`) : null;
  const termEnd = termEndDate ? parseISO(`${termEndDate}T12:00:00Z`) : null;
  const windowStart = termStart && !Number.isNaN(termStart.getTime()) ? subDays(termStart, 21) : null;
  const windowEnd = termEnd && !Number.isNaN(termEnd.getTime()) ? addDays(termEnd, 21) : null;
  const candidates = new Set<string>();

  const monthDayYearRx =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:,?\s+(\d{2,4}))?\b/gi;
  for (const match of text.matchAll(monthDayYearRx)) {
    const monthIndex = MONTH_TO_INDEX[match[1].toLowerCase()];
    if (monthIndex == null) continue;
    const day = Number.parseInt(match[2], 10);
    const years = match[3]
      ? [normalizeCalendarYear(match[3])]
      : inferYearsForMonth(monthIndex, termStartDate, termEndDate);
    for (const year of years) {
      const candidate = new Date(Date.UTC(year, monthIndex, day, 12));
      if (Number.isNaN(candidate.getTime())) continue;
      if (windowStart && candidate < windowStart) continue;
      if (windowEnd && candidate > windowEnd) continue;
      candidates.add(candidate.toISOString().slice(0, 10));
    }
  }

  const numericDateRx = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  for (const match of text.matchAll(numericDateRx)) {
    const monthIndex = Number.parseInt(match[1], 10) - 1;
    const day = Number.parseInt(match[2], 10);
    if (monthIndex < 0 || monthIndex > 11) continue;
    const years = match[3]
      ? [normalizeCalendarYear(match[3])]
      : inferYearsForMonth(monthIndex, termStartDate, termEndDate);
    for (const year of years) {
      const candidate = new Date(Date.UTC(year, monthIndex, day, 12));
      if (Number.isNaN(candidate.getTime())) continue;
      if (windowStart && candidate < windowStart) continue;
      if (windowEnd && candidate > windowEnd) continue;
      candidates.add(candidate.toISOString().slice(0, 10));
    }
  }

  return [...candidates].sort()[0];
}

function inferBreakStartDate(
  topic: ParsedTopic,
  termStartDate: string | null,
  termEndDate: string | null,
): string | null {
  if (!topic.startDate) return null;
  const currentStart = parseISO(`${topic.startDate}T12:00:00Z`);
  if (Number.isNaN(currentStart.getTime())) return null;

  const notes = normalizeNotesValue(topic.notes) ?? "";
  const segments = `${topic.weekLabel ?? ""}; ${notes}`
    .split(/[;\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && BREAK_SEGMENT_RX.test(segment));
  if (segments.length === 0) return null;

  const prioritized = [
    ...segments.filter((segment) => /\bspring break\b/i.test(segment)),
    ...segments.filter(
      (segment) =>
        /\bread(?:ing)? days?\b|\bbye week\b|\bacademic break\b/i.test(segment) &&
        !/\bspring break\b/i.test(segment),
    ),
    ...segments.filter(
      (segment) =>
        !/\bspring break\b|\bread(?:ing)? days?\b|\bbye week\b|\bacademic break\b/i.test(segment),
    ),
  ];

  let sawExplicitBreakDate = false;
  for (const segment of prioritized) {
    const inferred = inferIsoDateFromText(segment, termStartDate, termEndDate);
    if (!inferred) continue;
    sawExplicitBreakDate = true;
    const explicit = parseISO(`${inferred}T12:00:00Z`);
    if (Number.isNaN(explicit.getTime())) continue;
    const monday = startOfWeek(explicit, { weekStartsOn: 1 });
    const mondayStr = monday.toISOString().slice(0, 10);
    if (mondayStr < topic.startDate && FULL_BREAK_RX.test(segment)) return mondayStr;
    if (mondayStr > topic.startDate) return mondayStr;
    if (
      mondayStr === topic.startDate &&
      /\bresum(?:e|es|ing)\b|\bclasses?\s+resume\b|\breturn(?:s|ing)?\b/i.test(segment) &&
      FULL_BREAK_RX.test(segment)
    ) {
      return addDays(currentStart, -7).toISOString().slice(0, 10);
    }
    if (
      mondayStr === topic.startDate &&
      explicit > currentStart &&
      /\bafter\b/i.test(segment) &&
      FULL_BREAK_RX.test(segment)
    ) {
      return addDays(currentStart, 7).toISOString().slice(0, 10);
    }
  }

  if (sawExplicitBreakDate) {
    return null;
  }

  if (prioritized.some((segment) => FULL_BREAK_RX.test(segment))) {
    return addDays(currentStart, 7).toISOString().slice(0, 10);
  }

  return null;
}

function splitMixedBreakWeeks(
  topics: ParsedTopic[],
  termStartDate: string | null,
  termEndDate: string | null,
): ParsedTopic[] {
  if (topics.length === 0) return topics;

  const existingBreakStarts = new Set(
    topics
      .filter((topic) => topic.startDate && isBreakTopic(topic))
      .map((topic) => topic.startDate as string),
  );

  const result: ParsedTopic[] = [];
  for (const topic of topics) {
    const breakStart = inferBreakStartDate(topic, termStartDate, termEndDate);
    const hasMixedBreakSignals =
      hasInstructionalContent(topic) &&
      BREAK_SEGMENT_RX.test(`${topic.weekLabel ?? ""} ${normalizeNotesValue(topic.notes) ?? ""}`) &&
      Boolean(breakStart);

    if (!hasMixedBreakSignals || !breakStart) {
      result.push(topic);
      continue;
    }

    result.push({
      ...topic,
      weekLabel: cleanBreakLabel(topic.weekLabel ?? "") || topic.weekLabel,
      notes: stripBreakSegments(topic.notes),
    });

    if (!existingBreakStarts.has(breakStart)) {
      existingBreakStarts.add(breakStart);
      const breakSortNumber = topic.startDate && breakStart < topic.startDate
        ? topic.weekNumber - 0.5
        : topic.weekNumber + 0.5;
      result.push({
        weekNumber: breakSortNumber,
        weekLabel: inferBreakLabel(topic),
        startDate: breakStart,
        topics: [],
        readings: [],
        notes: summarizeBreakSegments(topic.notes) ?? `No class — ${inferBreakLabel(topic)}`,
        courseName: topic.courseName,
      });
    }
  }

  return result;
}

function inferSpringBreakGapStart(previousDate: string, nextDate: string): string | null {
  const previous = parseISO(`${previousDate}T12:00:00Z`);
  const next = parseISO(`${nextDate}T12:00:00Z`);
  if (Number.isNaN(previous.getTime()) || Number.isNaN(next.getTime())) return null;

  const gapDays = (next.getTime() - previous.getTime()) / 86400_000;
  if (gapDays < 10 || gapDays > 21) return null;

  let cursor = startOfWeek(addDays(previous, 1), { weekStartsOn: 1 });
  while (cursor < next) {
    const candidate = cursor.toISOString().slice(0, 10);
    const isMarch = cursor.getUTCMonth() === 2;
    if (candidate > previousDate && candidate < nextDate && isMarch) return candidate;
    cursor = addDays(cursor, 7);
  }

  return null;
}

function insertSpringBreakGapTopics(topics: ParsedTopic[], courseName: string): ParsedTopic[] {
  if (topics.length < 8 || topics.some((topic) => isBreakTopic(topic))) return topics;

  const dated = topics
    .filter((topic): topic is ParsedTopic & { startDate: string } => Boolean(topic.startDate))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (dated.length < 2) return topics;

  const existingStarts = new Set(dated.map((topic) => topic.startDate));
  const additions: ParsedTopic[] = [];
  for (let i = 1; i < dated.length; i++) {
    const breakStart = inferSpringBreakGapStart(dated[i - 1].startDate, dated[i].startDate);
    if (!breakStart || existingStarts.has(breakStart)) continue;
    existingStarts.add(breakStart);
    additions.push({
      weekNumber: dated[i - 1].weekNumber + 0.5,
      weekLabel: "Spring Break — No Class",
      startDate: breakStart,
      topics: [],
      readings: [],
      notes: "Spring Break — no class/lab meetings.",
      courseName,
    });
  }

  if (additions.length === 0) return topics;

  additions.sort((a, b) => {
    const dateA = a.startDate ?? "";
    const dateB = b.startDate ?? "";
    return dateA.localeCompare(dateB) || a.weekNumber - b.weekNumber;
  });
  const selected = additions[0]!;

  console.log(`[pipeline] ${courseName}: inserted 1 spring break gap row`);
  return [...topics, selected];
}

function stripCarriedBreakNotes(
  topics: ParsedTopic[],
  termStartDate: string | null,
  termEndDate: string | null,
  courseName: string,
): ParsedTopic[] {
  if (topics.length === 0) return topics;

  const breakStarts = new Set(
    topics
      .filter((topic) => topic.startDate && isBreakTopic(topic))
      .map((topic) => topic.startDate as string),
  );

  let cleanedCount = 0;
  const cleaned = topics.map((topic) => {
    if (!topic.notes || isBreakTopic(topic)) return topic;

    const stripped = stripBreakSegments(topic.notes);
    if (stripped === topic.notes) return topic;

    const previousBreakStart = topic.startDate
      ? addDays(parseISO(`${topic.startDate}T12:00:00Z`), -7).toISOString().slice(0, 10)
      : null;
    const inferredBreakStart = inferBreakStartDate(topic, termStartDate, termEndDate);
    const hasNearbyBreak =
      (previousBreakStart ? breakStarts.has(previousBreakStart) : false) ||
      Boolean(inferredBreakStart && breakStarts.has(inferredBreakStart));

    if (!hasNearbyBreak) return topic;

    cleanedCount += 1;
    return {
      ...topic,
      notes: stripped,
    };
  });

  if (cleanedCount > 0) {
    console.log(
      `[pipeline] ${courseName}: stripped carried break notes from ${cleanedCount} instructional week(s)`,
    );
  }

  return cleaned;
}

export function isSparseTimeline(topics: ParsedTopic[]): boolean {
  if (topics.length < 2 || topics.length > 8) return false;
  const dated = topics.filter(
    (topic) => topic.startDate && /^\d{4}-\d{2}-\d{2}$/.test(topic.startDate),
  );
  if (dated.length < 2) return false;

  const gaps: number[] = [];
  for (let i = 1; i < dated.length; i++) {
    const previous = parseISO(`${dated[i - 1].startDate}T12:00:00Z`);
    const current = parseISO(`${dated[i].startDate}T12:00:00Z`);
    if (Number.isNaN(previous.getTime()) || Number.isNaN(current.getTime())) continue;
    gaps.push((current.getTime() - previous.getTime()) / 86400_000);
  }

  if (gaps.length === 0) return false;
  const averageGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  return averageGap > 10;
}

function validateTimeline(
  topics: ParsedTopic[],
  termStart: string | null,
  termEnd: string | null,
): { topics: ParsedTopic[]; warnings: string[] } {
  const warnings: string[] = [];

  if (topics.length === 0) {
    warnings.push("Pipeline produced 0 topics");
    return { topics, warnings };
  }

  const realigned = realignTopicDatesToTerm(topics, termStart, termEnd);
  topics = realigned.topics;
  if (realigned.shiftYears !== 0) {
    warnings.push(
      `Shifted topic dates by ${realigned.shiftYears} year(s) to align with term ${termStart}..${termEnd ?? "unknown"}`,
    );
  }

  topics = renumberSequentialWeeks(topics);

  const dated = topics.filter(
    (t) => t.startDate && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate!),
  );
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].startDate! < dated[i - 1].startDate!) {
      warnings.push(
        `Non-chronological: week ${dated[i].weekNumber} (${dated[i].startDate}) before week ${dated[i - 1].weekNumber} (${dated[i - 1].startDate})`,
      );
      dated[i].startDate = null;
    }
  }

  if (!isSparseTimeline(topics)) {
    for (let i = 1; i < dated.length; i++) {
      if (dated[i].startDate && dated[i - 1].startDate) {
        const gap =
          (new Date(dated[i].startDate!).getTime() - new Date(dated[i - 1].startDate!).getTime()) /
          86400_000;
        if (gap > 21) {
          warnings.push(
            `Large gap: ${Math.round(gap)} days between weeks ${dated[i - 1].weekNumber} and ${dated[i].weekNumber}`,
          );
        }
      }
    }
  }

  if (termStart && termEnd) {
    for (const t of dated) {
      if (t.startDate! < termStart || t.startDate! > termEnd) {
        warnings.push(`Date ${t.startDate} for week ${t.weekNumber} outside term ${termStart}..${termEnd}`);
      }
    }
  }

  for (const t of topics) {
    if (!t.weekLabel || t.weekLabel.trim() === "" || /^week\s+\d+$/i.test(t.weekLabel)) {
      warnings.push(`Weak weekLabel "${t.weekLabel}" on week ${t.weekNumber}`);
    }
  }

  if (topics.length > 18) {
    warnings.push(`Too many weeks (${topics.length}) — semester is typically 14-16 weeks`);
  }

  return { topics, warnings };
}

function pickPreferredWeekLabel(a: ParsedTopic, b: ParsedTopic): string {
  const score = (topic: ParsedTopic) => {
    let value = hasInstructionalContent(topic) ? 4 : 0;
    if (!isBreakTopic(topic)) value += 2;
    if (
      topic.weekLabel &&
      !GENERIC_WEEK_LABEL_RX.test(topic.weekLabel) &&
      !isAssignmentFallbackLabel(topic.weekLabel)
    ) {
      value += 2;
    }
    value += Math.min(2, topic.topics?.length ?? 0);
    return value;
  };
  return score(a) >= score(b) ? a.weekLabel : b.weekLabel;
}

function mergeTopicLists(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function mergeNotes(a?: string | null, b?: string | null): string | null {
  const notes = [...new Set([a, b].filter((note): note is string => Boolean(note && note.trim())))];
  return notes.length > 0 ? notes.join("; ") : null;
}

function collapseSameStartDateTopics(topics: ParsedTopic[], courseName: string): ParsedTopic[] {
  if (topics.length < 2) return topics;

  const ordered = [...topics].sort((a, b) => {
    if (a.startDate && b.startDate && a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    if (a.startDate && !b.startDate) return -1;
    if (!a.startDate && b.startDate) return 1;
    return a.weekNumber - b.weekNumber;
  });
  const collapsed: ParsedTopic[] = [];
  for (const topic of ordered) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.startDate && topic.startDate && previous.startDate === topic.startDate) {
      const previousAdminOnly = isAdministrativeOnlyTopic(previous);
      const topicAdminOnly = isAdministrativeOnlyTopic(topic);
      const mergedTopics =
        previousAdminOnly && !topicAdminOnly
          ? [...(topic.topics ?? [])]
          : topicAdminOnly && !previousAdminOnly
            ? [...(previous.topics ?? [])]
            : mergeTopicLists(previous.topics, topic.topics);
      const mergedReadings =
        previousAdminOnly && !topicAdminOnly
          ? [...(topic.readings ?? [])]
          : topicAdminOnly && !previousAdminOnly
            ? [...(previous.readings ?? [])]
            : mergeTopicLists(previous.readings, topic.readings);
      const merged: ParsedTopic = {
        ...(previousAdminOnly && !topicAdminOnly ? topic : previous),
        weekLabel: pickPreferredWeekLabel(previous, topic),
        topics: mergedTopics,
        readings: mergedReadings,
        notes: mergeNotes(previous.notes, topic.notes),
        courseName: topic.courseName ?? previous.courseName,
        startDate: previous.startDate,
      };
      collapsed[collapsed.length - 1] = merged;
      continue;
    }
    collapsed.push({
      ...topic,
      topics: [...(topic.topics ?? [])],
      readings: [...(topic.readings ?? [])],
    });
  }

  const normalized = renumberSequentialWeeks(collapsed);
  if (normalized.length !== topics.length) {
    console.log(
      `[pipeline] ${courseName}: collapsed ${topics.length - normalized.length} duplicate same-date week(s)`,
    );
  }
  return normalized;
}

function computeTimelineQuality(args: {
  topics: ParsedTopic[];
  warnings: string[];
  repairActionsApplied: string[];
  reconciliation: ReconciliationDiagnostics;
  usedModuleScaffold: boolean;
}): TimelineQuality {
  const datedTopics = args.topics.filter((topic) => Boolean(topic.startDate));
  const datedRatio = args.topics.length > 0 ? datedTopics.length / args.topics.length : 0;
  const warningPenalty = args.warnings.length;
  const repairPenalty = args.repairActionsApplied.filter(
    (action) => action !== "used_module_scaffold",
  ).length;
  const verifiedOrCorroborated = args.reconciliation.verified + args.reconciliation.corroborated;
  const totalReconciled =
    verifiedOrCorroborated + args.reconciliation.unverified + args.reconciliation.conflicted;

  if (
    datedRatio >= 0.8 &&
    warningPenalty === 0 &&
    repairPenalty === 0 &&
    !args.usedModuleScaffold &&
    (totalReconciled === 0 || verifiedOrCorroborated / totalReconciled >= 0.5)
  ) {
    return "strong";
  }

  if (
    datedRatio >= 0.5 &&
    warningPenalty <= 2 &&
    args.reconciliation.conflicted <= 1
  ) {
    return "usable";
  }

  return "weak";
}

export function finalizeTimelineForPersistence(args: {
  topics: ParsedTopic[];
  termStartDate: string | null;
  termEndDate: string | null;
  courseName: string;
  usedModuleScaffold: boolean;
  reconciliation: ReconciliationDiagnostics;
}): FinalizeTimelineResult {
  const repairActionsApplied: string[] = [];

  let finalizedTopics = args.topics;

  const preStrippedBreakNotesTopics = stripCarriedBreakNotes(
    finalizedTopics,
    args.termStartDate,
    args.termEndDate,
    args.courseName,
  );
  if (preStrippedBreakNotesTopics.some((topic, index) => topic.notes !== finalizedTopics[index]?.notes)) {
    repairActionsApplied.push("stripped_carried_break_notes");
  }
  finalizedTopics = preStrippedBreakNotesTopics;

  const splitBreakTopics = splitMixedBreakWeeks(
    finalizedTopics,
    args.termStartDate,
    args.termEndDate,
  );
  if (splitBreakTopics.length > finalizedTopics.length) {
    repairActionsApplied.push(
      `split_mixed_break_weeks:${splitBreakTopics.length - finalizedTopics.length}`,
    );
  }
  finalizedTopics = splitBreakTopics;

  const springBreakGapTopics = insertSpringBreakGapTopics(finalizedTopics, args.courseName);
  if (springBreakGapTopics.length > finalizedTopics.length) {
    repairActionsApplied.push(
      `inserted_spring_break_gap:${springBreakGapTopics.length - finalizedTopics.length}`,
    );
  }
  finalizedTopics = springBreakGapTopics;

  const collapsedTopics = collapseSameStartDateTopics(finalizedTopics, args.courseName);
  if (collapsedTopics.length < finalizedTopics.length) {
    repairActionsApplied.push(
      `collapsed_duplicate_same_date_weeks:${finalizedTopics.length - collapsedTopics.length}`,
    );
  }
  finalizedTopics = collapsedTopics;

  const strippedBreakNotesTopics = stripCarriedBreakNotes(
    finalizedTopics,
    args.termStartDate,
    args.termEndDate,
    args.courseName,
  );
  if (
    !repairActionsApplied.includes("stripped_carried_break_notes") &&
    strippedBreakNotesTopics.some((topic, index) => topic.notes !== finalizedTopics[index]?.notes)
  ) {
    repairActionsApplied.push("stripped_carried_break_notes");
  }
  finalizedTopics = strippedBreakNotesTopics;

  for (const topic of finalizedTopics) {
    if (topic.readings && topic.readings.length > 1) {
      const seen = new Set<string>();
      topic.readings = topic.readings.filter((reading) => {
        const norm = normalizeForDedup(reading);
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
      });
    }
    if (topic.topics && topic.topics.length > 1) {
      const seen = new Set<string>();
      topic.topics = topic.topics.filter((entry) => {
        const norm = normalizeForDedup(entry);
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
      });
    }
  }

  const validated = validateTimeline(finalizedTopics, args.termStartDate, args.termEndDate);
  finalizedTopics = validated.topics;
  if (validated.warnings.some((warning) => warning.startsWith("Shifted topic dates by "))) {
    repairActionsApplied.push("realigned_term_dates");
  }
  if (args.usedModuleScaffold) {
    repairActionsApplied.push("used_module_scaffold");
  }

  const timelineQuality = computeTimelineQuality({
    topics: finalizedTopics,
    warnings: validated.warnings,
    repairActionsApplied,
    reconciliation: args.reconciliation,
    usedModuleScaffold: args.usedModuleScaffold,
  });

  return {
    topics: finalizedTopics,
    warnings: validated.warnings,
    repairActionsApplied,
    timelineQuality,
  };
}
