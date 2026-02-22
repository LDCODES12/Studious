import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface ParsedEvent {
  title: string;
  type: "assignment" | "exam" | "quiz" | "project" | "reading" | "lab" | "other";
  dueDate: string;
  courseName: string;
  description?: string;
}

export async function parseSyllabusText(text: string): Promise<ParsedEvent[]> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a syllabus parser. Extract every graded assessment (quizzes, exams, assignments, projects, labs) that has an explicitly written date in the syllabus. Include all of them — do not miss any.

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
- Use the year from the syllabus header (e.g. Spring 2026 → year is 2026).

Return a JSON object with an "events" array. Each event must have:
- title: name of the assessment (e.g. "Quiz 1", "Midterm Exam 2", "Final Exam")
- type: one of "assignment", "exam", "quiz", "project", "lab", "other"
- dueDate: ISO date string (YYYY-MM-DD)
- courseName: course name/number from the syllabus header
- description: optional brief note (e.g. "6:30–8:00 pm, in person")`,
      },
      {
        role: "user",
        content: text,
      },
    ],
  }, { timeout: 45_000 });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  const parsed = JSON.parse(content);
  return parsed.events ?? [];
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
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a grading policy parser. Find every statement in this syllabus that says a certain number of lowest or highest scores will be dropped for a category of assignments.

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
- Do not include regrade policies or late work policies

Return JSON: { "rules": [{ "groupName": string, "dropLowest": number, "dropHighest": number }] }`,
        },
        { role: "user", content: truncated },
      ],
    }, { timeout: 20_000 });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content);
    return (parsed.rules ?? []).filter(
      (r: ExtractedDropRule) => r.dropLowest > 0 || r.dropHighest > 0
    );
  } catch {
    return [];
  }
}

export interface ParsedTopic {
  weekNumber: number;
  weekLabel: string;
  startDate?: string;
  topics: string[];
  readings: string[];
  notes?: string;
  courseName: string;
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
      topics: w.topics.filter((t) => !POLICY_TOPIC_RX.test(t)),
      readings: w.readings.filter((r) => !POLICY_TOPIC_RX.test(r)),
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
    // 3. Sort ascending by weekNumber
    .sort((a, b) => a.weekNumber - b.weekNumber)
    // 4. Renumber sequentially to close gaps (e.g. 1,2,4,5 → 1,2,3,4)
    .map((w, i) => ({ ...w, weekNumber: i + 1 }));
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
    (w) => w.topics.length === 0 && w.readings.length === 0 && !w.notes
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
 * Sends the extracted weeks + source snippet to GPT-4o-mini for a quality
 * review. The model corrects week labels, removes hallucinated or policy
 * topics, fixes date ordering, and drops empty weeks.
 *
 * Falls back to the input weeks if the AI call fails or returns nothing useful.
 */
export async function auditSchedule(
  weeks: ParsedTopic[],
  sourceText: string
): Promise<ParsedTopic[]> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a schedule quality auditor. You will receive:
1. EXTRACTED SCHEDULE — a JSON array of weekly schedule entries (possibly with errors)
2. ORIGINAL SOURCE — the first 6000 characters of the raw syllabus text

Your job is to fix the extracted schedule:
- Remove topics or readings that are course policy text (grading rules, attendance rules, late penalties, office hours). Academic content only.
- Fix vague weekLabels like "Regular Class" or "TBD" — use actual topic names from the source if you can find them.
- Remove weeks that have no real topics or readings after cleanup.
- Ensure weekNumbers are sequential with no gaps — renumber if needed.
- Validate startDates: they must increase chronologically. Remove or fix dates that are out of order.
- Do NOT invent topics that aren't in the source. Only fix, never fabricate.

Return JSON: { "weeks": [...] } using the exact same field structure. Return only the corrected array — no explanations, no extra fields.`,
      },
      {
        role: "user",
        content: `EXTRACTED SCHEDULE:\n${JSON.stringify(weeks, null, 2)}\n\nORIGINAL SOURCE (first 6000 chars):\n${sourceText.slice(0, 6000)}`,
      },
    ],
  }, { timeout: 45_000 });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return weeks;

  try {
    const parsed = JSON.parse(raw);
    const audited: ParsedTopic[] = parsed.weeks ?? [];
    // Accept only if the audit produced at least half as many weeks (avoid catastrophic drops)
    if (Array.isArray(audited) && audited.length >= Math.max(1, weeks.length / 2)) {
      return audited;
    }
  } catch {
    // JSON parse failed — return unmodified
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
  // Focus on the first ~3000 chars — schedule info lives in the header
  const truncated = text.slice(0, 3000);
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You extract class meeting schedule from a course syllabus.

Look for statements like:
- "Lectures: MWF 10:00–10:50 AM, Chemistry 201"
- "Meeting days/times: Tuesday & Thursday 2:30–3:45 PM"
- "Lab section: Wednesdays 1:00–4:00 PM, Room 110"
- "Class: Mon/Wed/Fri 9–9:50am"

For each distinct meeting type (Lecture, Lab, Discussion, Recitation, etc.) return:
- label: the meeting type name (e.g. "Lecture", "Lab", "Discussion")
- days: array of RFC 5545 day codes. Use: MO TU WE TH FR SA SU
  Common abbreviations: M=MO, T=TU, W=WE, R or Th=TH, F=FR
- startTime: 24-hour HH:MM (e.g. "10:00", "14:30")
- endTime: 24-hour HH:MM
- location: room/building string, or "" if not mentioned

Also extract:
- semesterStart: first day of classes as YYYY-MM-DD (often called "Classes begin" or inferred from first week)
- semesterEnd: last day of classes as YYYY-MM-DD (often "Finals end" or "Semester ends")

Rules:
- Only extract meeting patterns explicitly stated. Never guess.
- If no clear meeting schedule exists, return { "meetings": [], "semesterStart": null, "semesterEnd": null }
- Ignore exam/midterm dates — those are single events, not recurring meetings
- Convert all times to 24-hour format

Return JSON: { "meetings": [...], "semesterStart": "YYYY-MM-DD" | null, "semesterEnd": "YYYY-MM-DD" | null }`,
        },
        { role: "user", content: truncated },
      ],
    }, { timeout: 20_000 });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as ExtractedClassSchedule;
    if (!parsed.meetings || parsed.meetings.length === 0) return null;
    return parsed;
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

  // Keep only recurring slots (count ≥ 2) and group by (startTime, endTime)
  const timeGroups = new Map<string, { days: Set<number>; locations: string[]; title: string }>();
  for (const [key, { count, locations, title }] of slotCount) {
    if (count < 2) continue;
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
  };
}

// ─── Role 3 — Extractor ───────────────────────────────────────────────────────

/**
 * @param text   Syllabus text (pre-extracted, max ~12k chars)
 * @param hint   Optional source description e.g. "pdf-table" or "html-list".
 *               Passed as a one-line prefix so the AI knows what format to expect.
 */
export async function parseSyllabusTopics(text: string, hint?: string): Promise<ParsedTopic[]> {
  const userContent = hint ? `[Source: ${hint}]\n\n${text}` : text;

  // Calendar grid format requires stronger spatial reasoning to follow the tab structure —
  // use gpt-4o for those cases. Everything else is fine with gpt-4o-mini.
  const isCalendarGrid = hint?.includes("weekly calendar grid") ?? false;
  const model = isCalendarGrid ? "gpt-4o" : "gpt-4o-mini";

  const response = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an expert academic content extractor. Your job is to extract the week-by-week or lecture-by-lecture learning schedule from a course syllabus.

CRITICAL RULE — DO NOT HALLUCINATE: Only extract content that is EXPLICITLY written in the text as a schedule. If the text is primarily course policies, grading breakdowns, contact info, or administrative rules WITHOUT a clear topic schedule, return {"weeks": []}. Never invent or infer topics from the course name.

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
- Week-based: "Week 1: Introduction, Week 2: ..." → use directly
- Lecture-based: "Lecture 1, Lecture 2, ..." → group 2-3 lectures per week
- Date-based: Individual class session dates → calculate week numbers from the dates
- Module/unit-based: Group modules into sequential weeks
- Table format: Many syllabi use schedule tables — read every row
- Calendar grid: 7-column Sun-Sat physical calendar → PDF garbles the structure; use proximity-scan to find named events near dates

WHAT TO EXTRACT:
- Every topic title, subtopic, and specific concept explicitly listed in the schedule
- All readings: textbook chapters with numbers, papers, articles — include page ranges and chapter titles when listed
- Lab or recitation topics if different from lecture content
- The start date for each week if you can determine it from dates in the schedule
- Class meeting dates even when NO topic names are listed (e.g. a seminar that only provides meeting dates) — include these sessions with notes = "No topics listed — class meeting date" so the date survives as a calendar marker. Set weekLabel to something like "Seminar Session 1", "Meeting 1", etc.

WHAT NOT TO EXTRACT:
- Graded items with due dates (homework, quizzes, exams, projects) — those are handled separately
- Grading policies, office hours, late policy, attendance rules
- Administrative dates (registration deadlines, drop dates)

OUTPUT: Return JSON with a "weeks" array. If you find a real schedule, include EVERY week — do not truncate. Each week must have:
- weekNumber: integer starting at 1
- weekLabel: 3-7 word description of the PRIMARY TOPIC(S) covered — must name actual subjects (e.g. "Dynamic Programming and Memoization", "The French Revolution, Causes"). NEVER use "Week 1", "Regular Class", "TBD", or any placeholder. If a week has only a break note use that (e.g. "Spring Break — No Class"). For date-only sessions use descriptive labels like "Seminar Session 1".
- startDate: ISO date YYYY-MM-DD if determinable, otherwise omit
- topics: array of ALL topics/concepts for this week
- readings: array of ALL readings (chapter numbers, titles, page ranges, paper names)
- notes: optional — for special notes like "No class — Spring Break", OR "No topics listed — class meeting date" for date-only sessions
- courseName: exact course name/code from the syllabus header

If you cannot find an explicit schedule, return {"weeks": []}.`,
      },
      { role: "user", content: userContent },
    ],
  }, { timeout: 45_000 });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.weeks) ? parsed.weeks : [];
  } catch {
    return [];
  }
}
