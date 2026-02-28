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
 *   4. ENRICH     — AI combines ALL sources into one detailed timeline
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

// ─── Stage 4: ENRICH (replaces FUSE) ─────────────────────────────────────────

interface EnrichInput {
  contentModules: { weekLabel: string; topics: string[]; readings: string[] }[];
  aiTopics: ParsedTopic[];
  lectureCalendar: WeekDateRange[];
  classSchedule: ClassScheduleInfo | null;
  termStartDate: string | null;
  termEndDate: string | null;
  assignments: { title: string; dueDate: string | null }[];
  courseName: string;
}

async function enrichTimeline(input: EnrichInput): Promise<ParsedTopic[]> {
  try {
    const lecturesPerWeek = input.lectureCalendar.length > 0
      ? Math.round(input.lectureCalendar.reduce((sum, w) => sum + w.lectures.length, 0) / input.lectureCalendar.length)
      : 0;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-2024-08-06",
      temperature: 0,
      seed: 1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You build a detailed week-by-week course timeline by COMBINING all data sources.
Your job is to PRESERVE MAXIMUM DETAIL from every source — never summarize or discard information.

INPUTS:
1. SYLLABUS TOPICS: AI-extracted topics (may be organized by week, lecture, or unit)
2. CANVAS MODULES: Module names and their content items from the course LMS (content modules only — admin/assessment already filtered)
3. LECTURE CALENDAR: Pre-computed mapping of lecture numbers to exact calendar dates, grouped by week. Each week shows which lectures fall on which dates.
4. CLASS SCHEDULE: Meeting pattern (e.g. MWF) and term dates
5. ASSIGNMENTS: Titles with due dates for anchoring

CRITICAL RULES:
- COMBINE all sources. If the syllabus says "Lecture 1: Law of Mass Action" and a Canvas module says "Unit 1: Chemical Equilibria" with items ["Lecture 1 Notes", "Practice Problems"], include BOTH the detailed topic AND the module items.
- When multiple sources describe the same content at different detail levels, keep the MORE DETAILED version. If the syllabus has per-lecture topics, keep them per-lecture — do NOT collapse "Lecture 14: 1st Law", "Lecture 15: Adiabatic processes", "Lecture 16: Work by gas expansion" into a single vague "Thermodynamics" entry.
- Each week's "topics" array should list EVERY lecture's content for that week as separate items, e.g. ["Lec 14: 1st Law of Thermodynamics, systems, energy transfer", "Lec 15: Adiabatic/isothermal processes, free expansion", "Lec 16: Work done by gas expansion, PV diagrams"]
- ${lecturesPerWeek > 0 ? `This course has ~${lecturesPerWeek} lectures per week. Each week should contain ~${lecturesPerWeek} lecture topics.` : "Group content into calendar weeks based on available date information."}
- If Canvas module items mention content not in the syllabus (additional resources, supplementary material), ADD them to readings.

DATE ASSIGNMENT:
- The LECTURE CALENDAR provides exact dates. Use them directly.
- If the syllabus has lecture numbers (e.g. "Lecture 1", "Lecture 14"), match them to the lecture calendar dates.
- If no lecture numbers, use assignment due dates and term dates to anchor content.
- startDate for each week = the Monday of that calendar week.

WEEK LABELS:
- Use the primary topic theme for that week, 3-7 words (e.g. "Chemical Equilibrium Fundamentals", "Acid-Base Equilibria and Buffers")
- Never use generic labels like "Week 1" or "Introduction"

OUTPUT: { "weeks": [...] }
Each week: { weekNumber, weekLabel, startDate (YYYY-MM-DD), topics (array — one entry per lecture or topic), readings (array), notes (optional), courseName }

IMPORTANT: Produce one entry per CALENDAR WEEK of the semester. The number of weeks should match the actual semester length (~14-16 weeks), NOT the number of lectures or units.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            syllabusTopics: input.aiTopics.map((t) => ({
              weekNumber: t.weekNumber,
              weekLabel: t.weekLabel,
              startDate: t.startDate,
              topics: t.topics,
              readings: t.readings,
              notes: t.notes,
            })),
            canvasModules: input.contentModules,
            lectureCalendar: input.lectureCalendar.map((w) => ({
              weekNumber: w.weekNumber,
              startDate: w.startDate,
              lectures: w.lectures.map((l) => ({
                lectureNumber: l.lectureNumber,
                date: l.date,
                day: l.dayOfWeek,
              })),
            })),
            classSchedule: input.classSchedule
              ? {
                  meetings: input.classSchedule.meetings.map((m) => ({
                    label: m.label,
                    days: m.days,
                    startTime: m.startTime,
                    endTime: m.endTime,
                  })),
                  semesterStart: input.classSchedule.semesterStart,
                  semesterEnd: input.classSchedule.semesterEnd,
                }
              : null,
            termStartDate: input.termStartDate,
            termEndDate: input.termEndDate,
            assignments: input.assignments.filter((a) => a.dueDate).slice(0, 30),
            courseName: input.courseName,
          }),
        },
      ],
    }, { timeout: 60_000 });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.weeks) ? parsed.weeks : [];
  } catch (err) {
    console.warn(`[pipeline] enrichTimeline failed:`, err);
    return [];
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
  const aiTopics = extraction.topics;
  debug.stage3Weeks = aiTopics.length;

  console.log(`[pipeline] ${input.courseName}: Stage 3 extracted ${aiTopics.length} weeks from ${input.candidates.length} source(s)`);

  // ── STAGE 3b: BUILD LECTURE CALENDAR ──
  const lectureCalendar = buildLectureCalendar(
    input.classSchedule,
    input.termStartDate ?? input.classSchedule?.semesterStart ?? null,
    input.termEndDate ?? input.classSchedule?.semesterEnd ?? null,
  );
  debug.lectureCalendarDates = lectureCalendar.reduce((sum, w) => sum + w.lectures.length, 0);

  if (lectureCalendar.length > 0) {
    console.log(
      `[pipeline] ${input.courseName}: Stage 3b built lecture calendar — ` +
      `${debug.lectureCalendarDates} lectures across ${lectureCalendar.length} weeks`,
    );
  }

  // ── STAGE 4: ENRICH ──
  let finalTopics: ParsedTopic[];
  let moduleIdsToDelete: string[];

  if (aiTopics.length === 0 && contentModules.length === 0) {
    // Nothing from either source
    finalTopics = [];
    moduleIdsToDelete = [];
    debug.fallbackUsed = true;
    console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no data from either source`);

  } else if (aiTopics.length === 0) {
    // No syllabus topics — keep content modules, delete only admin/assessment
    finalTopics = [];
    moduleIdsToDelete = nonContentModuleIds;
    debug.fallbackUsed = true;
    console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no AI topics, keeping ${contentModules.length} content modules`);

  } else {
    // We have AI topics — enrich with everything we have
    const hasModules = contentModules.length > 0;
    console.log(
      `[pipeline] ${input.courseName}: Stage 4 enriching ${aiTopics.length} AI topics` +
      (hasModules ? ` + ${contentModules.length} content modules` : "") +
      (lectureCalendar.length > 0 ? ` + ${lectureCalendar.length}-week lecture calendar` : ""),
    );

    const enriched = await enrichTimeline({
      contentModules: contentModules.map((m) => ({
        weekLabel: m.weekLabel,
        topics: m.topics,
        readings: m.readings,
      })),
      aiTopics,
      lectureCalendar,
      classSchedule: input.classSchedule,
      termStartDate: input.termStartDate,
      termEndDate: input.termEndDate,
      assignments: input.assignments,
      courseName: input.courseName,
    });

    if (enriched.length > 0) {
      finalTopics = enriched;
      // Delete ALL old module topics — the enriched timeline contains their data
      moduleIdsToDelete = input.modules.map((m) => m.id);
      debug.stage4OutputWeeks = enriched.length;
      console.log(`[pipeline] ${input.courseName}: Stage 4 produced ${enriched.length} enriched weeks`);
    } else {
      // Enrich failed — use AI topics as-is, keep content modules
      console.warn(`[pipeline] ${input.courseName}: Stage 4 enrich returned 0 weeks, falling back to Stage 3`);
      finalTopics = aiTopics;
      moduleIdsToDelete = nonContentModuleIds;
      debug.fallbackUsed = true;
    }
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
