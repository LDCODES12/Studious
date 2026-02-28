/**
 * Topic Pipeline: Multi-stage AI fusion for course content timelines.
 *
 * Replaces the old threshold-based merge logic (strongAiCoverage + nonWeeklyModuleRatio)
 * with a 5-stage pipeline:
 *   1. COLLECT  — gather inputs (done by caller)
 *   2. CLASSIFY — AI classifies Canvas modules as content/assessment/admin
 *   3. EXTRACT  — existing parseSyllabusTopics with expanded windowing
 *   4. FUSE     — AI merges classified modules + extracted topics into one timeline
 *   5. VALIDATE — algorithmic sanity checks
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

// ─── Stage 4: FUSE ──────────────────────────────────────────────────────────

interface FuseInput {
  contentModules: { weekLabel: string; topics: string[]; readings: string[] }[];
  aiTopics: ParsedTopic[];
  classSchedule: ClassScheduleInfo | null;
  termStartDate: string | null;
  termEndDate: string | null;
  assignments: { title: string; dueDate: string | null }[];
}

async function fuseTimeline(input: FuseInput): Promise<ParsedTopic[]> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-2024-08-06",
      temperature: 0,
      seed: 1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a course timeline builder. You receive multiple data sources about a university course and must produce ONE unified week-by-week timeline for the semester.

INPUTS YOU WILL RECEIVE:
1. SYLLABUS TOPICS: AI-extracted topics from the syllabus (may be organized by week, lecture number, or unit — the structure varies)
2. CANVAS MODULES: Module names from the course's LMS that were classified as "content" (administrative/assessment modules already filtered out)
3. CLASS SCHEDULE: The recurring meeting pattern (e.g. MWF 9:00-9:50 AM) — use this to map lecture numbers to calendar dates
4. TERM DATES: Semester start and end dates
5. ASSIGNMENTS: Assignment titles with due dates — use these as date anchors when syllabus topics lack dates

YOUR JOB:
Produce a single chronological timeline where each entry = one week of the semester.

MERGE RULES:
- When syllabus topics and Canvas modules cover the same content, PREFER the syllabus topics (they are usually more detailed). Use Canvas module names only to fill gaps or add context.
- When the syllabus uses lecture numbers (e.g. "Lectures 1-5: Chemical Equilibria"), convert to calendar weeks using the class schedule. Example: MWF starting Jan 13 → Lectures 1-3 = Week 1 (Jan 13), Lectures 4-5 = Week 2 (Jan 20, partial).
- When the syllabus uses unit/chapter organization (not weeks), distribute units across the semester timeline proportionally or using date clues from assignments.
- If Canvas modules are just numbered units ("Unit 1", "Unit 2") and the syllabus has the same units with more detail, use the syllabus detail and drop the Canvas entries.
- If Canvas modules cover weeks that the syllabus does NOT cover, include them.

DATE ASSIGNMENT:
- If the syllabus provides explicit dates, use those.
- If the syllabus uses lecture numbers and you have a class schedule, compute dates: Week 1 starts on the first class day on or after termStartDate.
- If neither dates nor lecture numbers are available, space entries evenly across the term.
- Assignment due dates can help anchor topics to specific weeks (if "Exam 2" is due Feb 28 and the syllabus says "Unit 4 ends with Exam 2", Unit 4 should end around that week).

OUTPUT FORMAT:
Return JSON: { "weeks": [...] }
Each week must have:
- weekNumber: integer starting at 1
- weekLabel: 3-7 word description of the primary topic(s) — actual subject names, never "Week 1" or "TBD"
- startDate: ISO YYYY-MM-DD (the Monday of that week, or first class day)
- topics: array of all topics/concepts for this week
- readings: array of all readings (chapters, papers, page ranges)
- notes: optional string for special notes (breaks, no class, etc.)
- courseName: course name/code

IMPORTANT:
- Include every week of the semester — no gaps. If a week has no content (spring break, etc.), include it with a note.
- Do not invent topics. Only use content from the provided sources.
- Ensure dates are chronological and within the term date range.`,
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
          }),
        },
      ],
    }, { timeout: 60_000 });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.weeks) ? parsed.weeks : [];
  } catch (err) {
    console.warn(`[pipeline] fuseTimeline failed:`, err);
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

  return { topics, warnings };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function runTopicPipeline(input: PipelineInput): Promise<PipelineResult> {
  const debug: PipelineDebug = {
    stage2Classifications: [],
    stage3Sources: input.candidates.length,
    stage3Weeks: 0,
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

  // ── STAGE 4: FUSE ──
  let finalTopics: ParsedTopic[];
  let moduleIdsToDelete: string[];

  if (aiTopics.length === 0 && contentModules.length === 0) {
    // Nothing from either source
    finalTopics = [];
    moduleIdsToDelete = [];
    debug.fallbackUsed = true;
    console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no data from either source`);

  } else if (aiTopics.length === 0) {
    // No syllabus topics — keep content modules as timeline, delete admin/assessment only
    finalTopics = [];
    moduleIdsToDelete = nonContentModuleIds;
    debug.fallbackUsed = true;
    console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no AI topics, keeping ${contentModules.length} content modules`);

  } else if (contentModules.length === 0) {
    // No content modules — AI topics are the whole timeline
    finalTopics = aiTopics;
    moduleIdsToDelete = input.modules.map((m) => m.id);
    debug.fallbackUsed = false;
    console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no content modules, using ${aiTopics.length} AI topics`);

  } else {
    // Both sources present — run fusion
    console.log(`[pipeline] ${input.courseName}: Stage 4 fusing ${aiTopics.length} AI topics + ${contentModules.length} content modules`);

    const fused = await fuseTimeline({
      contentModules: contentModules.map((m) => ({
        weekLabel: m.weekLabel,
        topics: m.topics,
        readings: m.readings,
      })),
      aiTopics,
      classSchedule: input.classSchedule,
      termStartDate: input.termStartDate,
      termEndDate: input.termEndDate,
      assignments: input.assignments,
    });

    if (fused.length > 0) {
      finalTopics = fused;
      moduleIdsToDelete = input.modules.map((m) => m.id);
      debug.stage4OutputWeeks = fused.length;
      console.log(`[pipeline] ${input.courseName}: Stage 4 produced ${fused.length} fused weeks`);
    } else {
      // Fuse failed — fall back to AI topics alone
      console.warn(`[pipeline] ${input.courseName}: Stage 4 fuse returned 0 weeks, falling back to Stage 3`);
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
