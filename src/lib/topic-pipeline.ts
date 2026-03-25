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

import { generateObject } from "ai";
import { modelConfig } from "./ai-models.ts";
import { z } from "zod";
import { addDays, addYears, differenceInCalendarDays, parseISO, startOfWeek, subDays } from "date-fns";
import {
  parseSyllabusTopics,
  sanitizeSchedule,
  renumberSequentialWeeks,
  needsAudit,
  auditSchedule,
  bestWindow,
  detectSourceFormat,
  isContentfulTopic,
  parsedTopicSchema,
  type ParsedTopic,
} from "./parse-syllabus.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScoredSource {
  text: string;
  score: number;
  label: string;
  role?: CandidateRole;
}

type CandidateRole = "timeline" | "content" | "mixed";

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

export interface SyllabusEventInfo {
  title: string;
  dueDate: string | null;
  type: string;
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
  syllabusEvents?: SyllabusEventInfo[];
}

export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";
export type ScheduleMode = "weekly" | "sparse" | "inferred" | "unknown";
export type TimelineQuality = "strong" | "usable" | "weak";
export type TimelineAnchorType =
  | "explicit_date"
  | "inferred_week"
  | "sparse_meeting"
  | "break"
  | "module_scaffold"
  | "lecture_group";

export interface TimelineAnchorRecord {
  sequenceNumber: number;
  anchorDate: string | null;
  anchorType: TimelineAnchorType;
  isInstructional: boolean;
  calendarConfidence: ConfidenceLevel;
  sourceRefs: { label: string; role: CandidateRole }[];
  notes?: string | null;
}

export interface SynthesizedTopic extends ParsedTopic {
  dateConfidence: ConfidenceLevel;
  contentConfidence: ConfidenceLevel;
  scheduleMode: ScheduleMode;
  provenance: Record<string, unknown>;
}

export interface PipelineResult {
  topics: SynthesizedTopic[];
  anchors: TimelineAnchorRecord[];
  timelineMode: ScheduleMode;
  materialSourceRoles: { label: string; role: CandidateRole }[];
  timelineDiagnostics: Record<string, unknown>;
  moduleIdsToDelete: string[];
  debug: PipelineDebug;
}

export interface PipelineDebug {
  stage2Classifications: { name: string; category: string }[];
  stage3Sources: number;
  stage3Weeks: number;
  moduleContextChars: number;
  lectureCalendarDates: number;
  stage4OutputWeeks: number;
  stage5Warnings: string[];
  fallbackUsed: boolean;
  sourceRoles?: { label: string; role: CandidateRole }[];
  timelineSource?: string;
  contentSource?: string;
  lectureCalendarSource?: string;
}

export interface FinalizeTimelineResult {
  topics: ParsedTopic[];
  warnings: string[];
  repairActionsApplied: string[];
  timelineQuality: TimelineQuality;
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

// ─── Stage 2: CLASSIFY ──────────────────────────────────────────────────────

type ModuleCategory = "content" | "assessment" | "administrative";

async function classifyModules(
  moduleNames: string[],
): Promise<Map<string, ModuleCategory>> {
  if (moduleNames.length === 0) return new Map();

  const classificationSchema = z.object({
    classifications: z.array(z.object({
      name: z.string(),
      category: z.enum(["content", "assessment", "administrative"]),
    })),
  });

  try {
    const { object } = await generateObject({
      ...modelConfig("low"),
      schema: classificationSchema,
      system: `You classify Canvas LMS module names into exactly one of three categories:

- "content": Modules that represent academic course content students learn (e.g. "Unit 1: Chemical Equilibria", "Week 3: The French Revolution", "Module 4 - Thermodynamics", "Intro to Linear Algebra", "Class 1 Paper", "Week 2 Readings", "Lecture 5 Materials").
- "assessment": Modules that are primarily containers for graded submissions the student turns in (e.g. "Quiz", "Midterm", "Exam 2", "Homework Submissions", "Problem Set Drop Box").
- "administrative": Modules that are course logistics, tools, or orientation (e.g. "Orientation", "Welcome", "Course Information", "Aktiv Chemistry", "Piazza", "Discussion Module", "Syllabus", "Getting Started", "Zoom Links").

Rules:
- A module named like "Unit 1" or "Module 1" with NO descriptive subtitle is still "content" — it is a content container even without a topic name.
- Modules that combine content with assessment (e.g. "Week 5: Exam Review") are "content".
- "Paper" in an academic context usually means a research paper to READ, not a paper to submit. Modules like "Class 1 Paper", "Paper(s)", "Reading 3" are "content" — they contain readings for class discussion.
- Only classify as "assessment" when the module is clearly a submission container (quiz, exam, homework dropbox). If it could be either reading material or a submission, prefer "content".
- When in doubt between content and administrative, prefer "content".
- Classify EVERY module in the input list.`,
      prompt: JSON.stringify(moduleNames),
      abortSignal: AbortSignal.timeout(20_000),
    });

    const map = new Map<string, ModuleCategory>();
    for (const item of object.classifications) {
      map.set(item.name, item.category);
    }
    return map;
  } catch (err) {
    console.warn(`[pipeline] classifyModules failed, defaulting all to content:`, err);
    return new Map();
  }
}

const TIMELINE_LABEL_RX = /\b(syllab|schedul|course[\s._-]?(guide|outline|info|overview)|calendar)\b/i;
const CONTENT_LABEL_RX = /\b(lecture|delivered|study\s+outline|review\s+questions|quiz\s+topics?|exam\s+\d|midterm|slides?)\b/i;
const DATE_TOKEN_RX = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi;
const EXPLICIT_SCHEDULE_RX = /\b(schedule|weekly\s+schedule|course\s+schedule|we(?:'?| )ll\s+meet|meeting\s+dates?)\b/i;
const BREAK_RX = /\bspring break|no class|holiday\b/i;
const FULL_BREAK_RX = /\bspring break\b|\bacademic break\b|\bread(?:ing)? days?\b|\bbye week\b|\bholiday\b|\bno classes\b/i;
const PARTIAL_NO_CLASS_RX = /\bno class(?:es)?\s+(?:on|for)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}\/\d{1,2})/i;
const SLIDE_DECK_RX = /\b(on the agenda|learning objectives|discussion questions|delivered|slide|today we(?:'| )ll|what is|who is this)\b/i;
const GENERIC_WEEK_LABEL_RX = /^(lectures?|course resources|report discussions|midterm exam prep materials|review materials|assignment descriptions)$/i;
const ADMIN_ENTRY_RX = /^(syllabus|course schedule|office hours?|course information|course resources|exam resources)$/i;
const BREAK_SEGMENT_RX = /\bspring break\b|\bacademic break\b|\bread(?:ing)? days?\b|\bbye week\b|\bholiday\b|\bno classes?\b|\bno lecture\b|\bno lab\b/i;
const MONTH_TO_INDEX: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function countMatches(text: string, rx: RegExp): number {
  return text.match(rx)?.length ?? 0;
}

function classifyCandidateRole(src: ScoredSource): CandidateRole {
  if (src.role) return src.role;

  const label = src.label.toLowerCase();
  const text = src.text.toLowerCase();
  const format = detectSourceFormat(src.text);
  const isHtmlBody = label === "html-body";

  const labelTimeline = TIMELINE_LABEL_RX.test(label) ? 3 : 0;
  const labelContent = CONTENT_LABEL_RX.test(label) ? 3 : 0;
  const explicitSchedule = EXPLICIT_SCHEDULE_RX.test(text) ? 4 : 0;
  const breakMentions = BREAK_RX.test(text) ? 2 : 0;
  const dateMentions = Math.min(isHtmlBody ? 2 : 5, countMatches(src.text, DATE_TOKEN_RX));
  const weekMentions = Math.min(5, countMatches(text, /\bweek\s+\d+\b/g));
  const lectureMentions = Math.min(5, countMatches(text, /\blecture\s+\d+\b/g));
  const slideSignals = SLIDE_DECK_RX.test(text) ? 3 : 0;
  const calendarFormat = format.includes("calendar") ? 3 : 0;
  const structuredSchedule = format.includes("structured schedule") || format.includes("tab-separated") ? 2 : 0;

  const timelineScore =
    labelTimeline +
    explicitSchedule +
    breakMentions +
    dateMentions +
    Math.min(3, weekMentions) +
    calendarFormat +
    structuredSchedule;
  const contentScore =
    labelContent +
    slideSignals +
    lectureMentions +
    (src.score > 1.5 ? 1 : 0);

  if (isHtmlBody && explicitSchedule === 0 && calendarFormat === 0 && structuredSchedule === 0) {
    if (lectureMentions > 0 || slideSignals > 0 || contentScore >= timelineScore) return "content";
    if (timelineScore >= 6) return "mixed";
    return "content";
  }

  if (timelineScore >= 6 && contentScore >= 4) return "mixed";
  if (timelineScore >= contentScore + 2 && timelineScore >= 5) return "timeline";
  if (contentScore >= timelineScore + 2 && contentScore >= 4) return "content";
  if (timelineScore >= 4 && contentScore >= 3) return "mixed";
  return timelineScore >= contentScore ? "timeline" : "content";
}

function splitCandidatesByAuthority(candidates: ScoredSource[]) {
  const classified = candidates.map((src) => ({ ...src, role: classifyCandidateRole(src) }));
  const timelineCandidates = classified.filter((src) => src.role === "timeline" || src.role === "mixed");
  const contentCandidates = classified.filter((src) => src.role === "content" || src.role === "mixed");
  return {
    classified,
    timelineCandidates: timelineCandidates.length > 0 ? timelineCandidates : classified,
    contentCandidates: contentCandidates.length > 0 ? contentCandidates : classified,
  };
}

function summarizeAuthorityCandidates(
  candidates: Array<ScoredSource & { role?: CandidateRole }>,
  usedLabel: string,
) {
  const ranked = [...candidates]
    .sort((a, b) => b.score !== a.score ? b.score - a.score : b.text.length - a.text.length)
    .slice(0, 3)
    .map((candidate) => ({
      label: candidate.label,
      role: candidate.role ?? classifyCandidateRole(candidate),
      score: Number(candidate.score.toFixed(3)),
      chars: candidate.text.length,
    }));

  return {
    winner: usedLabel,
    runnerUp: ranked.find((candidate) => candidate.label !== usedLabel)?.label ?? null,
    ranked,
  };
}

// ─── Stage 3: EXTRACT ───────────────────────────────────────────────────────

interface ExtractionResult {
  topics: ParsedTopic[];
  usedLabel: string;
  usedWindow: string;
}

/**
 * Serialize content modules into a compact text block that can be appended to
 * syllabus text before AI extraction.  This gives the model both sources of
 * truth — the syllabus schedule AND the Canvas module structure — so it can
 * cross-reference topics, fill gaps, and produce richer results.
 *
 * Budget: ~5 000 chars to avoid crowding out the syllabus window.
 */
function serializeModulesForExtraction(
  modules: CanvasModuleInfo[],
  budget = 5000,
): string {
  if (modules.length === 0) return "";

  const lines: string[] = [
    "",
    "--- CANVAS MODULE STRUCTURE (supplementary context — use to correlate topics and fill gaps) ---",
  ];

  for (const m of modules) {
    const header = m.weekLabel;
    const topicList = (m.topics ?? []).filter(Boolean);
    const readingList = (m.readings ?? []).filter(Boolean);

    let entry = header;
    if (topicList.length > 0) entry += `\n  Topics: ${topicList.join(", ")}`;
    if (readingList.length > 0) entry += `\n  Readings: ${readingList.join(", ")}`;

    // Check budget before adding
    const candidate = lines.join("\n") + "\n" + entry + "\n---";
    if (candidate.length > budget) break;

    lines.push(entry);
  }

  lines.push("---");
  return lines.join("\n");
}

async function extractTopicsExpanded(
  candidates: ScoredSource[],
  courseName: string,
  moduleContext?: string,
): Promise<ExtractionResult> {
  const FULL_TEXT_THRESHOLD = 40_000;
  const LARGE_WINDOW_SIZE = 30_000;

  const allGoodResults: { result: ParsedTopic[]; label: string; fmt: string; win: string }[] = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const src = candidates[ci];

    // Expanded windowing: send full text for PDFs under 30k chars
    const win = src.text.length <= FULL_TEXT_THRESHOLD
      ? src.text
      : bestWindow(src.text, LARGE_WINDOW_SIZE);

    // Append module context so the AI sees both syllabus and Canvas structure
    const winWithModules = moduleContext ? win + moduleContext : win;

    const fmt = detectSourceFormat(src.text);
    const hint = `${src.label}, format: ${fmt}`;
    const raw = await parseSyllabusTopics(winWithModules, hint);
    const result = sanitizeSchedule(raw).filter(isContentfulTopic);

    const richWeeks = result.filter(
      (t) => (t.topics ?? []).length > 0 || (t.readings ?? []).length > 0,
    ).length;
    const datedWeeks = result.filter((t) => typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate)).length;
    const noteWeeks = result.filter((t) => typeof t.notes === "string" && t.notes.trim().length > 0).length;
    const dateDenseSchedule =
      result.length > 0 &&
      result.length <= 8 &&
      (datedWeeks / result.length >= 0.8 || (datedWeeks + noteWeeks) / result.length >= 0.8);
    const isGoodResult =
      result.length > 0 &&
      (result.length < 4 || richWeeks / result.length >= 0.4 || dateDenseSchedule);

    console.log(`[pipeline] ${courseName} extract[${ci}] ${src.label} fmt=${fmt}: ${result.length} weeks, ${richWeeks} rich, ${datedWeeks} dated → ${isGoodResult ? "ACCEPTED" : "rejected"}`);

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

function hasInstructionalContent(topic: ParsedTopic): boolean {
  return (topic.topics?.length ?? 0) > 0 || (topic.readings?.length ?? 0) > 0;
}

function isBreakTopic(topic: ParsedTopic): boolean {
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

function tokenizeWeekText(topic: ParsedTopic): Set<string> {
  return tokenize([topic.weekLabel, ...(topic.topics ?? []), ...(topic.readings ?? [])].join(" "));
}

function isAdministrativeEntry(entry: string): boolean {
  return ADMIN_ENTRY_RX.test(entry.trim());
}

function isAdministrativeOnlyTopic(topic: ParsedTopic): boolean {
  const entries = [...(topic.topics ?? []), ...(topic.readings ?? [])].map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 && entries.every(isAdministrativeEntry);
}

function mergeContentOntoTimeline(
  timelineTopics: ParsedTopic[],
  contentTopics: ParsedTopic[],
  courseName: string,
): ParsedTopic[] {
  if (timelineTopics.length === 0) return contentTopics;
  if (contentTopics.length === 0) return timelineTopics;

  const merged = timelineTopics.map((topic) => ({
    ...topic,
    topics: [...(topic.topics ?? [])],
    readings: [...(topic.readings ?? [])],
  }));

  const contentByWeek = new Map<number, ParsedTopic>();
  for (const topic of contentTopics) {
    if (!contentByWeek.has(topic.weekNumber)) {
      contentByWeek.set(topic.weekNumber, topic);
    }
  }

  const timelineKeywords = merged.map((topic) => tokenizeWeekText(topic));

  for (let i = 0; i < merged.length; i++) {
    const spine = merged[i];
    if (isBreakTopic(spine)) continue;

    let content = contentByWeek.get(spine.weekNumber) ?? null;
    if (!content) {
      const spineKeywords = timelineKeywords[i];
      let bestMatch: ParsedTopic | null = null;
      let bestOverlap = 0;
      for (const candidate of contentTopics) {
        const candidateKeywords = tokenizeWeekText(candidate);
        let overlap = 0;
        for (const token of spineKeywords) {
          if (candidateKeywords.has(token)) overlap++;
        }
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestMatch = candidate;
        }
      }
      if (bestOverlap >= 2) {
        content = bestMatch;
      } else if (contentTopics.length === timelineTopics.length) {
        content = contentTopics[i] ?? null;
      } else {
        const mappedIndex = timelineTopics.length === 1
          ? 0
          : Math.round(i * (contentTopics.length - 1) / Math.max(1, timelineTopics.length - 1));
        content = contentTopics[mappedIndex] ?? null;
      }
    }

    if (!content) continue;

    const mergedTopics = new Set<string>(spine.topics ?? []);
    for (const topic of content.topics ?? []) {
      if (!mergedTopics.has(topic)) {
        mergedTopics.add(topic);
      }
    }

    const mergedReadings = new Set<string>(spine.readings ?? []);
    for (const reading of content.readings ?? []) {
      if (!mergedReadings.has(reading)) {
        mergedReadings.add(reading);
      }
    }

    merged[i] = {
      ...spine,
      weekLabel:
        /^week\s+\d+$/i.test(spine.weekLabel) && content.weekLabel
          ? content.weekLabel
          : spine.weekLabel,
      topics: [...mergedTopics],
      readings: [...mergedReadings],
      notes: spine.notes ?? content.notes,
      courseName: content.courseName ?? spine.courseName,
    };
  }

  console.log(
    `[pipeline] ${courseName}: merged ${contentTopics.length} content week(s) onto ${timelineTopics.length} timeline week(s)`,
  );

  return merged;
}

function isSparseTimeline(topics: ParsedTopic[]): boolean {
  if (topics.length < 2 || topics.length > 8) return false;
  const dated = topics.filter((topic) => topic.startDate && /^\d{4}-\d{2}-\d{2}$/.test(topic.startDate));
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

function inferIsoDateFromText(
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

  const monthDayYearRx = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:,?\s+(\d{2,4}))?\b/gi;
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

function normalizeNotesValue(notes: unknown): string | null {
  if (typeof notes === "string") {
    return notes.trim() ? notes : null;
  }
  if (Array.isArray(notes)) {
    const flattened = notes
      .flatMap((item) => typeof item === "string" ? [item.trim()] : [])
      .filter(Boolean);
    return flattened.length > 0 ? flattened.join("; ") : null;
  }
  return null;
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
    ...segments.filter((segment) => /\bread(?:ing)? days?\b|\bbye week\b|\bacademic break\b/i.test(segment) && !/\bspring break\b/i.test(segment)),
    ...segments.filter((segment) => !/\bspring break\b|\bread(?:ing)? days?\b|\bbye week\b|\bacademic break\b/i.test(segment)),
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
    if (mondayStr > topic.startDate) return mondayStr;
  }

  if (sawExplicitBreakDate) {
    return null;
  }

  if (prioritized.some((segment) => FULL_BREAK_RX.test(segment))) {
    return addDays(currentStart, 7).toISOString().slice(0, 10);
  }

  return null;
}

function inferBreakLabel(topic: ParsedTopic): string {
  const text = `${topic.weekLabel ?? ""} ${normalizeNotesValue(topic.notes) ?? ""}`;
  if (/\bspring break\b/i.test(text)) return "Spring Break — No Class";
  if (/\bread(?:ing)? days?\b/i.test(text)) return "Reading Days";
  if (/\bbye week\b/i.test(text)) return "Bye Week — No Class";
  if (/\bholiday\b/i.test(text)) return "Holiday — No Class";
  return "No Class / Academic Break";
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
      result.push({
        weekNumber: topic.weekNumber + 0.5,
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

function insertBreakWeeksFromDateGaps(
  topics: ParsedTopic[],
  courseName: string,
): ParsedTopic[] {
  if (topics.length < 2 || isSparseTimeline(topics)) return topics;

  const ordered = [...topics].sort((a, b) => {
    if (a.startDate && b.startDate && a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    if (a.startDate && !b.startDate) return -1;
    if (!a.startDate && b.startDate) return 1;
    return a.weekNumber - b.weekNumber;
  });

  const existingBreakStarts = new Set(
    ordered
      .filter((topic) => topic.startDate && isBreakTopic(topic))
      .map((topic) => topic.startDate as string),
  );

  const result: ParsedTopic[] = [];
  let inserted = 0;

  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i];
    result.push(current);

    const next = ordered[i + 1];
    if (!current.startDate || !next?.startDate) continue;
    if (isBreakTopic(current) || isBreakTopic(next)) continue;

    let cursor = addDays(parseISO(`${current.startDate}T12:00:00Z`), 7);
    const nextStart = parseISO(`${next.startDate}T12:00:00Z`);

    while (differenceInCalendarDays(nextStart, cursor) >= 7) {
      const breakStart = cursor.toISOString().slice(0, 10);
      if (!existingBreakStarts.has(breakStart)) {
        existingBreakStarts.add(breakStart);
        inserted += 1;
        result.push({
          weekNumber: current.weekNumber + inserted * 0.1,
          weekLabel: "No Class / Academic Break",
          startDate: breakStart,
          topics: [],
          readings: [],
          notes: "Inferred no-class week from lecture schedule gap",
          courseName,
        });
      }
      cursor = addDays(cursor, 7);
    }
  }

  if (inserted > 0) {
    console.log(`[pipeline] ${courseName}: inserted ${inserted} break week(s) from dated gaps`);
  }

  return result;
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

    const previousBreakStart =
      topic.startDate
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
    console.log(`[pipeline] ${courseName}: stripped carried break notes from ${cleanedCount} instructional week(s)`);
  }

  return cleaned;
}

interface TimelineSpine {
  topics: ParsedTopic[];
  anchors: TimelineAnchorRecord[];
  scheduleMode: ScheduleMode;
}

function buildTimelineSpine(args: {
  topics: ParsedTopic[];
  hasTimelineAuthority: boolean;
  usedModuleScaffold: boolean;
  lectureCalendarSource: PipelineDebug["lectureCalendarSource"];
  sourceRefs: { label: string; role: CandidateRole }[];
}): TimelineSpine {
  const scheduleMode: ScheduleMode = isSparseTimeline(args.topics)
    ? "sparse"
    : args.topics.some((topic) => Boolean(topic.startDate))
      ? "weekly"
      : args.usedModuleScaffold || !args.hasTimelineAuthority
        ? "inferred"
        : "unknown";

  const anchors: TimelineAnchorRecord[] = args.topics.map((topic, index) => {
    let anchorType: TimelineAnchorType = "inferred_week";
    let calendarConfidence: ConfidenceLevel = "low";

    if (isBreakTopic(topic)) {
      anchorType = "break";
      calendarConfidence = topic.startDate ? "medium" : "low";
    } else if (scheduleMode === "sparse" && topic.startDate) {
      anchorType = "sparse_meeting";
      calendarConfidence = args.hasTimelineAuthority ? "high" : "medium";
    } else if (args.hasTimelineAuthority && topic.startDate) {
      anchorType = "explicit_date";
      calendarConfidence = "high";
    } else if (args.usedModuleScaffold) {
      anchorType = "module_scaffold";
      calendarConfidence = topic.startDate ? "medium" : "low";
    } else if (topic.startDate && args.lectureCalendarSource === "lecture-anchors") {
      anchorType = "lecture_group";
      calendarConfidence = "medium";
    } else if (topic.startDate) {
      anchorType = "inferred_week";
      calendarConfidence = "medium";
    }

    return {
      sequenceNumber: index + 1,
      anchorDate: topic.startDate ?? null,
      anchorType,
      isInstructional:
        !isBreakTopic(topic) &&
        (args.topics.length <= 8 && args.topics.some((t) => Boolean(t.startDate))
          ? Boolean(topic.startDate) || hasInstructionalContent(topic)
          : hasInstructionalContent(topic)),
      calendarConfidence,
      sourceRefs: args.sourceRefs,
      notes: topic.notes ?? null,
    };
  });

  return { topics: args.topics, anchors, scheduleMode };
}

function mergeContentOntoSpine(args: {
  spine: TimelineSpine;
  topics: ParsedTopic[];
  timelineSource: string;
  contentSource: string;
  lectureCalendarSource: PipelineDebug["lectureCalendarSource"];
  sourceRefs: { label: string; role: CandidateRole }[];
  usedModuleScaffold: boolean;
  validationWarnings: string[];
}): SynthesizedTopic[] {
  return args.topics.map((topic, index) => {
    const anchor = args.spine.anchors[index] ?? {
      sequenceNumber: index + 1,
      anchorDate: topic.startDate ?? null,
      anchorType: "inferred_week" as const,
      isInstructional: true,
      calendarConfidence: "unknown" as const,
      sourceRefs: args.sourceRefs,
      notes: topic.notes ?? null,
    };

    const hasContent = (topic.topics?.length ?? 0) > 0 || (topic.readings?.length ?? 0) > 0;
    const contentConfidence: ConfidenceLevel =
      !hasContent
        ? "low"
        : args.contentSource !== "none"
          ? "high"
          : args.usedModuleScaffold
            ? "medium"
            : "low";

    return {
      ...topic,
      dateConfidence: anchor.calendarConfidence,
      contentConfidence,
      scheduleMode: args.spine.scheduleMode,
      provenance: {
        anchorSequenceNumber: anchor.sequenceNumber,
        anchorType: anchor.anchorType,
        timelineSource: args.timelineSource,
        contentSource: args.contentSource,
        lectureCalendarSource: args.lectureCalendarSource ?? "none",
        sourceRefs: anchor.sourceRefs,
        usedModuleScaffold: args.usedModuleScaffold,
        validationWarnings: args.validationWarnings,
      },
    };
  });
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

interface LectureAnchor {
  lectureNumber: number;
  dueDate: string;
  title: string;
  source: "assignment" | "syllabus-event";
}

interface LectureCalendarBuild {
  weeks: WeekDateRange[];
  source: "none" | "term-start" | "lecture-anchors";
}

const DAY_CODES: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

function buildLectureCalendar(
  classSchedule: ClassScheduleInfo | null,
  termStartDate: string | null,
  termEndDate: string | null,
  assignments: AssignmentDateInfo[],
  syllabusEvents: SyllabusEventInfo[],
): LectureCalendarBuild {
  if (!classSchedule || !termStartDate) {
    return { weeks: [], source: "none" };
  }

  // Find lecture meetings (not labs, discussions, etc.)
  // Labels may be freeform from AI extraction (e.g. "Lecture (Section 1)"),
  // so match any label that starts with "lecture" or is unlabeled (default).
  const lectureMeetings = classSchedule.meetings.filter((m) => {
    const l = m.label.toLowerCase().trim();
    return l === "" || l.startsWith("lecture");
  });
  if (lectureMeetings.length === 0) {
    return { weeks: [], source: "none" };
  }

  // Get unique lecture days (e.g., [1, 3, 5] for MWF)
  const lectureDayCodes = new Set<number>();
  for (const m of lectureMeetings) {
    for (const d of m.days) {
      const code = DAY_CODES[d.toUpperCase()];
      if (code !== undefined) lectureDayCodes.add(code);
    }
  }
  const sortedDays = [...lectureDayCodes].sort((a, b) => a - b);
  if (sortedDays.length === 0) {
    return { weeks: [], source: "none" };
  }

  const DAY_NAMES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const parsedTermStart = new Date(termStartDate + "T12:00:00");
  const end = termEndDate ? new Date(termEndDate + "T12:00:00") : new Date(parsedTermStart);
  if (!termEndDate) end.setDate(end.getDate() + 16 * 7); // default 16 weeks

  const lectureAnchors = extractLectureAnchors(assignments, syllabusEvents);
  const requiredCount = Math.max(
    24,
    lectureAnchors.reduce((max, anchor) => Math.max(max, anchor.lectureNumber + 6), 0),
  );
  const allLectures =
    lectureAnchors.length > 0
      ? buildBestAnchoredLectureSeries(lectureAnchors, sortedDays, parsedTermStart, end, requiredCount, DAY_NAMES)
      : generateLectureSeries(firstLectureOnOrAfter(parsedTermStart, sortedDays), sortedDays, end, requiredCount, DAY_NAMES);

  if (allLectures.length === 0) {
    return { weeks: [], source: "none" };
  }

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

  return {
    weeks,
    source: lectureAnchors.length > 0 ? "lecture-anchors" : "term-start",
  };
}

function extractLectureAnchors(
  assignments: AssignmentDateInfo[],
  syllabusEvents: SyllabusEventInfo[],
): LectureAnchor[] {
  const anchors = new Map<number, LectureAnchor>();
  const sources = [
    ...assignments.map((item) => ({ ...item, source: "assignment" as const })),
    ...syllabusEvents.map((item) => ({ ...item, source: "syllabus-event" as const })),
  ];

  for (const source of sources) {
    if (!source.dueDate) continue;
    const dueDate = parseISO(`${source.dueDate.slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(dueDate.getTime())) continue;

    const singleMatch = source.title.match(/\blecture\s*#?\s*(\d+)\b/i);
    const rangeMatch = source.title.match(/\blectures?\s*(\d+)\s*[-–]\s*(\d+)\b/i);
    const lectureNumber = singleMatch
      ? Number.parseInt(singleMatch[1], 10)
      : rangeMatch
        ? Number.parseInt(rangeMatch[2], 10)
        : null;

    if (!lectureNumber || lectureNumber < 1) continue;
    if (!anchors.has(lectureNumber)) {
      anchors.set(lectureNumber, {
        lectureNumber,
        dueDate: source.dueDate.slice(0, 10),
        title: source.title,
        source: source.source,
      });
    }
  }

  return [...anchors.values()].sort((a, b) => a.lectureNumber - b.lectureNumber);
}

function firstLectureOnOrAfter(date: Date, sortedDays: number[]): Date {
  const cursor = new Date(date);
  for (let i = 0; i < 7; i++) {
    if (sortedDays.includes(cursor.getDay())) return cursor;
    cursor.setDate(cursor.getDate() + 1);
  }
  return new Date(date);
}

function lastLectureOnOrBefore(date: Date, sortedDays: number[]): Date {
  const cursor = new Date(date);
  for (let i = 0; i < 7; i++) {
    if (sortedDays.includes(cursor.getDay())) return cursor;
    cursor.setDate(cursor.getDate() - 1);
  }
  return new Date(date);
}

function nextLectureDate(current: Date, sortedDays: number[]): Date {
  const cursor = new Date(current);
  for (let i = 1; i <= 7; i++) {
    cursor.setDate(cursor.getDate() + 1);
    if (sortedDays.includes(cursor.getDay())) return cursor;
  }
  return cursor;
}

function previousLectureDate(current: Date, sortedDays: number[]): Date {
  const cursor = new Date(current);
  for (let i = 1; i <= 7; i++) {
    cursor.setDate(cursor.getDate() - 1);
    if (sortedDays.includes(cursor.getDay())) return cursor;
  }
  return cursor;
}

function inferLectureSeriesStart(
  anchors: LectureAnchor[],
  sortedDays: number[],
  termStart: Date,
): Date | null {
  if (anchors.length === 0) return null;

  const earliest = anchors[0];
  let cursor = lastLectureOnOrBefore(parseISO(`${earliest.dueDate}T12:00:00Z`), sortedDays);
  for (let i = 1; i < earliest.lectureNumber; i++) {
    cursor = previousLectureDate(cursor, sortedDays);
  }

  return cursor < termStart ? firstLectureOnOrAfter(termStart, sortedDays) : cursor;
}

function inferEarliestPlausibleLectureWeekStart(
  anchors: LectureAnchor[],
  sortedDays: number[],
  termStart: Date,
): Date | null {
  if (anchors.length === 0 || sortedDays.length === 0) return null;

  const earliest = anchors[0];
  const dueDate = parseISO(`${earliest.dueDate}T12:00:00Z`);
  if (Number.isNaN(dueDate.getTime())) return null;

  const lecturesPerWeek = Math.max(1, sortedDays.length);
  const weekIndex = Math.floor(Math.max(0, earliest.lectureNumber - 1) / lecturesPerWeek);
  const anchorWeekStart = startOfWeek(dueDate, { weekStartsOn: 1 });
  const earliestPlausible = addDays(anchorWeekStart, -7 * weekIndex);
  const firstInstructionalWeek = startOfWeek(firstLectureOnOrAfter(termStart, sortedDays), { weekStartsOn: 1 });

  return earliestPlausible < firstInstructionalWeek ? firstInstructionalWeek : earliestPlausible;
}

function clampLectureSeriesToPlausibleWeekStart(
  allLectures: LectureDate[],
  minimumWeekStart: Date | null,
): void {
  if (allLectures.length === 0 || !minimumWeekStart || Number.isNaN(minimumWeekStart.getTime())) return;

  let currentWeekStart = startOfWeek(parseISO(`${allLectures[0].date}T12:00:00Z`), { weekStartsOn: 1 });
  if (Number.isNaN(currentWeekStart.getTime())) return;

  while (currentWeekStart < minimumWeekStart) {
    for (const lecture of allLectures) {
      const shifted = addDays(parseISO(`${lecture.date}T12:00:00Z`), 7);
      lecture.date = shifted.toISOString().slice(0, 10);
      lecture.dayOfWeek = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][shifted.getDay()];
    }
    currentWeekStart = startOfWeek(parseISO(`${allLectures[0].date}T12:00:00Z`), { weekStartsOn: 1 });
  }
}

function generateLectureSeries(
  firstLectureDate: Date,
  sortedDays: number[],
  endDate: Date,
  requiredCount: number,
  dayNames: string[],
): LectureDate[] {
  const allLectures: LectureDate[] = [];
  let cursor = new Date(firstLectureDate);
  let lectureNumber = 1;
  const hardEnd = new Date(endDate);
  hardEnd.setDate(hardEnd.getDate() + 28);

  while (cursor <= hardEnd || lectureNumber <= requiredCount) {
    allLectures.push({
      lectureNumber,
      date: cursor.toISOString().slice(0, 10),
      dayOfWeek: dayNames[cursor.getDay()],
    });
    lectureNumber++;
    cursor = nextLectureDate(cursor, sortedDays);
    if (lectureNumber > requiredCount && cursor > hardEnd) break;
  }

  return allLectures;
}

function buildBestAnchoredLectureSeries(
  anchors: LectureAnchor[],
  sortedDays: number[],
  termStart: Date,
  endDate: Date,
  requiredCount: number,
  dayNames: string[],
): LectureDate[] {
  const baseStart = inferLectureSeriesStart(anchors, sortedDays, termStart);
  if (!baseStart) return [];
  const minimumWeekStart = inferEarliestPlausibleLectureWeekStart(anchors, sortedDays, termStart);

  const candidateStarts: Date[] = [baseStart];
  let cursor = new Date(baseStart);
  for (let i = 1; i < sortedDays.length; i++) {
    cursor = previousLectureDate(cursor, sortedDays);
    candidateStarts.push(new Date(cursor));
  }

  let bestSeries: LectureDate[] = [];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidateStart of candidateStarts) {
    const candidateSeries = generateLectureSeries(candidateStart, sortedDays, endDate, requiredCount, dayNames);
    reconcileLectureSeriesToAnchors(candidateSeries, anchors);
    clampLectureSeriesToPlausibleWeekStart(candidateSeries, minimumWeekStart);
    const score = scoreLectureSeries(candidateSeries, anchors);
    if (score < bestScore) {
      bestScore = score;
      bestSeries = candidateSeries;
    }
  }

  return bestSeries;
}

function reconcileLectureSeriesToAnchors(
  allLectures: LectureDate[],
  anchors: LectureAnchor[],
): void {
  for (const anchor of anchors) {
    const idx = anchor.lectureNumber - 1;
    if (idx < 0 || idx >= allLectures.length) continue;
    const anchorDate = parseISO(`${anchor.dueDate}T12:00:00Z`);
    if (Number.isNaN(anchorDate.getTime())) continue;

    let lectureDate = parseISO(`${allLectures[idx].date}T12:00:00Z`);
    while (differenceInCalendarDays(anchorDate, lectureDate) > 5) {
      for (let i = idx; i < allLectures.length; i++) {
        const shifted = addDays(parseISO(`${allLectures[i].date}T12:00:00Z`), 7);
        allLectures[i].date = shifted.toISOString().slice(0, 10);
        allLectures[i].dayOfWeek = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][shifted.getDay()];
      }
      lectureDate = parseISO(`${allLectures[idx].date}T12:00:00Z`);
    }
  }
}

function scoreLectureSeries(allLectures: LectureDate[], anchors: LectureAnchor[]): number {
  let total = 0;
  for (const anchor of anchors) {
    const idx = anchor.lectureNumber - 1;
    if (idx < 0 || idx >= allLectures.length) {
      total += 100;
      continue;
    }

    const lectureDate = parseISO(`${allLectures[idx].date}T12:00:00Z`);
    const anchorDate = parseISO(`${anchor.dueDate}T12:00:00Z`);
    if (Number.isNaN(lectureDate.getTime()) || Number.isNaN(anchorDate.getTime())) {
      total += 50;
      continue;
    }

    const diff = differenceInCalendarDays(anchorDate, lectureDate);
    total += Math.abs(diff);
    if (diff < -1) total += 25;
    if (diff > 5) total += diff * 2;
  }

  return total;
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
      weekNumber: grouped.length + 1,
      weekLabel,
      startDate: week.startDate,
      topics: allTopics,
      readings: [...new Set(allReadings)], // dedupe
      notes: allNotes.length > 0 ? allNotes.join("; ") : null,
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

  const withBreaks: ParsedTopic[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const current = grouped[i];
    withBreaks.push({ ...current, weekNumber: withBreaks.length + 1 });

    const next = grouped[i + 1];
    if (!current.startDate || !next?.startDate) continue;
    let cursor = addDays(parseISO(`${current.startDate}T12:00:00Z`), 7);
    const nextStart = parseISO(`${next.startDate}T12:00:00Z`);
    while (differenceInCalendarDays(nextStart, cursor) >= 7) {
      withBreaks.push({
        weekNumber: withBreaks.length + 1,
        weekLabel: "No Class / Academic Break",
        startDate: cursor.toISOString().slice(0, 10),
        topics: [],
        readings: [],
        notes: "Inferred no-class week from lecture schedule gap",
        courseName,
      });
      cursor = addDays(cursor, 7);
    }
  }

  console.log(`[pipeline] ${courseName}: Stage 3c produced ${withBreaks.length} grouped weeks from ${matchedCount} matched lectures`);
  return withBreaks;
}

// ─── Stage 4: ENRICH ─────────────────────────────────────────────────────────

interface EnrichInput {
  contentModules: { weekLabel: string; topics: string[]; readings: string[] }[];
  groupedTopics: ParsedTopic[];
  courseName: string;
}

async function enrichTimeline(input: EnrichInput): Promise<ParsedTopic[]> {
  console.log(`[pipeline] ${input.courseName}: Stage 4 enrichTimeline — ${input.groupedTopics.length} weeks, ${input.contentModules.length} modules`);

  if (input.contentModules.length === 0) {
    console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no content modules`);
    return input.groupedTopics;
  }

  const enrichSchema = z.object({ weeks: z.array(parsedTopicSchema) });

  const t0 = Date.now();
  try {
    const { object } = await generateObject({
      ...modelConfig("medium"),
      schema: enrichSchema,
      system: `You enrich a course timeline with additional data from Canvas modules.

You will receive:
1. GROUPED TIMELINE: Pre-grouped weekly topics with dates and per-lecture detail already assigned. This is the PRIMARY source — do not rearrange, regroup, or remove any entries.
2. CANVAS MODULES: Module names and their content items (slides, handouts, worksheets, papers, etc.)

YOUR JOB — ENRICH, never delete:
- Match each Canvas module to the corresponding week(s) in the timeline by topic/unit overlap
- When topic overlap is weak (e.g. seminar courses), match by sequential numbering: "Class 1 Paper" → week 1, "Class 2 Paper(s)" → week 2, etc.
- Module items that are file names (e.g. "prinz_marder_2004.pdf", "Iaccarino et al.pdf") are readings — add them to the readings array and extract a readable title (e.g. "Prinz & Marder (2004)", "Iaccarino et al.")
- If a module mentions content not in any week's topics, ADD it as a new topic entry
- For weeks with empty topics that get matched to a module, derive a meaningful topic from the module content (e.g. "Paper discussion: Prinz & Marder (2004)")
- KEEP all existing topics exactly as they are — do not rename, summarize, or reorder them
- KEEP all existing readings exactly as they are — do not add, remove, or rename them
- KEEP all existing dates, weekNumbers, and weekLabels unchanged

If you cannot match a module to any week, skip it — do not force it.`,
      prompt: JSON.stringify({
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
      abortSignal: AbortSignal.timeout(60_000),
    });

    const enriched = object.weeks as ParsedTopic[];

    // Safety: enriched must have roughly same number of weeks
    if (enriched.length >= input.groupedTopics.length * 0.8 && enriched.length <= input.groupedTopics.length * 1.2) {
      const withReadings = enriched.filter(w => (w.readings ?? []).length > 0).length;
      console.log(`[pipeline] ${input.courseName}: Stage 4 done in ${Date.now() - t0}ms — ${enriched.length} weeks, ${withReadings} with readings`);
      return enriched;
    }
    console.warn(`[pipeline] ${input.courseName}: Stage 4 REJECTED — produced ${enriched.length} weeks vs ${input.groupedTopics.length} input (>20% drift), keeping original`);
    return input.groupedTopics;
  } catch (err) {
    console.warn(`[pipeline] ${input.courseName}: Stage 4 FAILED after ${Date.now() - t0}ms:`, err);
    return input.groupedTopics;
  }
}

const TOKEN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "in", "to", "on", "with",
  "unit", "module", "week", "lecture", "lectures", "chapter", "introduction",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !TOKEN_STOPWORDS.has(w))
  );
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

  const realigned = realignTopicDatesToTerm(topics, termStart, termEnd);
  topics = realigned.topics;
  if (realigned.shiftYears !== 0) {
    warnings.push(`Shifted topic dates by ${realigned.shiftYears} year(s) to align with term ${termStart}..${termEnd ?? "unknown"}`);
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
      dated[i].startDate = null;
    }
  }

  // 3. Check for large gaps (> 21 days) unless this is a sparse schedule.
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
  termStartDate: string | null,
  termEndDate: string | null,
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
    let startDate: string | null = null;
    if (p.lecStart !== null) {
      const calWeek = lectureToWeek.get(p.lecStart);
      if (calWeek) startDate = calWeek.startDate;
    }
    if (!startDate) {
      startDate = inferIsoDateFromText(
        [p.cleanLabel, ...p.module.topics, ...p.module.readings].join(" | "),
        termStartDate,
        termEndDate,
      ) ?? null;
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
      notes: null,
      courseName,
    });
  }

  console.log(`[pipeline] ${courseName}: module fallback organized ${contentModules.length} modules → ${timeline.length} timeline entries`);
  return timeline;
}

function pickPreferredWeekLabel(a: ParsedTopic, b: ParsedTopic): string {
  const score = (topic: ParsedTopic) => {
    let value = hasInstructionalContent(topic) ? 4 : 0;
    if (!isBreakTopic(topic)) value += 2;
    if (topic.weekLabel && !GENERIC_WEEK_LABEL_RX.test(topic.weekLabel)) value += 2;
    value += Math.min(2, (topic.topics?.length ?? 0));
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
    console.log(`[pipeline] ${courseName}: collapsed ${topics.length - normalized.length} duplicate same-date week(s)`);
  }
  return normalized;
}

function computeTimelineQuality(args: {
  topics: ParsedTopic[];
  warnings: string[];
  repairActionsApplied: string[];
  timelineSource: string;
  lectureCalendarSource: string;
  usedModuleScaffold: boolean;
  hasTimelineAuthority: boolean;
}): TimelineQuality {
  const datedTopics = args.topics.filter((topic) => Boolean(topic.startDate));
  const datedRatio = args.topics.length > 0 ? datedTopics.length / args.topics.length : 0;
  const breakCount = args.topics.filter((topic) => isBreakTopic(topic)).length;
  const hasOnlyHtmlBodyAuthority = args.timelineSource === "html-body";
  const warningPenalty = args.warnings.length;
  const repairPenalty = args.repairActionsApplied.filter((action) => action !== "used_module_scaffold").length;

  if (
    args.hasTimelineAuthority &&
    datedRatio >= 0.8 &&
    warningPenalty === 0 &&
    repairPenalty === 0 &&
    !args.usedModuleScaffold &&
    !hasOnlyHtmlBodyAuthority
  ) {
    return "strong";
  }

  if (
    datedRatio >= 0.5 &&
    warningPenalty <= 2 &&
    (args.hasTimelineAuthority || args.lectureCalendarSource === "lecture-anchors" || breakCount > 0)
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
  timelineSource: string;
  lectureCalendarSource: string;
  usedModuleScaffold: boolean;
  hasTimelineAuthority: boolean;
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

  const splitBreakTopics = splitMixedBreakWeeks(finalizedTopics, args.termStartDate, args.termEndDate);
  if (splitBreakTopics.length > finalizedTopics.length) {
    repairActionsApplied.push(`split_mixed_break_weeks:${splitBreakTopics.length - finalizedTopics.length}`);
  }
  finalizedTopics = splitBreakTopics;

  const gapBreakTopics =
    args.lectureCalendarSource === "lecture-anchors"
      ? insertBreakWeeksFromDateGaps(finalizedTopics, args.courseName)
      : finalizedTopics;
  if (gapBreakTopics.length > finalizedTopics.length) {
    repairActionsApplied.push(`inserted_gap_break_weeks:${gapBreakTopics.length - finalizedTopics.length}`);
  }
  finalizedTopics = gapBreakTopics;

  const collapsedTopics = collapseSameStartDateTopics(finalizedTopics, args.courseName);
  if (collapsedTopics.length < finalizedTopics.length) {
    repairActionsApplied.push(`collapsed_duplicate_same_date_weeks:${finalizedTopics.length - collapsedTopics.length}`);
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
    timelineSource: args.timelineSource,
    lectureCalendarSource: args.lectureCalendarSource,
    usedModuleScaffold: args.usedModuleScaffold,
    hasTimelineAuthority: args.hasTimelineAuthority,
  });

  return {
    topics: finalizedTopics,
    warnings: validated.warnings,
    repairActionsApplied,
    timelineQuality,
  };
}

export const timelinePipelineInternals = {
  inferIsoDateFromText,
  buildLectureCalendar,
  organizeModulesAsTimeline,
  finalizeTimelineForPersistence,
};

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function runTopicPipeline(input: PipelineInput): Promise<PipelineResult> {
  const debug: PipelineDebug = {
    stage2Classifications: [],
    stage3Sources: input.candidates.length,
    stage3Weeks: 0,
    moduleContextChars: 0,
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

  const authoritySplit = splitCandidatesByAuthority(input.candidates);
  debug.sourceRoles = authoritySplit.classified.map((src) => ({
    label: src.label,
    role: src.role ?? "timeline",
  }));

  // ── STAGE 3: EXTRACT with source authority split ──
  // Serialize module structure once so the AI sees both syllabus + Canvas modules
  const moduleContext = serializeModulesForExtraction(contentModules);
  debug.moduleContextChars = moduleContext.length;

  if (moduleContext.length > 0) {
    console.log(
      `[pipeline] ${input.courseName}: Stage 3 injecting ${moduleContext.length} chars of module context (${contentModules.length} modules)`,
    );
  }

  const [timelineExtraction, contentExtraction] = await Promise.all([
    extractTopicsExpanded(authoritySplit.timelineCandidates, input.courseName, moduleContext),
    extractTopicsExpanded(authoritySplit.contentCandidates, input.courseName, moduleContext),
  ]);

  debug.timelineSource = timelineExtraction.usedLabel;
  debug.contentSource = contentExtraction.usedLabel;
  const resolvedTimelineAuthority = summarizeAuthorityCandidates(authoritySplit.timelineCandidates, timelineExtraction.usedLabel);
  const resolvedContentAuthority = summarizeAuthorityCandidates(authoritySplit.contentCandidates, contentExtraction.usedLabel);

  const timelineTopics = timelineExtraction.topics.filter(
    (topic) => topic.startDate || isBreakTopic(topic),
  );

  const hasTimelineAuthority = timelineTopics.length > 0;
  let aiTopics =
    timelineTopics.length > 0
      ? mergeContentOntoTimeline(timelineTopics, contentExtraction.topics, input.courseName)
      : contentExtraction.topics.length > 0
        ? contentExtraction.topics
        : timelineExtraction.topics;

  debug.stage3Weeks = aiTopics.length;

  console.log(
    `[pipeline] ${input.courseName}: Stage 3 extracted ${aiTopics.length} entries ` +
    `| timeline=${timelineExtraction.usedLabel}:${timelineExtraction.topics.length}` +
    ` | content=${contentExtraction.usedLabel}:${contentExtraction.topics.length}`,
  );

  // ── STAGE 3b: BUILD LECTURE CALENDAR ──
  const lectureCalendarBuild = buildLectureCalendar(
    input.classSchedule,
    input.classSchedule?.semesterStart ?? input.termStartDate ?? null,
    input.classSchedule?.semesterEnd ?? input.termEndDate ?? null,
    input.assignments,
    input.syllabusEvents ?? [],
  );
  const lectureCalendar = lectureCalendarBuild.weeks;
  debug.lectureCalendarSource = lectureCalendarBuild.source;
  debug.lectureCalendarDates = lectureCalendar.reduce((sum, w) => sum + w.lectures.length, 0);

  if (lectureCalendar.length > 0) {
    console.log(
      `[pipeline] ${input.courseName}: Stage 3b built lecture calendar — ` +
      `${debug.lectureCalendarDates} lectures across ${lectureCalendar.length} weeks (${lectureCalendarBuild.source})`,
    );
  }

  // Use module scaffold ONLY when:
  // - AI extraction has no dated entries (no timeline authority), AND
  // - There's no lecture calendar to assign dates to per-lecture AI topics, AND
  // - We have enough content modules to form a meaningful scaffold
  const shouldUseModuleScaffold =
    !hasTimelineAuthority &&
    lectureCalendar.length === 0 &&
    contentModules.length >= Math.max(4, Math.min(8, aiTopics.length || 4));
  let usedModuleScaffold = false;

  if (shouldUseModuleScaffold) {
    const scaffold = organizeModulesAsTimeline(
      contentModules,
      lectureCalendarBuild.source === "lecture-anchors" ? lectureCalendar : [],
      input.courseName,
      input.termStartDate,
      input.termEndDate,
    );
    if (scaffold.length > 0) {
      aiTopics = mergeContentOntoTimeline(scaffold, aiTopics, input.courseName);
      debug.fallbackUsed = true;
      usedModuleScaffold = true;
      console.log(
        `[pipeline] ${input.courseName}: Stage 3d replaced weak content-only timeline with ${scaffold.length}-entry module scaffold`,
      );
    }
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
    const organizedModules = organizeModulesAsTimeline(
      contentModules,
      lectureCalendar,
      input.courseName,
      input.termStartDate,
      input.termEndDate,
    );
    if (organizedModules.length > 0) {
      finalTopics = organizedModules;
      moduleIdsToDelete = input.modules.map((m) => m.id); // delete all old modules, we're replacing them
      debug.stage4OutputWeeks = organizedModules.length;
      debug.fallbackUsed = true;
      usedModuleScaffold = true;
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
    debug.stage4OutputWeeks = finalTopics.length;
    console.log(`[pipeline] ${input.courseName}: Stage 4 produced ${finalTopics.length} enriched weeks`);
  }

  // ── STAGE 5: FINALIZE + VALIDATE ──
  const finalized = finalizeTimelineForPersistence({
    topics: finalTopics,
    termStartDate: input.termStartDate,
    termEndDate: input.termEndDate,
    courseName: input.courseName,
    timelineSource: debug.timelineSource ?? "none",
    lectureCalendarSource: debug.lectureCalendarSource ?? "none",
    usedModuleScaffold,
    hasTimelineAuthority,
  });
  debug.stage5Warnings = finalized.warnings;

  if (finalized.warnings.length > 0) {
    console.warn(`[pipeline] ${input.courseName}: validation warnings:`, finalized.warnings);
  }

  const spine = buildTimelineSpine({
    topics: finalized.topics,
    hasTimelineAuthority,
    usedModuleScaffold,
    lectureCalendarSource: debug.lectureCalendarSource,
    sourceRefs: debug.sourceRoles ?? [],
  });

  const synthesizedTopics = mergeContentOntoSpine({
    spine,
    topics: finalized.topics,
    timelineSource: debug.timelineSource ?? "none",
    contentSource: debug.contentSource ?? "none",
    lectureCalendarSource: debug.lectureCalendarSource,
    sourceRefs: debug.sourceRoles ?? [],
    usedModuleScaffold,
    validationWarnings: debug.stage5Warnings,
  });

  return {
    topics: synthesizedTopics,
    anchors: spine.anchors,
    timelineMode: spine.scheduleMode,
    materialSourceRoles: debug.sourceRoles ?? [],
    timelineDiagnostics: {
      timelineSource: debug.timelineSource ?? "none",
      contentSource: debug.contentSource ?? "none",
      timelineAuthority: resolvedTimelineAuthority,
      contentAuthority: resolvedContentAuthority,
      timelineAuthorityWinner: resolvedTimelineAuthority.winner,
      timelineAuthorityRunnerUp: resolvedTimelineAuthority.runnerUp,
      contentAuthorityWinner: resolvedContentAuthority.winner,
      contentAuthorityRunnerUp: resolvedContentAuthority.runnerUp,
      lectureCalendarSource: debug.lectureCalendarSource ?? "none",
      usedModuleScaffold,
      stage5Warnings: debug.stage5Warnings,
      repairActionsApplied: finalized.repairActionsApplied,
      timelineQuality: finalized.timelineQuality,
      stage2Classifications: debug.stage2Classifications,
    },
    moduleIdsToDelete,
    debug,
  };
}
