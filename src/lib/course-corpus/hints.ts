import { bestWindow, scheduleScore } from "@/lib/parse-syllabus";
import type { CourseEvidenceHints, CourseEvidenceSourceKind, EvidenceDateHint, EvidenceRoleSignal } from "@/lib/course-corpus/types";

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

const BREAK_RX = /\b(spring break|fall break|reading days?|reading period|holiday|thanksgiving break|labor day|memorial day|no class|no classes|class cancelled|cancelled class)\b/gi;
const ADMIN_RX = /\b(policy|attendance|grading|office hours?|contact info|academic integrity|accessibility|disability|late work|regrade|course information|welcome)\b/i;
const EVENT_RX = /\b(assignment|due|deadline|exam|quiz|midterm|final|review session|lab report|project)\b/i;
const CONTENT_RX = /\b(lecture|slides?|notes?|chapter|unit|worksheet|problem set|review|transcript|reading|lab|experiment)\b/i;
const SCHEDULE_RX = /\b(week\s+\d+|lecture\s+\d+|class schedule|course schedule|calendar|meeting times?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

export interface HintExtractionInput {
  sourceKind: CourseEvidenceSourceKind;
  title: string;
  bodyText?: string | null;
  structuredPayload?: Record<string, unknown> | null;
  termStartAt?: string | null;
  termEndAt?: string | null;
  remoteUpdatedAt?: string | Date | null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(normalizeWhitespace)) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function extractReferenceYear(input: HintExtractionInput): number {
  const candidates = [
    input.termStartAt,
    input.termEndAt,
    input.remoteUpdatedAt instanceof Date ? input.remoteUpdatedAt.toISOString() : input.remoteUpdatedAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (Number.isFinite(parsed.getTime())) return parsed.getUTCFullYear();
    const match = String(candidate).match(/\b(20\d{2})\b/);
    if (match) return Number.parseInt(match[1], 10);
  }
  return new Date().getUTCFullYear();
}

function parseMonthDate(rawMonth: string, rawDay: string, year: number): string | null {
  const month = MONTHS[rawMonth.toLowerCase()];
  if (!month) return null;
  const day = rawDay.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extractDateMentions(text: string, year: number): EvidenceDateHint[] {
  const hits: EvidenceDateHint[] = [];

  for (const match of text.matchAll(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:,\s*(20\d{2}))?\b/gi)) {
    const raw = match[0];
    const explicitYear = match[3] ? Number.parseInt(match[3], 10) : year;
    hits.push({
      raw,
      isoDate: parseMonthDate(match[1], match[2], explicitYear),
    });
  }

  for (const match of text.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}|\d{2}))?\b/g)) {
    const month = match[1].padStart(2, "0");
    const day = match[2].padStart(2, "0");
    const explicitYear = match[3]
      ? Number.parseInt(match[3].length === 2 ? `20${match[3]}` : match[3], 10)
      : year;
    hits.push({
      raw: match[0],
      isoDate: `${explicitYear}-${month}-${day}`,
    });
  }

  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.raw.toLowerCase()}:${hit.isoDate ?? "none"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractSequenceHints(text: string, rx: RegExp): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(rx)) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(parsed)) values.push(parsed);
  }
  return uniqueNumbers(values);
}

function collectRoleSignals(input: HintExtractionInput, combinedText: string, breakSignals: string[]): EvidenceRoleSignal[] {
  const roles = new Set<EvidenceRoleSignal>();
  const scheduleWindow = bestWindow(combinedText);
  const score = scheduleScore(scheduleWindow);
  const titleText = `${input.title}\n${combinedText}`;

  if (
    input.sourceKind === "canvas_syllabus_pdf" ||
    input.sourceKind === "canvas_syllabus_page" ||
    score >= 1.0 ||
    SCHEDULE_RX.test(titleText)
  ) {
    roles.add("schedule_like");
  }

  if (
    input.sourceKind === "canvas_assignment" ||
    input.sourceKind === "canvas_calendar_event" ||
    input.sourceKind === "canvas_announcement" ||
    EVENT_RX.test(titleText)
  ) {
    roles.add("event_like");
  }

  if (
    input.sourceKind === "canvas_linked_file" ||
    input.sourceKind === "canvas_page" ||
    input.sourceKind === "canvas_media_transcript" ||
    input.sourceKind === "manual_upload" ||
    input.sourceKind === "auto_route" ||
    CONTENT_RX.test(titleText)
  ) {
    roles.add("content_like");
  }

  if (ADMIN_RX.test(titleText)) {
    roles.add("admin_like");
  }

  if (breakSignals.length > 0) {
    roles.add("break_like");
    roles.add("schedule_like");
  }

  if (input.sourceKind === "canvas_media_transcript") {
    roles.add("content_like");
  }

  return [...roles];
}

export function extractCourseEvidenceHints(input: HintExtractionInput): CourseEvidenceHints {
  const bodyText = normalizeWhitespace(input.bodyText ?? "");
  const structuredText = input.structuredPayload ? normalizeWhitespace(JSON.stringify(input.structuredPayload)) : "";
  const combinedText = normalizeWhitespace([input.title, bodyText, structuredText].filter(Boolean).join("\n"));
  const year = extractReferenceYear(input);

  const breakSignals = uniqueStrings(
    Array.from(combinedText.matchAll(BREAK_RX)).map((match) => match[0] ?? ""),
  );
  const noClassSignals = breakSignals.filter((signal) => /\b(no class|cancelled|holiday|break)\b/i.test(signal));
  const roles = collectRoleSignals(input, combinedText, breakSignals);

  return {
    roles,
    dateMentions: extractDateMentions(combinedText, year),
    weekNumbers: extractSequenceHints(combinedText, /\bweek\s+(\d{1,2})\b/gi),
    lectureNumbers: extractSequenceHints(combinedText, /\blecture\s+(\d{1,3})\b/gi),
    unitNumbers: extractSequenceHints(combinedText, /\bunit\s+(\d{1,2})\b/gi),
    breakSignals,
    noClassSignals,
    sourceRoleSignals: uniqueStrings([
      ...roles,
      ...(EVENT_RX.test(combinedText) ? ["dated_event"] : []),
      ...(ADMIN_RX.test(combinedText) ? ["administrative"] : []),
      ...(CONTENT_RX.test(combinedText) ? ["content"] : []),
      ...(SCHEDULE_RX.test(combinedText) ? ["schedule"] : []),
    ]),
  };
}
