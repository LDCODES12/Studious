import { generateObject } from "ai";
import { modelConfig, type ReasoningTier } from "./ai-models.ts";
import { z } from "zod";

export interface ParsedEvent {
  title: string;
  type: "assignment" | "exam" | "quiz" | "project" | "reading" | "lab" | "other";
  dueDate: string;
  courseName: string;
  description: string | null;
}

// ─── Shared Zod Schemas ──────────────────────────────────────────────────────

const parsedEventSchema = z.object({
  events: z.array(z.object({
    title: z.string(),
    type: z.enum(["assignment", "exam", "quiz", "project", "reading", "lab", "other"]),
    dueDate: z.string(),
    courseName: z.string(),
    description: z.string().nullable(),
  })),
});

const dropRulesSchema = z.object({
  rules: z.array(z.object({
    groupName: z.string(),
    dropLowest: z.number(),
    dropHighest: z.number(),
  })),
});

/** Shared schema for ParsedTopic — also used by topic-pipeline.ts */
export const parsedTopicSchema = z.object({
  weekNumber: z.number(),
  weekLabel: z.string(),
  startDate: z.string().nullable(),
  topics: z.array(z.string()),
  readings: z.array(z.string()),
  notes: z.string().nullable(),
  courseName: z.string(),
});

const classScheduleSchema = z.object({
  meetings: z.array(z.object({
    label: z.string(),
    days: z.array(z.string()),
    startTime: z.string(),
    endTime: z.string(),
    location: z.string(),
  })),
  semesterStart: z.string().nullable(),
  semesterEnd: z.string().nullable(),
  finalExamDate: z.string().nullable(),
});

export async function parseSyllabusText(text: string): Promise<ParsedEvent[]> {
  try {
    const { object } = await generateObject({
      ...modelConfig("low"),
      schema: parsedEventSchema,
      system: `You are a syllabus parser. Extract every graded assessment (quizzes, exams, assignments, projects, labs) that has an explicitly written date in the syllabus. Include all of them — do not miss any.

WHAT TO INCLUDE:
- Every quiz date explicitly listed (check all tables, schedules, and regrade sections — they often contain quiz dates in a "Quiz Date" column)
- Every midterm and final exam date
- Every assignment or project with an explicit due date
- If a table lists quiz dates (e.g. a regrade request table with a "Quiz Date" column), extract each quiz as a separate quiz event using the date in that column

WHAT TO EXCLUDE:
- Regrade deadlines (e.g. "deadline for requesting a regrade") — these are NOT assessments
- Administrative events (e.g. "discussion subsections begin", "help sessions begin")
- Anything where dates are not written in the syllabus (e.g. "check Canvas for due dates")
- Non-graded readings, optional activities, office hours

RULES:
- Only use dates explicitly written in the syllabus text. Never estimate or extrapolate.
- Each quiz/exam should appear exactly once with its own date.
- If multiple quizzes are listed in a table, create one entry per quiz.
- Use the year from the syllabus header (e.g. Spring 2026 → year is 2026).`,
      prompt: text,
      abortSignal: AbortSignal.timeout(45_000),
      maxRetries: 1,
    });

    return object.events;
  } catch {
    return [];
  }
}

// ─── Drop Rule Extraction ─────────────────────────────────────────────────────

export interface ExtractedDropRule {
  groupName: string;   // approximate group name from syllabus (e.g. "Quiz", "Homework")
  dropLowest: number;
  dropHighest: number;
}

/**
 * Scans syllabus text for drop rules like "lowest quiz dropped", "drop 2 lowest homeworks".
 * Returns rules per assignment group so they can be matched to Canvas groups.
 */
export async function extractDropRules(text: string): Promise<ExtractedDropRule[]> {
  const truncated = text.slice(0, 8000);
  try {
    const { object } = await generateObject({
      ...modelConfig("low"),
      schema: dropRulesSchema,
      system: `You are a grading policy parser. Find every statement in this syllabus that says a certain number of lowest or highest scores will be dropped for a category of assignments.

Examples to detect:
- "The lowest quiz score will be dropped" → groupName: "Quiz", dropLowest: 1
- "We will drop your 2 lowest homework grades" → groupName: "Homework", dropLowest: 2
- "Your worst lab score is removed" → groupName: "Lab", dropLowest: 1
- "Drop lowest 3 participation scores" → groupName: "Participation", dropLowest: 3
- "The highest extra credit will be dropped" → groupName: "Extra Credit", dropHighest: 1

Rules:
- Only extract explicitly stated drop rules, never infer them
- groupName should be the category name as stated in the syllabus (e.g. "Quiz", "Homework", "Lab")
- If no drop rules are found, return an empty array
- Do not include regrade policies or late work policies`,
      prompt: truncated,
      abortSignal: AbortSignal.timeout(20_000),
      maxRetries: 1,
    });

    return object.rules.filter(
      (r) => r.dropLowest > 0 || r.dropHighest > 0
    );
  } catch {
    return [];
  }
}

export interface ParsedTopic {
  weekNumber: number;
  weekLabel: string;
  startDate: string | null;
  topics: string[];
  readings: string[];
  notes: string | null;
  courseName: string;
}

export function renumberSequentialWeeks(weeks: ParsedTopic[]): ParsedTopic[] {
  return [...weeks]
    .sort((a, b) => a.weekNumber - b.weekNumber)
    .map((w, i) => ({ ...w, weekNumber: i + 1 }));
}

// ─── Role 4 — Sanitizer ────────────────────────────────────────────────────────
//
// Code-only cleanup pass that runs immediately after AI extraction.
// Removes policy-contaminated content, fixes week numbering, sorts by date.
// Free (no API call) — always runs.

/** Policy-only week labels — weeks whose label matches AND have no topics/readings are dropped. */
const POLICY_LABEL_RX =
  /^(grading|attendance\s+polic|academic\s+integrity|course\s+polic|syllabus\s+(overview|review)|late\s+(work|submission)\s+polic|extra\s+credit\s+polic|office\s+hours\s+polic|contact\s+info)/i;

/** Topic/reading strings that are course-admin text, not academic content. */
const POLICY_TOPIC_RX =
  /\b(attendance\s+polic|plagiarism\s+polic|academic\s+(dishonesty|integrity)\s+polic|late\s+(work|submission|assignment)\s+polic|grading\s+polic|extra\s+credit\s+polic|point[s]?\s+possible\s*:)\b/i;

/**
 * Cleans an AI-extracted schedule in place:
 * 1. Strips policy-language strings from topics/readings arrays
 * 2. Drops weeks where the label is purely administrative with no real content
 * 3. Sorts by weekNumber, then renumbers 1…N to close any gaps
 */
export function sanitizeSchedule(weeks: ParsedTopic[]): ParsedTopic[] {
  return weeks
    // 1. Strip policy strings from topic/reading arrays within each week
    .map((w) => ({
      ...w,
      topics: (w.topics ?? []).filter((t) => !POLICY_TOPIC_RX.test(t)),
      readings: (w.readings ?? []).filter((r) => !POLICY_TOPIC_RX.test(r)),
    }))
    // 2. Drop weeks whose label sounds like admin-only AND have no real content
    .filter((w) => {
      if (
        POLICY_LABEL_RX.test(w.weekLabel.trim()) &&
        w.topics.length === 0 &&
        w.readings.length === 0 &&
        !w.notes
      ) {
        return false;
      }
      return true;
    })
    // 3. Sort ascending by weekNumber (preserve original numbering for cross-source merge)
    .sort((a, b) => a.weekNumber - b.weekNumber);
}

// ─── Role 5 — Auditor ─────────────────────────────────────────────────────────
//
// AI second-pass that receives both the extracted JSON and the original source
// text. Corrects errors the Sanitizer can't catch: wrong week labels, misread
// table structure, out-of-order dates, hallucinated topics.
//
// Triggered only when the result looks suspicious (partial, contaminated, or
// date-sequence broken) — typically costs ~$0.001 per course when it fires.

/**
 * Returns true when the extracted schedule has signs of problems that
 * warrant a second AI review pass.
 */
export function needsAudit(weeks: ParsedTopic[]): boolean {
  if (weeks.length < 5) return true; // suspiciously few weeks (< 5 catches failures without over-auditing short intensive courses)

  const emptyWeeks = weeks.filter(
    (w) => (w.topics ?? []).length === 0 && (w.readings ?? []).length === 0 && !w.notes
  ).length;
  if (emptyWeeks / weeks.length > 0.25) return true; // >25% empty rows

  // Check for non-monotonic startDates (AI hallucinated or reordered dates)
  const dates = weeks
    .filter((w) => w.startDate && /^\d{4}-\d{2}-\d{2}$/.test(w.startDate))
    .map((w) => w.startDate!);
  if (dates.length > 2) {
    for (let i = 1; i < dates.length; i++) {
      if (dates[i] < dates[i - 1]) return true;
    }
  }

  return false;
}

/**
 * Sends the extracted weeks + source snippet to gpt-5.4-nano for a quality
 * review. The model corrects week labels, removes hallucinated or policy
 * topics, fixes date ordering, and drops empty weeks.
 *
 * Falls back to the input weeks if the AI call fails or returns nothing useful.
 */
export async function auditSchedule(
  weeks: ParsedTopic[],
  sourceText: string
): Promise<ParsedTopic[]> {
  const auditSchema = z.object({ weeks: z.array(parsedTopicSchema) });

  try {
    const { object } = await generateObject({
      ...modelConfig("medium"),
      schema: auditSchema,
      system: `You are a schedule quality auditor. You will receive:
1. EXTRACTED SCHEDULE — a JSON array of schedule entries (possibly with errors). Entries may represent weeks OR individual lectures — preserve whichever granularity was extracted.
2. ORIGINAL SOURCE — the text window used for extraction (up to 12k chars)

Your job is to fix the extracted schedule:
- Remove topics or readings that are course policy text (grading rules, attendance rules, late penalties, office hours). Academic content only.
- Fix vague weekLabels like "Regular Class" or "TBD" — use actual topic names from the source if you can find them.
- Remove entries that have no real topics or readings after cleanup.
- Ensure weekNumbers are sequential with no gaps — renumber if needed.
- Validate startDates: they must increase chronologically. Remove or fix dates that are out of order.
- Do NOT invent topics that aren't in the source. Only fix, never fabricate.
- PRESERVE GRANULARITY: If the input has one entry per lecture (e.g. 41 entries for 41 lectures), keep them as individual entries. Do NOT collapse or merge lectures into weeks — that is handled by a downstream stage.`,
      prompt: `EXTRACTED SCHEDULE:\n${JSON.stringify(weeks, null, 2)}\n\nORIGINAL SOURCE:\n${sourceText.slice(0, 12000)}`,
      abortSignal: AbortSignal.timeout(60_000),
      maxRetries: 1,
    });

    const audited = object.weeks as ParsedTopic[];
    // Accept only if the audit produced at least half as many weeks (avoid catastrophic drops)
    if (audited.length >= Math.max(1, weeks.length / 2)) {
      return audited;
    }
  } catch {
    // generation failed — return unmodified
  }
  return weeks;
}

// ─── Class Schedule Extraction ────────────────────────────────────────────────

export interface ClassMeeting {
  label: string;      // "Lecture" | "Lab" | "Discussion" | "Recitation" | etc.
  days: string[];     // RFC 5545 day codes: "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
  startTime: string;  // 24-hour HH:MM
  endTime: string;    // 24-hour HH:MM
  location: string;   // Room/building, or ""
}

export interface ExtractedClassSchedule {
  meetings: ClassMeeting[];
  semesterStart: string | null;  // ISO YYYY-MM-DD
  semesterEnd: string | null;    // ISO YYYY-MM-DD
  finalExamDate: string | null;  // ISO YYYY-MM-DD — extracted from "Final exam: May 5" etc.
}

function to24HourTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ?? "00";
  const ap = m[3].toUpperCase();
  if (hour === 12) hour = ap === "A" ? 0 : 12;
  else if (ap === "P") hour += 12;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function parseDaysFromText(text: string): string[] {
  const hits = new Set<string>();
  const lower = text.toLowerCase();

  const fullDayMap: [RegExp, string][] = [
    [/\bmondays?\b/g, "MO"],
    [/\btuesdays?\b/g, "TU"],
    [/\bwednesdays?\b/g, "WE"],
    [/\bthursdays?\b/g, "TH"],
    [/\bfridays?\b/g, "FR"],
    [/\bsaturdays?\b/g, "SA"],
    [/\bsundays?\b/g, "SU"],
  ];
  for (const [rx, code] of fullDayMap) {
    if (rx.test(lower)) hits.add(code);
  }

  if (hits.size === 0) {
    // Common compact forms: MWF, TR, TuTh, Mon/Wed/Fri, Tue & Thu
    const compact = lower
      .replace(/th/g, "R")
      .replace(/tu/g, "T")
      .replace(/mon|monday/g, "M")
      .replace(/wed|wednesday/g, "W")
      .replace(/fri|friday/g, "F")
      .replace(/sat|saturday/g, "S")
      .replace(/sun|sunday/g, "U");
    const compactMatch = compact.match(/\b[mtwrfsu]{2,7}\b/);
    if (compactMatch) {
      for (const ch of compactMatch[0].toUpperCase()) {
        if (ch === "M") hits.add("MO");
        if (ch === "T") hits.add("TU");
        if (ch === "W") hits.add("WE");
        if (ch === "R") hits.add("TH");
        if (ch === "F") hits.add("FR");
        if (ch === "S") hits.add("SA");
        if (ch === "U") hits.add("SU");
      }
    }
  }

  const order = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  return order.filter((d) => hits.has(d));
}

function extractClassScheduleDeterministic(
  text: string
): ExtractedClassSchedule | null {
  const lines = text
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/\u2013|\u2014/g, "-")
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const timeRangeRx =
    /(\d{1,2}(?::\d{2})?\s*[AaPp]\.?[Mm]\.?)\s*(?:[-–—]|to)?\s*(\d{1,2}(?::\d{2})?\s*[AaPp]\.?[Mm]\.?)/;

  type Candidate = {
    meeting: ClassMeeting;
    score: number;
    index: number;
    label: string;
  };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const hasMeetingHeadingNear = (idx: number) => {
    const window = [lines[idx - 2], lines[idx - 1], lines[idx], lines[idx + 1], lines[idx + 2]]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /\b(meeting times?|class times?|lecture times?|course schedule)\b/.test(window);
  };
  const contextWindow = (idx: number) =>
    [lines[idx - 2], lines[idx - 1], lines[idx], lines[idx + 1], lines[idx + 2]]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  const lineHasTimeRange = (line: string) => {
    const m = line.match(timeRangeRx);
    if (!m) return null;
    const explicitSep = /[-–—]|\bto\b/i.test(m[0]);
    return { m, explicitSep };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let matchedLine = line;
    let timeInfo = lineHasTimeRange(line);
    let days = parseDaysFromText(line);

    // Canvas Pages often format this as:
    //   "Meeting Times"
    //   "Mondays, Wednesdays, and Fridays"
    //   "1:00PM-1:50PM"
    // so we need to pair a nearby day-name line with a time-only line.
    if ((!timeInfo || days.length === 0) && i + 1 < lines.length) {
      const next = lines[i + 1];
      const next2 = i + 2 < lines.length ? lines[i + 2] : "";

      const curDays = parseDaysFromText(line);
      const nextDays = parseDaysFromText(next);
      const curTime = lineHasTimeRange(line);
      const nextTime = lineHasTimeRange(next);
      const next2Time = next2 ? lineHasTimeRange(next2) : null;

      if (curDays.length > 0 && nextTime) {
        days = curDays;
        timeInfo = nextTime;
        matchedLine = `${line} ${next}`;
      } else if (curDays.length > 0 && next2Time && hasMeetingHeadingNear(i)) {
        days = curDays;
        timeInfo = next2Time;
        matchedLine = `${line} ${next} ${next2}`;
      } else if (nextDays.length > 0 && curTime && hasMeetingHeadingNear(i)) {
        days = nextDays;
        timeInfo = curTime;
        matchedLine = `${line} ${next}`;
      }
    }

    if (!timeInfo) continue;
    const { m, explicitSep } = timeInfo;
    if (m.index != null && m.index > 0 && !explicitSep) {
      // If there is no explicit separator, only accept when we also have clear day names
      // to avoid false positives from unrelated prose.
      if (days.length === 0) continue;
    }

    if (days.length === 0) {
      days = parseDaysFromText(matchedLine);
    }
    if (days.length === 0) continue;

    const startTime = to24HourTime(m[1]);
    const endTime = to24HourTime(m[2]);
    if (!startTime || !endTime) continue;

    const prev = lines[i - 1]?.toLowerCase() ?? "";
    const here = matchedLine.toLowerCase();
    const label = /\blab\b/.test(prev + " " + here)
      ? "Lab"
      : /\bdiscuss/i.test(prev + " " + here)
        ? "Discussion"
        : /\brecit/i.test(prev + " " + here)
          ? "Recitation"
          : "Lecture";

    const key = `${label}|${days.join(",")}|${startTime}|${endTime}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const meeting: ClassMeeting = {
      label,
      days,
      startTime,
      endTime,
      location: "",
    };

    const ctx = contextWindow(i);
    const durationMinutes = (() => {
      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      return (eh * 60 + em) - (sh * 60 + sm);
    })();
    let score = 0;
    if (hasMeetingHeadingNear(i)) score += 6;
    if (/\b(meeting times?|class meets?|lecture)\b/.test(ctx)) score += 3;
    if (/\b(lab|discussion|recitation)\b/.test(ctx)) score += 2;
    if (/\boffice\s+hours?\b/.test(ctx)) score -= 8;
    if (/\b(instructor|professor|prof\.)\b/.test(ctx) && /\boffice\b/.test(ctx)) score -= 5;
    if (label === "Lecture" && days.length === 1) score -= 2;
    if (label === "Lecture" && durationMinutes >= 120) score -= 3;
    if (days.length >= 3) score += 2;
    if (durationMinutes > 0 && durationMinutes <= 80) score += 1;

    candidates.push({ meeting, score, index: i, label });
  }

  if (candidates.length === 0) return null;

  // Prefer class-meeting candidates over other schedule-like text (especially
  // Office Hours pages) by keeping only the strongest context-supported rows.
  const bestScore = Math.max(...candidates.map((c) => c.score));
  let chosen = candidates.filter((c) => c.score >= Math.max(1, bestScore - 2));
  if (chosen.length === 0) {
    // Fall back to non-negative candidates before giving up entirely.
    chosen = candidates.filter((c) => c.score >= 0);
  }
  if (chosen.length === 0) return null;

  // Preserve order of appearance while deduping (dedupe already done above).
  chosen.sort((a, b) => a.index - b.index);
  const meetings = chosen.map((c) => c.meeting);
  return { meetings, semesterStart: null, semesterEnd: null, finalExamDate: null };
}

/**
 * Extracts the recurring class meeting schedule from a syllabus.
 * Looks for patterns like "MWF 10:00–10:50 AM, Chem 201" or
 * "Lectures: TR 2:30–3:45 PM" in the header/details section.
 *
 * Returns null if nothing recognisable is found.
 */
export async function extractClassSchedule(
  text: string
): Promise<ExtractedClassSchedule | null> {
  const deterministic = extractClassScheduleDeterministic(text);
  if (deterministic) return deterministic;

  // Header has meeting times; tail has final exam date
  const header = text.slice(0, 6000);
  const tail = text.slice(-3000);
  const truncated = header + (text.length > 6000 ? "\n\n--- END OF SYLLABUS ---\n\n" + tail : "");
  try {
    const { object } = await generateObject({
      ...modelConfig("low"),
      schema: classScheduleSchema,
      system: `You extract class meeting schedule from a course syllabus.

Look for statements like:
- "Lectures: MWF 10:00–10:50 AM, Chemistry 201"
- "Meeting days/times: Tuesday & Thursday 2:30–3:45 PM"
- "Lab section: Wednesdays 1:00–4:00 PM, Room 110"
- "Class: Mon/Wed/Fri 9–9:50am"

For each distinct meeting type (Lecture, Lab, Discussion, Recitation, etc.) return:
- label: the meeting type as a single word — exactly one of "Lecture", "Lab", "Discussion", or "Recitation". Do NOT include section numbers, room info, or qualifiers (e.g. write "Lecture", not "Lecture (Section 1)").
- days: array of RFC 5545 day codes. Use: MO TU WE TH FR SA SU
  Common abbreviations: M=MO, T=TU, W=WE, R or Th=TH, F=FR
- startTime: 24-hour HH:MM (e.g. "10:00", "14:30")
- endTime: 24-hour HH:MM
- location: room/building string, or "" if not mentioned

Also extract:
- semesterStart: first day of classes as YYYY-MM-DD (often called "Classes begin" or inferred from first week)
- semesterEnd: last day of classes as YYYY-MM-DD (often "Finals end" or "Semester ends")
- finalExamDate: the date of the final exam as YYYY-MM-DD. Look for "Final Exam", "Final:", "Final examination" followed by a date. This is separate from recurring meetings.

Rules:
- Only extract meeting patterns explicitly stated. Never guess.
- If no clear meeting schedule exists, return empty meetings array with null dates
- Exam/midterm dates are NOT recurring meetings, but DO extract the final exam date in the finalExamDate field
- Convert all times to 24-hour format`,
      prompt: truncated,
      abortSignal: AbortSignal.timeout(25_000),
      maxRetries: 1,
    });

    if (!object.meetings || object.meetings.length === 0) return null;
    return object as ExtractedClassSchedule;
  } catch {
    return null;
  }
}

// ─── Class Schedule from Canvas Calendar Events ───────────────────────────────

const DOW_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * Infers a ClassMeeting schedule from raw Canvas calendar events.
 * No AI — purely deterministic grouping by (time slot × day-of-week).
 *
 * Strategy:
 *  1. For each event, extract local startTime/endTime from the ISO string
 *     (avoids UTC conversion issues) and day-of-week from the date portion.
 *  2. Group by (startTime, endTime, dayOfWeek) key.
 *     A slot that appears ≥2 times is a confirmed recurring meeting.
 *  3. Merge recurring slots by (startTime, endTime) → one ClassMeeting per
 *     distinct time block, with days[] listing all days it recurs on.
 *  4. Infer label from event title ("Lab", "Discussion", "Lecture", etc.).
 */
export function extractScheduleFromCalendarEvents(
  events: { title: string; startAt: string; endAt: string; location: string | null }[],
  termStartAt?: string | null,
  termEndAt?: string | null,
): ExtractedClassSchedule | null {
  // Extract HH:MM directly from ISO string to avoid UTC offset shifting times
  function isoTime(iso: string): string {
    const m = iso.match(/T(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : "00:00";
  }
  // Get day-of-week (0=Sun) from the date portion of an ISO string
  function isoDow(iso: string): number {
    const date = iso.split("T")[0]; // "YYYY-MM-DD"
    return new Date(`${date}T12:00:00Z`).getDay();
  }

  // Count how many times each (startTime, endTime, dayOfWeek) slot appears
  const slotCount = new Map<string, { count: number; locations: string[]; title: string }>();
  for (const ev of events) {
    if (!ev.startAt || !ev.endAt) continue;
    const key = `${isoTime(ev.startAt)}~${isoTime(ev.endAt)}~${isoDow(ev.startAt)}`;
    const existing = slotCount.get(key) ?? { count: 0, locations: [], title: ev.title };
    existing.count++;
    if (ev.location) existing.locations.push(ev.location);
    slotCount.set(key, existing);
  }

  // Keep slots that appear at least once and group by (startTime, endTime).
  // A single occurrence is enough — courses that meet once per week with a
  // narrow scan window may only yield one event per slot.
  const timeGroups = new Map<string, { days: Set<number>; locations: string[]; title: string }>();
  for (const [key, { count, locations, title }] of slotCount) {
    if (count < 1) continue;
    const [startTime, endTime, dowStr] = key.split("~");
    const timeKey = `${startTime}~${endTime}`;
    const tg = timeGroups.get(timeKey) ?? { days: new Set<number>(), locations: [], title };
    tg.days.add(Number(dowStr));
    for (const loc of locations) tg.locations.push(loc);
    timeGroups.set(timeKey, tg);
  }

  if (timeGroups.size === 0) return null;

  const meetings: ClassMeeting[] = [];
  for (const [timeKey, { days, locations, title }] of timeGroups) {
    const [startTime, endTime] = timeKey.split("~");

    // Infer label from event title
    const label = /\blab\b/i.test(title) ? "Lab"
      : /\bdiscuss/i.test(title) ? "Discussion"
      : /\brecit/i.test(title) ? "Recitation"
      : /\blecture|lec\b/i.test(title) ? "Lecture"
      : "";

    // Most common location
    const locationCounts = new Map<string, number>();
    for (const l of locations) locationCounts.set(l, (locationCounts.get(l) ?? 0) + 1);
    const location = locations.length > 0
      ? [...locationCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : "";

    meetings.push({
      label,
      days: [...days].sort().map((d) => DOW_CODES[d]),
      startTime,
      endTime,
      location,
    });
  }

  // Sort: lectures / unlabeled first, then labs/discussions, then by start time
  meetings.sort((a, b) => {
    const aMain = a.label === "" || a.label === "Lecture";
    const bMain = b.label === "" || b.label === "Lecture";
    if (aMain && !bMain) return -1;
    if (!aMain && bMain) return 1;
    return a.startTime.localeCompare(b.startTime);
  });

  return {
    meetings,
    semesterStart: termStartAt ? termStartAt.split("T")[0] : null,
    semesterEnd:   termEndAt   ? termEndAt.split("T")[0]   : null,
    finalExamDate: null,
  };
}

// ─── Role 3 — Extractor ───────────────────────────────────────────────────────

/**
 * @param text   Syllabus text (pre-extracted, max ~12k chars)
 * @param hint   Optional source description e.g. "pdf-table" or "html-list".
 *               Passed as a one-line prefix so the AI knows what format to expect.
 */
export async function parseSyllabusTopics(text: string, hint?: string, moduleContext?: string, reasoningTier?: ReasoningTier): Promise<ParsedTopic[]> {
  const userContent = hint ? `[Source: ${hint}]\n\n${text}` : text;
  const topicsSchema = z.object({ weeks: z.array(parsedTopicSchema) });

  // If module context is provided, append it clearly separated in the user message
  const promptWithModules = moduleContext
    ? `${userContent}\n\n${moduleContext}`
    : userContent;

  try {
    const { object } = await generateObject({
      ...modelConfig(reasoningTier ?? "high"),
      schema: topicsSchema,
      system: `You are an expert academic content extractor. Your job is to extract the week-by-week or lecture-by-lecture learning schedule from a course syllabus.

CRITICAL RULE — DO NOT HALLUCINATE: Only extract content that is EXPLICITLY present in the provided text (syllabus and/or Canvas module data). If the text is primarily course policies, grading breakdowns, contact info, or administrative rules WITH NO topic schedule AND NO Canvas module data, return {"weeks": []}. Never invent or infer topics from the course name alone.

A real schedule looks like:
- "Week 1 (Jan 13): Introduction to Calculus, Limits"
- "Lecture 3: The French Revolution, Ch. 4"
- A table with dates/weeks in one column and topics in another

Course policies text (return empty for this):
- "Attendance Policy: ...", "Grading: 40% exams...", "Late work: -10% per day..."

SOURCE FORMAT HINTS: The input may begin with a [Source: ...] line describing the format.
- "structured schedule (one entry per line)" → each line is likely one week/lecture row; parse carefully
- "tab-separated table" → columns are tab-separated; first column is usually week/date, others are topic/readings
- "html-list" → bullet or numbered list items are individual schedule entries
- "paragraph text" → schedule may be embedded in prose; look harder for patterns
- "weekly calendar grid (7-column Sun-Sat; each row = one week; cells contain date + optional event text)" →
    The PDF extractor preserves the calendar structure: each calendar ROW becomes ONE text line,
    with TAB characters (\t) separating the 7 day cells (Sun\tMon\tTue\tWed\tThu\tFri\tSat).
    Primary strategy — use the tab structure:
    1. Find the header line containing day names separated by tabs (Sun/Mon/.../Sat or full names).
    2. Each subsequent line = one week. Split on \t to get the 7 day cells.
    3. Each cell may contain a date, an event name like "Experiment 1: Gas Constant", both, or be empty.
    4. Collect all event names from the 7 cells of that line → that is ONE week entry.
    5. Set startDate to the Monday date found in that line (YYYY-MM-DD).
    6. weekLabel = the main event name(s) (e.g. "Experiment 1: Gas Constant").
       Also add each event name to topics[] — e.g. topics: ["Experiment 1: Gas Constant"].
    7. If a cell says "No experiment", "No class", "MLK Day" etc., record it as notes for that week.
    Fallback (if tab structure is garbled or absent): scan for named events near dates using proximity.
    CRITICAL: Return an empty array ONLY if there are literally zero event names in the entire text.

IMPORTANT: Syllabi organize content in many different ways. Handle all of them:
- Week-based: "Week 1: Introduction, Week 2: ..." → use directly, one entry per week
- Lecture-based: "Lecture 1, Lecture 2, ..." → extract EACH LECTURE as its own entry (weekNumber = lecture number). Do NOT group or collapse lectures together — output every single lecture separately so downstream processing can group them accurately using the class schedule.
- Date-based: Individual class session dates → one entry per session, weekNumber = sequential
- Module/unit-based: One entry per module/unit, weekNumber = sequential
- Table format: Many syllabi use schedule tables — read every row, one entry per row
- Calendar grid: 7-column Sun-Sat physical calendar → PDF garbles the structure; use proximity-scan to find named events near dates

WHAT TO EXTRACT:
- Every topic title, subtopic, and specific concept explicitly listed in the schedule
- All readings: textbook chapters with numbers, papers, articles — include page ranges and chapter titles when listed
- In humanities and social sciences, assigned readings are often listed as author surnames (e.g., "Geertz", "Foucault", "Boas"). When standalone proper names appear alongside topic descriptions, these are reading references — put them in the readings array, not topics
- Lab or recitation topics if different from lecture content
- The start date for each week if you can determine it from dates in the schedule
- Class meeting dates even when NO topic names are listed (e.g. a seminar that only provides meeting dates) — include these sessions with notes = "No topics listed — class meeting date" so the date survives as a calendar marker. Set weekLabel to something like "Seminar Session 1", "Meeting 1", etc.

WHAT NOT TO EXTRACT:
- Graded items with due dates (homework, quizzes, exams, projects) — those are handled separately
- Grading policies, office hours, late policy, attendance rules
- Administrative dates (registration deadlines, drop dates)

CANVAS MODULE CONTEXT: The input may include a section marked "CANVAS MODULE STRUCTURE" after the syllabus text. This is real data from the course's Canvas LMS showing how the instructor organized content into modules. Both sources are valid — use ALL available information:
- When the syllabus has a clear schedule: use it as the primary structure for weeks/dates, then ENRICH each week with topic details and readings from the matching module
- When the syllabus has NO schedule (only policies/grading): use the Canvas module structure as the basis for week entries — each module becomes a week
- When both have topic info: COMBINE them. The syllabus gives structure/dates, modules add granular topic names and readings
- Module items that look like filenames (e.g. "prinz_marder_2004.pdf") are readings — extract readable titles (e.g. "Prinz & Marder (2004)")
- Ignore module items that are clearly assessments (quizzes, homework submissions, exam dropboxes) — focus on content topics and readings

Each week must have:
- weekNumber: integer starting at 1
- weekLabel: 3-7 word description of the PRIMARY TOPIC(S) covered — must name actual subjects (e.g. "Dynamic Programming and Memoization", "The French Revolution, Causes"). NEVER use "Week 1", "Regular Class", "TBD", or any placeholder. If a week has only a break note use that (e.g. "Spring Break — No Class"). For date-only sessions use descriptive labels like "Seminar Session 1".
- startDate: ISO date YYYY-MM-DD if determinable, otherwise omit
- topics: array of ALL topics/concepts for this week
- readings: array of ALL readings (chapter numbers, titles, page ranges, paper names)
- notes: optional — for special notes like "No class — Spring Break", OR "No topics listed — class meeting date" for date-only sessions
- courseName: exact course name/code from the syllabus header

If you cannot find an explicit schedule AND no Canvas module data is provided, return empty weeks array.`,
      prompt: promptWithModules,
      abortSignal: AbortSignal.timeout(120_000),
      maxRetries: 1,
    });

    return object.weeks as ParsedTopic[];
  } catch {
    return [];
  }
}

// ─── Shared Helpers (used by both route.ts and topic-pipeline.ts) ─────────────

/**
 * Scores how "schedule-dense" a text block is. Higher = more likely to contain
 * the actual week/lecture schedule rather than policy boilerplate.
 */
export function scheduleScore(text: string): number {
  if (!text || text.length < 50) return 0;
  const t = text.toLowerCase();
  const weekHits   = (t.match(/\b(week|lecture|class|session|module|experiment|lab|unit)\s*\d+/g) ?? []).length;
  const dateHits   = (t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\b\d{1,2}\/\d{1,2}\b/g) ?? []).length;
  const topicHits  = (t.match(/\b(introduction|overview|chapter|ch\.\s*\d|topic[s]?:|reading[s]?:)/g) ?? []).length;
  const policyHits = (t.match(/\b(attendance|grading|plagiarism|academic\s+integrity|office\s+hours|late\s+(work|penalty)|point[s]?\s+possible)/g) ?? []).length;
  const raw = weekHits * 4 + dateHits * 2 + topicHits * 2 - policyHits * 1;
  return raw / (text.length / 500);
}

/**
 * Picks the densest schedule-content window from a long text.
 * Evaluates 4 evenly-spaced windows and returns the one with highest scheduleScore.
 */
export function bestWindow(text: string, maxLen = 12_000): string {
  if (text.length <= maxLen) return text;
  const end = text.length - maxLen;
  const offsets = [0, Math.floor(end / 3), Math.floor(end * 2 / 3), end];
  let best = "";
  let bestScore = -Infinity;
  for (const offset of offsets) {
    const slice = text.slice(offset, offset + maxLen);
    const s = scheduleScore(slice);
    if (s > bestScore) { bestScore = s; best = slice; }
  }
  return best;
}

/**
 * Detect the structural format of a text blob so the AI knows how to parse it.
 */
export function detectSourceFormat(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return "short text";
  const dayNameHits = (text.match(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/gi
  ) ?? []).length;
  const tabLines = lines.filter((l) => l.includes("\t")).length;
  const hasTabStructure = lines.length > 0 && tabLines / lines.length > 0.15;
  if (dayNameHits >= 5 && hasTabStructure) return "weekly calendar grid (7-column Sun-Sat; each row = one week; cells contain date + optional event text)";
  if (tabLines / lines.length > 0.25) return "tab-separated table";
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  const shortLineRatio = lines.filter((l) => l.length < 120).length / lines.length;
  if (avgLen < 90 && shortLineRatio > 0.65 && lines.length > 4)
    return "structured schedule (one entry per line)";
  const bulletRatio =
    lines.filter((l) => /^[-•*·]\s/.test(l.trim())).length / lines.length;
  if (bulletRatio > 0.25) return "bulleted list";
  return "paragraph text";
}

/** Returns true if an AI-returned topic has at least one piece of content. */
export function isContentfulTopic(t: ParsedTopic): boolean {
  if (Array.isArray(t.topics) && t.topics.length > 0) return true;
  if (Array.isArray(t.readings) && t.readings.length > 0) return true;
  if (typeof t.notes === "string" && t.notes.trim().length > 0) return true;
  if (typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate)) return true;
  return false;
}
