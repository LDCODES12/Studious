/**
 * Topic Pipeline: Multi-stage AI enrichment for course content timelines.
 *
 * Philosophy: NEVER throw away data. Enhance and combine all sources.
 * Use as many AI calls as needed to produce the richest possible timeline.
 *
 * Stages:
 *   1. COLLECT    — gather inputs (done by caller)
 *   2. CLASSIFY   — AI classifies Canvas modules as content/assessment/admin
 *   3. EXTRACT    — existing parseSyllabusTopics with expanded windowing
 *   3b. CALENDAR  — algorithmic lecture-to-date mapping (no AI)
 *   3c. GROUP     — algorithmic: group per-lecture entries into calendar weeks
 *   4. ENRICH     — AI adds module data + readings to pre-grouped weeks
 *   5. VALIDATE   — algorithmic sanity checks
 */

import OpenAI from "openai";
import {
  parseSyllabusTopics,
  sanitizeSchedule,
  renumberSequentialWeeks,
  needsAudit,
  auditSchedule,
  bestWindow,
  detectSourceFormat,
  isContentfulTopic,
  type ParsedTopic,
} from "@/lib/parse-syllabus";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScoredSource {
  text: string;
  score: number;
  label: string;
}

export interface CanvasModuleInfo {
  id: string;
  canvasModuleId: string;
  weekNumber: number;
  weekLabel: string;
  topics: string[];
  readings: string[];
}

export interface ClassScheduleInfo {
  meetings: { label: string; days: string[]; startTime: string; endTime: string }[];
  semesterStart?: string | null;
  semesterEnd?: string | null;
}

export interface AssignmentDateInfo {
  title: string;
  dueDate: string | null;
}

export interface PipelineInput {
  courseId: string;
  courseName: string;
  candidates: ScoredSource[];
  modules: CanvasModuleInfo[];
  classSchedule: ClassScheduleInfo | null;
  termStartDate: string | null;
  termEndDate: string | null;
  assignments: AssignmentDateInfo[];
}

export interface PipelineResult {
  topics: ParsedTopic[];
  moduleIdsToDelete: string[];
  debug: PipelineDebug;
}

export interface PipelineDebug {
  stage2Classifications: { name: string; category: string }[];
  stage3Sources: number;
  stage3Weeks: number;
  lectureCalendarDates: number;
  stage4OutputWeeks: number;
  stage5Warnings: string[];
  fallbackUsed: boolean;
}

// ─── Stage 2: CLASSIFY ──────────────────────────────────────────────────────

type ModuleCategory = "content" | "assessment" | "administrative";

async function classifyModules(
  moduleNames: string[],
): Promise<Map<string, ModuleCategory>> {
  if (moduleNames.length === 0) return new Map();

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      temperature: 0,
      seed: 1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You classify Canvas LMS module names into exactly one of three categories:

- "content": Modules that represent academic course content students learn (e.g. "Unit 1: Chemical Equilibria", "Week 3: The French Revolution", "Module 4 - Thermodynamics", "Intro to Linear Algebra").
- "assessment": Modules that are primarily containers for graded items (e.g. "Quiz", "Midterm", "Exam 2", "Final Project", "Homework Submissions").
- "administrative": Modules that are course logistics, tools, or orientation (e.g. "Orientation", "Welcome", "Course Information", "Aktiv Chemistry", "Piazza", "Discussion Module", "Syllabus", "Getting Started", "Zoom Links").

Rules:
- A module named like "Unit 1" or "Module 1" with NO descriptive subtitle is still "content" — it is a content container even without a topic name.
- Modules that combine content with assessment (e.g. "Week 5: Exam Review") are "content".
- When in doubt between content and administrative, prefer "content".
- Classify EVERY module in the input list.

Return JSON: { "classifications": [{ "name": "<exact module name>", "category": "content" | "assessment" | "administrative" }] }`,
        },
        { role: "user", content: JSON.stringify(moduleNames) },
      ],
    }, { timeout: 15_000 });

    const content = response.choices[0]?.message?.content;
    if (!content) return new Map();
    const parsed = JSON.parse(content);
    const map = new Map<string, ModuleCategory>();
    for (const item of (parsed.classifications ?? []) as { name: string; category: string }[]) {
      if (item.category === "content" || item.category === "assessment" || item.category === "administrative") {
        map.set(item.name, item.category);
      }
    }
    return map;
  } catch (err) {
    console.warn(`[pipeline] classifyModules failed, defaulting all to content:`, err);
    return new Map();
  }
}

// ─── Stage 3: EXTRACT ───────────────────────────────────────────────────────

interface ExtractionResult {
  topics: ParsedTopic[];
  usedLabel: string;
  usedWindow: string;
}

async function extractTopicsExpanded(
  candidates: ScoredSource[],
  courseName: string,
): Promise<ExtractionResult> {
  const FULL_TEXT_THRESHOLD = 30_000;
  const LARGE_WINDOW_SIZE = 20_000;

  const allGoodResults: { result: ParsedTopic[]; label: string; fmt: string; win: string }[] = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const src = candidates[ci];

    // Expanded windowing: send full text for PDFs under 30k chars
    const win = src.text.length <= FULL_TEXT_THRESHOLD
      ? src.text
      : bestWindow(src.text, LARGE_WINDOW_SIZE);

    const fmt = detectSourceFormat(src.text);
    const hint = `${src.label}, format: ${fmt}`;
    const raw = await parseSyllabusTopics(win, hint);
    const result = sanitizeSchedule(raw).filter(isContentfulTopic);

    const richWeeks = result.filter(
      (t) => (t.topics ?? []).length > 0 || (t.readings ?? []).length > 0,
    ).length;
    const isGoodResult = result.length > 0 && (result.length < 4 || richWeeks / result.length >= 0.4);

    console.log(`[pipeline] ${courseName} extract[${ci}] ${src.label} fmt=${fmt}: ${result.length} weeks, ${richWeeks} rich → ${isGoodResult ? "ACCEPTED" : "rejected"}`);

    if (isGoodResult) {
      allGoodResults.push({ result, label: src.label, fmt, win });
    }
  }

  if (allGoodResults.length === 0) {
    return { topics: [], usedLabel: "none", usedWindow: "" };
  }

  // Merge: start with highest-coverage source, fill gaps from others
  allGoodResults.sort((a, b) => b.result.length - a.result.length);
  const merged = new Map<number, ParsedTopic>();
  const sourceLabels: string[] = [];
  let usedWindow = allGoodResults[0].win;

  for (const { result, label } of allGoodResults) {
    let contributed = false;
    for (const week of result) {
      const existing = merged.get(week.weekNumber);
      if (!existing) {
        merged.set(week.weekNumber, week);
        contributed = true;
      } else {
        const existingRich = (existing.topics?.length ?? 0) + (existing.readings?.length ?? 0);
        const newRich = (week.topics?.length ?? 0) + (week.readings?.length ?? 0);
        if (newRich > existingRich) {
          merged.set(week.weekNumber, { ...week, startDate: existing.startDate ?? week.startDate });
          contributed = true;
        } else if (!existing.startDate && week.startDate) {
          existing.startDate = week.startDate;
          contributed = true;
        }
      }
    }
    if (contributed) sourceLabels.push(label);
  }

  let topics = [...merged.values()].sort((a, b) => a.weekNumber - b.weekNumber);
  const usedLabel = sourceLabels.length > 1
    ? `merged(${sourceLabels.join("+")})`
    : sourceLabels[0] ?? "none";

  // Audit pass (same as before — fires when result looks partial/messy)
  if (needsAudit(topics)) {
    const audited = await auditSchedule(topics, usedWindow);
    if (audited.length > 0) {
      topics = audited;
    }
  }

  topics = renumberSequentialWeeks(topics);

  return { topics, usedLabel, usedWindow };
}

// ─── Stage 3b: LECTURE CALENDAR (algorithmic) ────────────────────────────────

interface LectureDate {
  lectureNumber: number;
  date: string; // YYYY-MM-DD
  dayOfWeek: string; // "MO", "TU", etc.
}

interface WeekDateRange {
  weekNumber: number;
  startDate: string; // YYYY-MM-DD (Monday of week)
  lectures: LectureDate[];
}

const DAY_CODES: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

function buildLectureCalendar(
  classSchedule: ClassScheduleInfo | null,
  termStartDate: string | null,
  termEndDate: string | null,
): WeekDateRange[] {
  if (!classSchedule || !termStartDate) return [];

  // Find lecture meetings (not labs, discussions, etc.)
  const lectureMeetings = classSchedule.meetings.filter(
    (m) => m.label.toLowerCase() === "lecture",
  );
  if (lectureMeetings.length === 0) return [];

  // Get unique lecture days (e.g., [1, 3, 5] for MWF)
  const lectureDayCodes = new Set<number>();
  for (const m of lectureMeetings) {
    for (const d of m.days) {
      const code = DAY_CODES[d.toUpperCase()];
      if (code !== undefined) lectureDayCodes.add(code);
    }
  }
  const sortedDays = [...lectureDayCodes].sort((a, b) => a - b);
  if (sortedDays.length === 0) return [];

  const DAY_NAMES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const start = new Date(termStartDate + "T12:00:00");
  const end = termEndDate ? new Date(termEndDate + "T12:00:00") : new Date(start);
  if (!termEndDate) {
    end.setDate(end.getDate() + 16 * 7); // default 16 weeks
  }

  // Generate all lecture dates
  const allLectures: LectureDate[] = [];
  let lectureNum = 1;
  const cursor = new Date(start);

  while (cursor <= end) {
    const dow = cursor.getDay();
    if (lectureDayCodes.has(dow)) {
      allLectures.push({
        lectureNumber: lectureNum++,
        date: cursor.toISOString().slice(0, 10),
        dayOfWeek: DAY_NAMES[dow],
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (allLectures.length === 0) return [];

  // Group lectures into calendar weeks (Mon-Sun)
  const weekMap = new Map<string, LectureDate[]>();
  for (const lec of allLectures) {
    const lecDate = new Date(lec.date + "T12:00:00");
    const dayOfWeek = lecDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(lecDate);
    monday.setDate(monday.getDate() + mondayOffset);
    const mondayStr = monday.toISOString().slice(0, 10);

    if (!weekMap.has(mondayStr)) weekMap.set(mondayStr, []);
    weekMap.get(mondayStr)!.push(lec);
  }

  const weeks: WeekDateRange[] = [];
  const sortedMondays = [...weekMap.keys()].sort();
  for (let i = 0; i < sortedMondays.length; i++) {
    weeks.push({
      weekNumber: i + 1,
      startDate: sortedMondays[i],
      lectures: weekMap.get(sortedMondays[i])!,
    });
  }

  return weeks;
}

// ─── Stage 3c: GROUP lectures into weeks (algorithmic) ──────────────────────

/**
 * If AI extracted individual lectures (e.g. 41 entries for 41 lectures),
 * group them into calendar weeks using the lecture calendar.
 * This is pure math — no AI needed.
 */
function groupLecturesIntoWeeks(
  aiTopics: ParsedTopic[],
  lectureCalendar: WeekDateRange[],
  courseName: string,
): ParsedTopic[] | null {
  if (lectureCalendar.length === 0) return null;

  // Heuristic: if we have significantly more AI entries than calendar weeks,
  // the entries are likely per-lecture, not per-week
  const avgLecturesPerWeek = lectureCalendar.reduce((s, w) => s + w.lectures.length, 0) / lectureCalendar.length;
  if (aiTopics.length <= lectureCalendar.length * 1.3) {
    // Already week-level or close — no grouping needed
    return null;
  }

  console.log(`[pipeline] ${courseName}: Stage 3c grouping ${aiTopics.length} lecture entries into ${lectureCalendar.length} calendar weeks`);

  // Build a map: lecture number → calendar week
  const lectureToWeek = new Map<number, WeekDateRange>();
  for (const week of lectureCalendar) {
    for (const lec of week.lectures) {
      lectureToWeek.set(lec.lectureNumber, week);
    }
  }

  // Group AI topics by calendar week
  const weekGroups = new Map<number, { week: WeekDateRange; topics: ParsedTopic[] }>();

  for (const topic of aiTopics) {
    // Match by weekNumber (which is lecture number for per-lecture extraction)
    const calWeek = lectureToWeek.get(topic.weekNumber);
    if (calWeek) {
      if (!weekGroups.has(calWeek.weekNumber)) {
        weekGroups.set(calWeek.weekNumber, { week: calWeek, topics: [] });
      }
      weekGroups.get(calWeek.weekNumber)!.topics.push(topic);
    }
  }

  // Handle unmatched topics (lecture numbers beyond calendar range)
  const matchedCount = [...weekGroups.values()].reduce((s, g) => s + g.topics.length, 0);
  const unmatchedTopics = aiTopics.filter((t) => !lectureToWeek.has(t.weekNumber));

  if (matchedCount === 0) return null; // no matches at all

  // Build grouped weeks
  const grouped: ParsedTopic[] = [];
  const sortedWeekNums = [...weekGroups.keys()].sort((a, b) => a - b);

  for (const wn of sortedWeekNums) {
    const { week, topics } = weekGroups.get(wn)!;

    // Combine all lecture topics into one week entry
    const allTopics: string[] = [];
    const allReadings: string[] = [];
    const allNotes: string[] = [];

    for (const t of topics) {
      // Prefix with lecture label for detail preservation
      const lecNum = t.weekNumber;
      const prefix = `Lec ${lecNum}`;
      if (t.topics && t.topics.length > 0) {
        allTopics.push(`${prefix}: ${t.topics.join(", ")}`);
      } else if (t.weekLabel) {
        allTopics.push(`${prefix}: ${t.weekLabel}`);
      }
      if (t.readings) allReadings.push(...t.readings);
      if (t.notes) allNotes.push(t.notes);
    }

    // Generate a week label from the primary theme
    // Use first lecture's label — per-lecture detail is already in topics[]
    const firstTopic = topics[0];
    const weekLabel = firstTopic.weekLabel;

    grouped.push({
      weekNumber: wn,
      weekLabel,
      startDate: week.startDate,
      topics: allTopics,
      readings: [...new Set(allReadings)], // dedupe
      notes: allNotes.length > 0 ? allNotes.join("; ") : undefined,
      courseName: firstTopic.courseName,
    });
  }

  // Append any unmatched topics to the last week
  if (unmatchedTopics.length > 0 && grouped.length > 0) {
    const lastWeek = grouped[grouped.length - 1];
    for (const t of unmatchedTopics) {
      if (t.topics && t.topics.length > 0) {
        lastWeek.topics.push(`Lec ${t.weekNumber}: ${t.topics.join(", ")}`);
      }
      if (t.readings) lastWeek.readings.push(...t.readings);
    }
    console.log(`[pipeline] ${courseName}: Stage 3c appended ${unmatchedTopics.length} unmatched lectures to last week`);
  }

  console.log(`[pipeline] ${courseName}: Stage 3c produced ${grouped.length} grouped weeks from ${matchedCount} matched lectures`);
  return grouped;
}

// ─── Stage 4: ENRICH ─────────────────────────────────────────────────────────

interface EnrichInput {
  contentModules: { weekLabel: string; topics: string[]; readings: string[] }[];
  groupedTopics: ParsedTopic[];
  courseName: string;
}

async function enrichTimeline(input: EnrichInput): Promise<ParsedTopic[]> {
  if (input.contentModules.length === 0) {
    // No modules to enrich with — grouped topics are already good
    return input.groupedTopics;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      temperature: 0,
      seed: 1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You enrich a course timeline with additional data from Canvas modules.

You will receive:
1. GROUPED TIMELINE: Pre-grouped weekly topics with dates and per-lecture detail already assigned. This is the PRIMARY source — do not rearrange, regroup, or remove any entries.
2. CANVAS MODULES: Module names and their content items (slides, handouts, worksheets, etc.)

YOUR JOB — ENRICH, never delete:
- Match each Canvas module to the corresponding week(s) in the timeline by topic/unit overlap
- ADD useful readings from modules (slides, handouts, worksheets, problem sets) to the week's readings array
- If a module mentions content not in any week's topics, ADD it as a new topic entry
- KEEP all existing topics exactly as they are — do not rename, summarize, or reorder them
- KEEP all existing dates, weekNumbers, and weekLabels unchanged

OUTPUT: { "weeks": [...] }
Same structure as input: { weekNumber, weekLabel, startDate, topics, readings, notes, courseName }

If you cannot match a module to any week, skip it — do not force it.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            groupedTimeline: input.groupedTopics.map((t) => ({
              weekNumber: t.weekNumber,
              weekLabel: t.weekLabel,
              startDate: t.startDate,
              topics: t.topics,
              readings: t.readings,
              notes: t.notes,
              courseName: t.courseName,
            })),
            canvasModules: input.contentModules,
          }),
        },
      ],
    }, { timeout: 45_000 });

    const content = response.choices[0]?.message?.content;
    if (!content) return input.groupedTopics;
    const parsed = JSON.parse(content);
    const enriched = Array.isArray(parsed.weeks) ? parsed.weeks as ParsedTopic[] : [];

    // Safety: enriched must have roughly same number of weeks
    if (enriched.length >= input.groupedTopics.length * 0.8 && enriched.length <= input.groupedTopics.length * 1.2) {
      return enriched;
    }
    console.warn(`[pipeline] enrichTimeline produced ${enriched.length} weeks vs ${input.groupedTopics.length} input — keeping original`);
    return input.groupedTopics;
  } catch (err) {
    console.warn(`[pipeline] enrichTimeline failed:`, err);
    return input.groupedTopics;
  }
}

// ─── Stage 5: VALIDATE ──────────────────────────────────────────────────────

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

  // 1. Ensure weekNumbers are sequential starting at 1
  topics = renumberSequentialWeeks(topics);

  // 2. Check dates are chronological
  const dated = topics.filter(
    (t) => t.startDate && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate!),
  );
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].startDate! < dated[i - 1].startDate!) {
      warnings.push(
        `Non-chronological: week ${dated[i].weekNumber} (${dated[i].startDate}) before week ${dated[i - 1].weekNumber} (${dated[i - 1].startDate})`,
      );
      dated[i].startDate = undefined;
    }
  }

  // 3. Check for large gaps (> 21 days)
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

  // 4. Check dates within term bounds
  if (termStart && termEnd) {
    for (const t of dated) {
      if (t.startDate! < termStart || t.startDate! > termEnd) {
        warnings.push(`Date ${t.startDate} for week ${t.weekNumber} outside term ${termStart}..${termEnd}`);
      }
    }
  }

  // 5. Check for placeholder labels
  for (const t of topics) {
    if (!t.weekLabel || t.weekLabel.trim() === "" || /^week\s+\d+$/i.test(t.weekLabel)) {
      warnings.push(`Weak weekLabel "${t.weekLabel}" on week ${t.weekNumber}`);
    }
  }

  // 6. Check week count is reasonable (flag if >18 or <4)
  if (topics.length > 18) {
    warnings.push(`Too many weeks (${topics.length}) — semester is typically 14-16 weeks`);
  }

  return { topics, warnings };
}

// ─── Module-Only Fallback: organize modules into a timeline ─────────────────

/**
 * When AI extraction fails but we have content modules, parse unit/lecture
 * structure from module labels and build a proper timeline.
 *
 * Handles patterns like:
 *   "Unit 1 (Lectures 1-5) - Quiz on 1/29/26"  → unit 1, lectures 1-5
 *   "Unit 7 (Lectures 20-23) - No Quiz"         → unit 7, lectures 20-23
 *   "Module 3 - Thermodynamics"                  → unit 3
 *   "Week 5: Acid-Base Equilibria"               → unit 5
 */
function organizeModulesAsTimeline(
  contentModules: CanvasModuleInfo[],
  lectureCalendar: WeekDateRange[],
  courseName: string,
): ParsedTopic[] {
  if (contentModules.length === 0) return [];

  // Parse unit number and lecture range from each module label
  const parsed = contentModules.map((m) => {
    const label = m.weekLabel;

    // Extract unit/module/week number
    const unitMatch = label.match(/\b(?:unit|module|week)\s*(\d+)/i);
    const unitNum = unitMatch ? parseInt(unitMatch[1], 10) : null;

    // Extract lecture range: "Lectures 1-5" or "Lectures 20-23"
    const lecMatch = label.match(/lectures?\s*(\d+)\s*[-–]\s*(\d+)/i);
    const lecStart = lecMatch ? parseInt(lecMatch[1], 10) : null;
    const lecEnd = lecMatch ? parseInt(lecMatch[2], 10) : null;

    // Clean label: remove quiz/exam dates and "No Quiz" suffixes
    let cleanLabel = label
      .replace(/\s*-\s*(quiz\s+on\s+\S+|no\s+quiz|exam\s+on\s+\S+)/i, "")
      .replace(/\s*\(lectures?\s*\d+\s*[-–]\s*\d+\)/i, "")
      .trim();

    // If label is just "Unit N", keep it simple
    if (/^unit\s+\d+$/i.test(cleanLabel)) {
      cleanLabel = `Unit ${unitNum}`;
    }

    return { module: m, unitNum, lecStart, lecEnd, cleanLabel };
  });

  // Sort by unit number (ascending), then by first lecture number
  parsed.sort((a, b) => {
    if (a.unitNum !== null && b.unitNum !== null) return a.unitNum - b.unitNum;
    if (a.unitNum !== null) return -1;
    if (b.unitNum !== null) return 1;
    if (a.lecStart !== null && b.lecStart !== null) return a.lecStart - b.lecStart;
    return 0;
  });

  // Filter useful readings (slides, worksheets, problem sets, handouts)
  // Remove quiz blanks/keys, exam blanks/keys, and generic items
  const USEFUL_READING_RX = /slide|worksheet|handout|problem\s+set|packet|review|derivation|video|reading/i;
  const SKIP_READING_RX = /\b(quiz|exam)\s+(blank|key)\b|regrade\s+request|setup\s+instructions|gradescope/i;

  // Build lecture-to-calendar-week map for date assignment
  const lectureToWeek = new Map<number, WeekDateRange>();
  for (const week of lectureCalendar) {
    for (const lec of week.lectures) {
      lectureToWeek.set(lec.lectureNumber, week);
    }
  }

  // Build timeline entries
  const timeline: ParsedTopic[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];

    // Filter topics: remove generic Canvas item-type names
    const SKIP_TOPIC_RX = /^(assignments?|homework|quiz\s+information|quiz\s+and\s+exam|suggested\s+readings?|lecture\s+powerpoint|section\s+\d|quiz\s+policies|exam\s+room)/i;
    const usefulTopics = p.module.topics.filter((t) => !SKIP_TOPIC_RX.test(t));

    // Filter readings
    const usefulReadings = p.module.readings.filter(
      (r) => USEFUL_READING_RX.test(r) && !SKIP_READING_RX.test(r),
    );

    // Find date from lecture calendar
    let startDate: string | undefined;
    if (p.lecStart !== null) {
      const calWeek = lectureToWeek.get(p.lecStart);
      if (calWeek) startDate = calWeek.startDate;
    }

    timeline.push({
      weekNumber: i + 1,
      weekLabel: p.cleanLabel,
      startDate,
      topics: usefulTopics.length > 0
        ? usefulTopics
        : p.lecStart !== null && p.lecEnd !== null
          ? [`Lectures ${p.lecStart}–${p.lecEnd}`]
          : [],
      readings: usefulReadings,
      courseName,
    });
  }

  console.log(`[pipeline] ${courseName}: module fallback organized ${contentModules.length} modules → ${timeline.length} timeline entries`);
  return timeline;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function runTopicPipeline(input: PipelineInput): Promise<PipelineResult> {
  const debug: PipelineDebug = {
    stage2Classifications: [],
    stage3Sources: input.candidates.length,
    stage3Weeks: 0,
    lectureCalendarDates: 0,
    stage4OutputWeeks: 0,
    stage5Warnings: [],
    fallbackUsed: false,
  };

  // ── STAGE 2: CLASSIFY modules ──
  const moduleClassifications = input.modules.length > 0
    ? await classifyModules(input.modules.map((m) => m.weekLabel))
    : new Map<string, ModuleCategory>();

  debug.stage2Classifications = input.modules.map((m) => ({
    name: m.weekLabel,
    category: moduleClassifications.get(m.weekLabel) ?? "content",
  }));

  const contentModules = input.modules.filter(
    (m) => (moduleClassifications.get(m.weekLabel) ?? "content") === "content",
  );
  const nonContentModuleIds = input.modules
    .filter((m) => {
      const cat = moduleClassifications.get(m.weekLabel);
      return cat === "assessment" || cat === "administrative";
    })
    .map((m) => m.id);

  console.log(
    `[pipeline] ${input.courseName}: Stage 2 classified ${input.modules.length} modules → ` +
    `${contentModules.length} content, ${nonContentModuleIds.length} non-content`,
  );

  // ── STAGE 3: EXTRACT from syllabus ──
  const extraction = await extractTopicsExpanded(input.candidates, input.courseName);
  let aiTopics = extraction.topics;
  debug.stage3Weeks = aiTopics.length;

  console.log(`[pipeline] ${input.courseName}: Stage 3 extracted ${aiTopics.length} entries from ${input.candidates.length} source(s)`);

  // ── STAGE 3b: BUILD LECTURE CALENDAR ──
  const lectureCalendar = buildLectureCalendar(
    input.classSchedule,
    input.classSchedule?.semesterStart ?? input.termStartDate ?? null,
    input.classSchedule?.semesterEnd ?? input.termEndDate ?? null,
  );
  debug.lectureCalendarDates = lectureCalendar.reduce((sum, w) => sum + w.lectures.length, 0);

  if (lectureCalendar.length > 0) {
    console.log(
      `[pipeline] ${input.courseName}: Stage 3b built lecture calendar — ` +
      `${debug.lectureCalendarDates} lectures across ${lectureCalendar.length} weeks`,
    );
  }

  // ── STAGE 3c: GROUP lectures into weeks (algorithmic) ──
  const grouped = groupLecturesIntoWeeks(aiTopics, lectureCalendar, input.courseName);
  if (grouped) {
    aiTopics = grouped;
  }

  // ── STAGE 4: ENRICH with module data ──
  let finalTopics: ParsedTopic[];
  let moduleIdsToDelete: string[];

  if (aiTopics.length === 0 && contentModules.length === 0) {
    finalTopics = [];
    moduleIdsToDelete = [];
    debug.fallbackUsed = true;
    console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no data from either source`);

  } else if (aiTopics.length === 0) {
    // No AI topics but we have content modules — organize them into a timeline
    const organizedModules = organizeModulesAsTimeline(contentModules, lectureCalendar, input.courseName);
    if (organizedModules.length > 0) {
      finalTopics = organizedModules;
      moduleIdsToDelete = input.modules.map((m) => m.id); // delete all old modules, we're replacing them
      debug.stage4OutputWeeks = organizedModules.length;
      debug.fallbackUsed = true;
      console.log(`[pipeline] ${input.courseName}: Stage 4 module-only fallback → ${organizedModules.length} organized entries`);
    } else {
      finalTopics = [];
      moduleIdsToDelete = nonContentModuleIds;
      debug.fallbackUsed = true;
      console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no AI topics, keeping ${contentModules.length} content modules`);
    }

  } else {
    // Enrich grouped topics with module data
    console.log(
      `[pipeline] ${input.courseName}: Stage 4 enriching ${aiTopics.length} weeks` +
      (contentModules.length > 0 ? ` with ${contentModules.length} content modules` : ""),
    );

    const enriched = await enrichTimeline({
      contentModules: contentModules.map((m) => ({
        weekLabel: m.weekLabel,
        topics: m.topics,
        readings: m.readings,
      })),
      groupedTopics: aiTopics,
      courseName: input.courseName,
    });

    finalTopics = enriched;
    moduleIdsToDelete = input.modules.map((m) => m.id);
    debug.stage4OutputWeeks = enriched.length;
    console.log(`[pipeline] ${input.courseName}: Stage 4 produced ${enriched.length} enriched weeks`);
  }

  // ── STAGE 5: VALIDATE ──
  const validated = validateTimeline(finalTopics, input.termStartDate, input.termEndDate);
  debug.stage5Warnings = validated.warnings;

  if (validated.warnings.length > 0) {
    console.warn(`[pipeline] ${input.courseName}: validation warnings:`, validated.warnings);
  }

  return {
    topics: validated.topics,
    moduleIdsToDelete,
    debug,
  };
}
