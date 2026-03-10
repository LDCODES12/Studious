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
import { addDays, addYears, differenceInCalendarDays, parseISO, subDays } from "date-fns";
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
  lectureCalendarDates: number;
  stage4OutputWeeks: number;
  stage5Warnings: string[];
  fallbackUsed: boolean;
  sourceRoles?: { label: string; role: CandidateRole }[];
  timelineSource?: string;
  contentSource?: string;
  lectureCalendarSource?: string;
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

const TIMELINE_LABEL_RX = /\b(syllab|schedul|course[\s._-]?(guide|outline|info|overview)|calendar)\b/i;
const CONTENT_LABEL_RX = /\b(lecture|delivered|study\s+outline|review\s+questions|quiz\s+topics?|exam\s+\d|midterm|slides?)\b/i;
const DATE_TOKEN_RX = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi;
const EXPLICIT_SCHEDULE_RX = /\b(schedule|weekly\s+schedule|course\s+schedule|we(?:'?| )ll\s+meet|meeting\s+dates?)\b/i;
const BREAK_RX = /\bspring break|no class|holiday\b/i;
const FULL_BREAK_RX = /\bspring break\b|\bacademic break\b|\bread(?:ing)? days?\b|\bbye week\b|\bholiday\b|\bno classes\b/i;
const PARTIAL_NO_CLASS_RX = /\bno class(?:es)?\s+(?:on|for)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}\/\d{1,2})/i;
const SLIDE_DECK_RX = /\b(on the agenda|learning objectives|discussion questions|delivered|slide|today we(?:'| )ll|what is|who is this)\b/i;
const GENERIC_WEEK_LABEL_RX = /^(lectures?|course resources|report discussions|midterm exam prep materials|review materials|assignment descriptions)$/i;
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
  const FULL_TEXT_THRESHOLD = 40_000;
  const LARGE_WINDOW_SIZE = 30_000;

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
  const notes = topic.notes ?? "";
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
  const lectureMeetings = classSchedule.meetings.filter(
    (m) => m.label.toLowerCase() === "lecture",
  );
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
  contentModules: { weekLabel: string; topics: string[] }[];
  groupedTopics: ParsedTopic[];
  courseName: string;
}

async function enrichTimeline(input: EnrichInput): Promise<ParsedTopic[]> {
  console.log(`[pipeline] ${input.courseName}: Stage 4 enrichTimeline — ${input.groupedTopics.length} weeks, ${input.contentModules.length} modules`);

  if (input.contentModules.length === 0) {
    console.log(`[pipeline] ${input.courseName}: Stage 4 skipped — no content modules`);
    return input.groupedTopics;
  }

  const t0 = Date.now();
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
- If a module mentions content not in any week's topics, ADD it as a new topic entry
- KEEP all existing topics exactly as they are — do not rename, summarize, or reorder them
- KEEP all existing readings exactly as they are — do not add, remove, or rename them
- KEEP all existing dates, weekNumbers, and weekLabels unchanged

OUTPUT: valid JSON only, in the form { "weeks": [...] }
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

// ─── Stage 4b: BACKFILL MODULE READINGS ─────────────────────────────────────
// Deterministic (no-AI) safety net: ensures module readings survive even when
// enrichTimeline fails to incorporate them. Matches modules to AI weeks
// algorithmically and adds any readings that are missing from the output.

const BACKFILL_SKIP_RX = /\b(quiz|exam|test)\s+(blank|key|answer)\b|regrade\s+request|setup\s+instructions|gradescope|\bgetting\s+started\b|\bcourse\s+info(rmation)?\b/i;

const BACKFILL_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "in", "to", "on", "with",
  "unit", "module", "week", "lecture", "lectures", "chapter", "introduction",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !BACKFILL_STOPWORDS.has(w))
  );
}

function backfillModuleReadings(
  enrichedTopics: ParsedTopic[],
  contentModules: CanvasModuleInfo[],
  courseName: string,
): ParsedTopic[] {
  if (enrichedTopics.length === 0 || contentModules.length === 0) {
    return enrichedTopics;
  }

  // 1. Collect all readings already present (lowercase for dedup)
  const existingReadings = new Set<string>();
  for (const week of enrichedTopics) {
    for (const r of week.readings ?? []) {
      existingReadings.add(r.toLowerCase().trim());
    }
  }

  // 2. For each module, find readings not yet present and not junk
  const toPlace: { moduleIdx: number; mod: CanvasModuleInfo; readings: string[] }[] = [];

  for (let i = 0; i < contentModules.length; i++) {
    const mod = contentModules[i];
    const missing = mod.readings.filter(r => {
      if (BACKFILL_SKIP_RX.test(r)) return false;
      if (existingReadings.has(r.toLowerCase().trim())) return false;
      return true;
    });
    if (missing.length > 0) {
      toPlace.push({ moduleIdx: i, mod, readings: missing });
    }
  }

  if (toPlace.length === 0) {
    console.log(`[pipeline] ${courseName}: backfill — all module readings already incorporated`);
    return enrichedTopics;
  }

  // 3. Clone so we don't mutate the input
  const result = enrichedTopics.map(w => ({
    ...w,
    readings: [...(w.readings ?? [])],
  }));

  // 4. Build lookup structures
  const weekNumToIndex = new Map<number, number>();
  for (let i = 0; i < result.length; i++) {
    weekNumToIndex.set(result[i].weekNumber, i);
  }

  const weekKeywords = result.map(w => {
    const allText = [w.weekLabel, ...(w.topics ?? [])].join(" ");
    return tokenize(allText);
  });

  let placedCount = 0;

  // 5. Match each module to a week and add readings
  for (const { moduleIdx, mod, readings } of toPlace) {
    let targetIndex: number | null = null;

    // Strategy A: unit/week/module number match
    const unitMatch = mod.weekLabel.match(/\b(?:unit|module|week)\s*(\d+)/i);
    if (unitMatch) {
      const unitNum = parseInt(unitMatch[1], 10);
      const idx = weekNumToIndex.get(unitNum);
      if (idx !== undefined) targetIndex = idx;
    }

    // Strategy B: keyword overlap
    if (targetIndex === null) {
      const modKeywords = tokenize(mod.weekLabel + " " + mod.topics.join(" "));
      if (modKeywords.size > 0) {
        let bestOverlap = 0;
        let bestIdx = -1;
        for (let wi = 0; wi < result.length; wi++) {
          let overlap = 0;
          for (const kw of modKeywords) {
            if (weekKeywords[wi].has(kw)) overlap++;
          }
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestIdx = wi;
          }
        }
        if (bestOverlap >= 1) targetIndex = bestIdx;
      }
    }

    // Strategy C: proportional positional fallback
    if (targetIndex === null) {
      const N = contentModules.length;
      const W = result.length;
      targetIndex = N === 1 ? 0 : Math.round(moduleIdx * (W - 1) / (N - 1));
    }

    for (const r of readings) {
      result[targetIndex].readings.push(r);
    }
    placedCount += readings.length;
  }

  console.log(
    `[pipeline] ${courseName}: backfill placed ${placedCount} readings ` +
    `from ${toPlace.length} modules into ${result.length} weeks`
  );

  return result;
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
      dated[i].startDate = undefined;
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
    let startDate: string | undefined;
    if (p.lecStart !== null) {
      const calWeek = lectureToWeek.get(p.lecStart);
      if (calWeek) startDate = calWeek.startDate;
    }
    if (!startDate) {
      startDate = inferIsoDateFromText(
        [p.cleanLabel, ...p.module.topics, ...p.module.readings].join(" | "),
        termStartDate,
        termEndDate,
      );
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

function mergeNotes(a?: string | null, b?: string | null): string | undefined {
  const notes = [...new Set([a, b].filter((note): note is string => Boolean(note && note.trim())))];
  return notes.length > 0 ? notes.join("; ") : undefined;
}

function collapseSameStartDateTopics(topics: ParsedTopic[], courseName: string): ParsedTopic[] {
  if (topics.length < 2) return topics;

  const collapsed: ParsedTopic[] = [];
  for (const topic of topics) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.startDate && topic.startDate && previous.startDate === topic.startDate) {
      const merged: ParsedTopic = {
        ...previous,
        weekLabel: pickPreferredWeekLabel(previous, topic),
        topics: mergeTopicLists(previous.topics, topic.topics),
        readings: mergeTopicLists(previous.readings, topic.readings),
        notes: mergeNotes(previous.notes, topic.notes),
        courseName: topic.courseName ?? previous.courseName,
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

  const authoritySplit = splitCandidatesByAuthority(input.candidates);
  debug.sourceRoles = authoritySplit.classified.map((src) => ({
    label: src.label,
    role: src.role ?? "timeline",
  }));

  // ── STAGE 3: EXTRACT with source authority split ──
  const [timelineExtraction, contentExtraction] = await Promise.all([
    extractTopicsExpanded(authoritySplit.timelineCandidates, input.courseName),
    extractTopicsExpanded(authoritySplit.contentCandidates, input.courseName),
  ]);

  debug.timelineSource = timelineExtraction.usedLabel;
  debug.contentSource = contentExtraction.usedLabel;

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

  const shouldUseModuleScaffold =
    !hasTimelineAuthority &&
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
      })),
      groupedTopics: aiTopics,
      courseName: input.courseName,
    });

    finalTopics = enriched;
    moduleIdsToDelete = input.modules.map((m) => m.id);
    debug.stage4OutputWeeks = finalTopics.length;
    console.log(`[pipeline] ${input.courseName}: Stage 4 produced ${finalTopics.length} enriched weeks`);
  }

  // ── STAGE 5: VALIDATE ──
  const collapsedTopics = collapseSameStartDateTopics(finalTopics, input.courseName);
  const validated = validateTimeline(collapsedTopics, input.termStartDate, input.termEndDate);
  debug.stage5Warnings = validated.warnings;

  if (validated.warnings.length > 0) {
    console.warn(`[pipeline] ${input.courseName}: validation warnings:`, validated.warnings);
  }

  const spine = buildTimelineSpine({
    topics: validated.topics,
    hasTimelineAuthority,
    usedModuleScaffold,
    lectureCalendarSource: debug.lectureCalendarSource,
    sourceRefs: debug.sourceRoles ?? [],
  });

  const synthesizedTopics = mergeContentOntoSpine({
    spine,
    topics: validated.topics,
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
      lectureCalendarSource: debug.lectureCalendarSource ?? "none",
      usedModuleScaffold,
      stage5Warnings: debug.stage5Warnings,
      stage2Classifications: debug.stage2Classifications,
    },
    moduleIdsToDelete,
    debug,
  };
}
