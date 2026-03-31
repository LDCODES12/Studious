/**
 * Topic Pipeline v2 — SEGMENT → EXTRACT → RECONCILE → COMMIT
 *
 * The professor already solved the alignment problem in the syllabus.
 * The system's job is to read what's there, verify it against Canvas
 * ground truth, and be honest about what it couldn't determine.
 *
 * Steps:
 *   1. SEGMENT   — classify Canvas modules, prepare candidates
 *   2. EXTRACT   — AI extracts topics/readings from syllabus (single-pass per block)
 *   3. RECONCILE — deterministic: verify extracted dates against Canvas assignments
 *   4. COMMIT    — normalize modules, fuse, finalize, synthesize with verification states
 */

import { generateObject } from "ai";
import { modelConfig } from "./ai-models.ts";
import { z } from "zod";
import { addDays, addYears, differenceInCalendarDays, parseISO, startOfWeek, subDays } from "date-fns";
import {
  parseSyllabusSchedule,
  sanitizeSchedule,
  renumberSequentialWeeks,
  needsAudit,
  auditSchedule,
  bestWindow,
  detectSourceFormat,
  isContentfulTopic,
  type ParsedTopic,
  type ParsedSchedule,
  type RowSemantics,
  type ScheduleShape,
} from "./parse-syllabus.ts";
import {
  reconcileAgainstCanvas,
  type ReconciledTopic,
  type VerificationStatus,
  type ReconciliationDiagnostics,
} from "./reconcile-canvas.ts";

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
  | "syllabus_verified"
  | "syllabus_corroborated"
  | "syllabus_unverified"
  | "canvas_only"
  | "break"
  | "conflicted";

export interface TimelineAnchorRecord {
  sequenceNumber: number;
  anchorDate: string | null;
  anchorType: TimelineAnchorType;
  isInstructional: boolean;
  calendarConfidence: ConfidenceLevel;
  sourceRefs: Record<string, unknown>;
  notes?: string | null;
}

export interface SynthesizedTopic extends ParsedTopic {
  dateConfidence: ConfidenceLevel;
  contentConfidence: ConfidenceLevel;
  scheduleMode: ScheduleMode;
  provenance: Record<string, unknown>;
  verificationStatus: VerificationStatus;
  sourceBlock: string;
}

export interface PipelineResult {
  topics: SynthesizedTopic[];
  anchors: TimelineAnchorRecord[];
  timelineMode: ScheduleMode;
  timelineDiagnostics: Record<string, unknown>;
  moduleIdsToDelete: string[];
  debug: PipelineDebug;
}

export interface PipelineDebug {
  stage1Classifications: { name: string; category: string }[];
  stage2Sources: number;
  stage2Weeks: number;
  stage3Reconciliation: ReconciliationDiagnostics;
  stage4OutputWeeks: number;
  stage4Warnings: string[];
  fallbackUsed: boolean;
  extractedScheduleShape?: ScheduleShape;
  extractedRowSemantics?: RowSemantics;
}

export interface FinalizeTimelineResult {
  topics: ParsedTopic[];
  warnings: string[];
  repairActionsApplied: string[];
  timelineQuality: TimelineQuality;
}

// ─── Shared Helpers ─────────────────────────────────────────────────────────

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

// ─── Step 1: SEGMENT — Classify Canvas Modules ─────────────────────────────

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

// ─── Regex Constants ────────────────────────────────────────────────────────

const FULL_BREAK_RX = /\bspring break\b|\bacademic break\b|\bread(?:ing)? days?\b|\bbye week\b|\bholiday\b|\bno classes\b/i;
const PARTIAL_NO_CLASS_RX = /\bno class(?:es)?\s+(?:on|for)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}\/\d{1,2})/i;
const GENERIC_WEEK_LABEL_RX = /^(lectures?|course resources|report discussions|midterm exam prep materials|review materials|assignment descriptions)$/i;
const ASSIGNMENT_FALLBACK_LABEL_RX = /^assignments?(?:\s+due)?\s+week\s+of\s+\d{4}-\d{2}-\d{2}$/i;
const ADMIN_ENTRY_RX = /^(syllabus|course schedule|office hours?|course information|course resources|exam resources)$/i;
const BREAK_SEGMENT_RX = /\bspring break\b|\bacademic break\b|\bread(?:ing)? days?\b|\bbye week\b|\bholiday\b|\bno classes?\b|\bno lecture\b|\bno lab\b/i;
const GENERIC_MEETING_LABEL_RX = /^(?:class meeting|meeting|seminar session|session)\s+\d+$/i;
const DATE_ONLY_PLACEHOLDER_NOTE_RX = /no topics listed.*class meeting date/i;

// ─── Break & Content Helpers ────────────────────────────────────────────────

function hasInstructionalContent(topic: ParsedTopic): boolean {
  return (topic.topics?.length ?? 0) > 0 || (topic.readings?.length ?? 0) > 0;
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

function isAdministrativeEntry(entry: string): boolean {
  return ADMIN_ENTRY_RX.test(entry.trim());
}

function isAdministrativeOnlyTopic(topic: ParsedTopic): boolean {
  const entries = [...(topic.topics ?? []), ...(topic.readings ?? [])].map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 && entries.every(isAdministrativeEntry);
}

function isAssignmentFallbackLabel(label?: string | null): boolean {
  return Boolean(label && ASSIGNMENT_FALLBACK_LABEL_RX.test(label.trim()));
}

function cleanModuleWeekLabel(label: string): string {
  let cleanLabel = label
    .replace(/\s*-\s*(quiz\s+on\s+\S+|no\s+quiz|exam\s+on\s+\S+)/i, "")
    .replace(/\s*\(lectures?\s*\d+\s*[-–]\s*\d+\)/i, "")
    .trim();

  const unitMatch = cleanLabel.match(/\b(?:unit|module|week)\s*(\d+)/i);
  if (/^unit\s+\d+$/i.test(cleanLabel) && unitMatch) {
    cleanLabel = `Unit ${unitMatch[1]}`;
  }

  return cleanLabel;
}

function extractModuleSequenceNumber(label: string): number | null {
  const match = label.match(/\b(?:class|meeting|session|week|lecture|unit|module)\s*(\d+)\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanModuleReadingTitle(title: string): string {
  let cleaned = title
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const yearMatch = cleaned.match(/^(.*?)[,\s-]+((?:19|20)\d{2})$/);
  if (yearMatch) {
    cleaned = `${yearMatch[1].trim()} (${yearMatch[2]})`;
  }

  cleaned = cleaned
    .split(/\s+/)
    .map((token) => {
      if (/^\(\d{4}\)$/.test(token)) return token;
      if (/^et$/i.test(token)) return "et";
      if (/^al\.?$/i.test(token)) return "al.";
      if (/^[a-z][a-z'-]+$/i.test(token) && token === token.toLowerCase()) {
        return token[0].toUpperCase() + token.slice(1);
      }
      return token;
    })
    .join(" ")
    .replace(/\s+-\s+/g, " - ")
    .trim();

  return cleaned;
}

function buildDeterministicSparseModuleResult(
  modules: CanvasModuleInfo[],
  spine: { weekNumber: number; weekLabel: string; startDate: string | null; topics: string[]; readings: string[] }[],
): NormalizerResult {
  const genericWeeks = new Set(
    spine
      .filter((week) =>
        GENERIC_MEETING_LABEL_RX.test(week.weekLabel.trim()) &&
        (week.topics?.length ?? 0) === 0 &&
        (week.readings?.length ?? 0) === 0,
      )
      .map((week) => week.weekNumber),
  );

  if (genericWeeks.size === 0) {
    return { deltas: [], coveredWeeks: [], weekLabelHints: [] };
  }

  const deltas: ModuleDelta[] = [];
  const coveredWeeks = new Set<number>();
  const weekLabelHints = new Map<number, WeekLabelHint>();

  for (const module of modules) {
    const targetWeek = extractModuleSequenceNumber(module.weekLabel) ?? (
      genericWeeks.has(module.weekNumber) ? module.weekNumber : null
    );
    if (!targetWeek || !genericWeeks.has(targetWeek)) continue;

    const addTopics = [...new Set(
      (module.topics ?? [])
        .map((topic) => topic.trim())
        .filter(Boolean)
        .filter((topic) => !isAdministrativeEntry(topic)),
    )];
    const addReadings = [...new Set(
      (module.readings ?? [])
        .map(cleanModuleReadingTitle)
        .map((reading) => reading.trim())
        .filter(Boolean),
    )];

    if (addTopics.length > 0 || addReadings.length > 0) {
      deltas.push({
        weekNumber: targetWeek,
        addTopics,
        addReadings,
        sourceModule: module.weekLabel,
      });
    }
    coveredWeeks.add(targetWeek);

    const weekLabel = addReadings.length === 1
      ? addReadings[0]
      : null;
    if (weekLabel) {
      weekLabelHints.set(targetWeek, {
        weekNumber: targetWeek,
        weekLabel,
        sourceModule: module.weekLabel,
      });
    }
  }

  return {
    deltas,
    coveredWeeks: [...coveredWeeks].sort((a, b) => a - b),
    weekLabelHints: [...weekLabelHints.values()].sort((a, b) => a.weekNumber - b.weekNumber),
  };
}

function formatLectureRange(lectureNumbers: number[]): string | null {
  if (lectureNumbers.length === 0) return null;
  const ordered = [...new Set(lectureNumbers)].sort((a, b) => a - b);
  return ordered.length === 1
    ? `Lecture ${ordered[0]}`
    : `Lectures ${ordered[0]}-${ordered[ordered.length - 1]}`;
}

function summarizeAssignmentFallbackWeek(rawTitles: string[]): {
  weekLabelHint: string | null;
  topicHints: string[];
} {
  const units = new Set<string>();
  const lectureNumbers: number[] = [];
  const topicHints: string[] = [];
  const seen = new Set<string>();

  function pushHint(value: string) {
    const normalized = normalizeForDedup(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    topicHints.push(value);
  }

  for (const rawTitle of rawTitles) {
    const title = rawTitle.trim();
    if (!title) continue;

    const isPracticeQuiz = /\bpractice quiz\b/i.test(title);
    const unitMatch = title.match(/\bunit\s+(\d+[a-z]?)/i);
    if (unitMatch) {
      const unitNumber = unitMatch[1].replace(/[a-z]$/i, "").toUpperCase();
      if (!(unitNumber === "0" && isPracticeQuiz)) {
        units.add(`Unit ${unitNumber}`);
      }
    }

    const lectureMatch = title.match(/lecture\s+review\s+questions?\s*-\s*lecture\s*#?\s*(\d+)/i);
    if (lectureMatch) {
      lectureNumbers.push(Number.parseInt(lectureMatch[1], 10));
      continue;
    }

    const examMatch = title.match(/\bexam\s+(\d+)\b/i);
    if (examMatch) {
      pushHint(`Exam ${examMatch[1]}`);
      continue;
    }

    if (/\bfinal exam\b/i.test(title)) {
      pushHint("Final exam");
      continue;
    }

    if (/\bmidterm\b/i.test(title)) {
      pushHint("Midterm");
      continue;
    }

    if (/\bsyllabus quiz\b/i.test(title)) {
      pushHint("Syllabus quiz");
      continue;
    }

    if (/\bpractice quiz\b/i.test(title)) {
      pushHint("Practice quiz");
      continue;
    }
  }

  if (units.size === 1) {
    pushHint([...units][0]!);
  }

  const lectureRange = formatLectureRange(lectureNumbers);
  if (lectureRange) {
    pushHint(`${lectureRange} review`);
  }

  let weekLabelHint: string | null = null;
  const primaryUnit = units.size === 1 ? [...units][0]! : null;
  const primaryAssessment = topicHints.find((hint) => /^exam\b|^final exam$|^midterm$/i.test(hint))
    ?? topicHints.find((hint) => /quiz/i.test(hint))
    ?? null;

  if (primaryUnit && lectureRange) {
    weekLabelHint = `${primaryUnit}: ${lectureRange}`;
  } else if (primaryAssessment && primaryUnit && !/syllabus quiz|practice quiz/i.test(primaryAssessment)) {
    weekLabelHint = `${primaryUnit} + ${primaryAssessment}`;
  } else if (primaryUnit) {
    weekLabelHint = `${primaryUnit} deadlines`;
  } else if (lectureRange) {
    weekLabelHint = `${lectureRange} deadlines`;
  } else if (primaryAssessment) {
    weekLabelHint = primaryAssessment;
  }

  return {
    weekLabelHint,
    topicHints: topicHints.slice(0, 3),
  };
}

interface OutlineFallbackHint {
  weekNumber: number;
  weekLabel: string | null;
  topicHints: string[];
}

function extractLectureNumbersFromAssignmentTitles(rawTitles: string[]): number[] {
  const numbers = new Set<number>();

  for (const rawTitle of rawTitles) {
    for (const match of rawTitle.matchAll(/lecture\s+review\s+questions?\s*-\s*lecture\s*#?\s*(\d+)/gi)) {
      const lectureNumber = Number.parseInt(match[1] ?? "", 10);
      if (Number.isFinite(lectureNumber) && lectureNumber > 0) {
        numbers.add(lectureNumber);
      }
    }
  }

  return [...numbers].sort((a, b) => a - b);
}

function sanitizeOutlineSectionTitle(rawTitle: string | null | undefined): string | null {
  const normalized = (rawTitle ?? "").trim();
  if (!normalized) return null;

  const trailingTitleMatch = normalized.match(
    /([A-Z][A-Za-z0-9&'()\-–]+(?:\s+(?:[A-Z][A-Za-z0-9&'()\-–]+|of|and|the|for|to|in|on|Base)){0,7})$/,
  );
  const candidate = (trailingTitleMatch?.[1] ?? normalized).trim();

  return /^[A-Z][A-Za-z0-9&'()\-–]+(?:\s+(?:[A-Z][A-Za-z0-9&'()\-–]+|of|and|the|for|to|in|on|Base)){0,7}$/.test(candidate)
    ? candidate
    : null;
}

function stripLeadingOutlinePrefix(sectionTitle: string, prefix: string): string | null {
  const normalizedPrefix = normalizeForDedup(prefix);
  const normalizedTitle = normalizeForDedup(sectionTitle);
  if (!normalizedPrefix || !normalizedTitle.startsWith(normalizedPrefix)) return null;

  const titleWords = sectionTitle.trim().split(/\s+/);
  const prefixWords = prefix.trim().split(/\s+/);
  if (titleWords.length <= prefixWords.length) return null;

  return sanitizeOutlineSectionTitle(titleWords.slice(prefixWords.length).join(" "));
}

function getOutlineSectionTitle(topic: ParsedTopic): string | null {
  const noteMatch = typeof topic.notes === "string"
    ? topic.notes.match(/^outline section:\s*(.+)$/i)
    : null;
  if (noteMatch?.[1]) {
    return sanitizeOutlineSectionTitle(noteMatch[1]);
  }

  return null;
}

function getOutlineLectureHint(topic: ParsedTopic): string | null {
  const sectionTitle = getOutlineSectionTitle(topic);
  const sectionKey = normalizeForDedup(sectionTitle ?? "");

  for (const entry of topic.topics ?? []) {
    if (normalizeForDedup(entry) !== sectionKey) {
      return entry;
    }
  }

  return topic.weekLabel?.trim() || null;
}

function buildOutlineFallbackHints(
  outlineTopics: ParsedTopic[],
  assignmentFallbackTopics: ParsedTopic[],
): OutlineFallbackHint[] {
  if (outlineTopics.length === 0 || assignmentFallbackTopics.length === 0) return [];

  const outlineByLecture = new Map<number, ParsedTopic>();
  for (const topic of outlineTopics) {
    outlineByLecture.set(topic.weekNumber, topic);
  }

  return assignmentFallbackTopics.flatMap((fallbackWeek) => {
    const lectureNumbers = extractLectureNumbersFromAssignmentTitles(fallbackWeek.topics ?? []);
    if (lectureNumbers.length === 0) return [];

    const matchedTopics = lectureNumbers
      .map((lectureNumber) => outlineByLecture.get(lectureNumber))
      .filter((topic): topic is ParsedTopic => Boolean(topic));
    if (matchedTopics.length === 0) return [];

    const seen = new Set<string>();
    const topicHints: string[] = [];
    const sectionTitles: string[] = [];
    const lectureTopicHints: string[] = [];
    const previousLectureTopic = outlineByLecture.get(Math.min(...lectureNumbers) - 1);
    const previousLectureHint = previousLectureTopic
      ? getOutlineLectureHint(previousLectureTopic) ?? previousLectureTopic.weekLabel ?? ""
      : "";
    const previousLecturePrefix = normalizeForDedup(previousLectureHint).split(" ")[0] ?? "";

    const pushHint = (value: string | null | undefined) => {
      const normalized = normalizeForDedup(value ?? "");
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      topicHints.push((value ?? "").trim());
    };

    for (const matchedTopic of matchedTopics) {
      const sectionTitle = getOutlineSectionTitle(matchedTopic);
      if (sectionTitle) {
        sectionTitles.push(sectionTitle);
      }
      const lectureHint = getOutlineLectureHint(matchedTopic);
      if (lectureHint) {
        lectureTopicHints.push(lectureHint);
      }
    }

    const normalizedSectionTitles = sectionTitles
      .map((sectionTitle) => {
        const normalized = normalizeForDedup(sectionTitle);
        if (!normalized) return null;
        if (previousLecturePrefix && normalized.startsWith(previousLecturePrefix)) {
          return stripLeadingOutlinePrefix(sectionTitle, previousLectureHint);
        }
        return sectionTitle;
      })
      .filter((sectionTitle): sectionTitle is string => Boolean(sectionTitle));
    const sectionTitleCounts = new Map<string, number>();
    for (const sectionTitle of normalizedSectionTitles) {
      sectionTitleCounts.set(sectionTitle, (sectionTitleCounts.get(sectionTitle) ?? 0) + 1);
    }
    const rankedSectionTitles = [...sectionTitleCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    let uniqueSectionTitles: string[];
    if (rankedSectionTitles.length > 1 && (rankedSectionTitles[0]?.[1] ?? 0) >= 2 && (rankedSectionTitles[0]?.[1] ?? 0) > (rankedSectionTitles[1]?.[1] ?? 0)) {
      uniqueSectionTitles = [rankedSectionTitles[0]![0]];
    } else {
      uniqueSectionTitles = [...new Set(normalizedSectionTitles)];
    }
    for (const sectionTitle of uniqueSectionTitles) {
      pushHint(sectionTitle);
    }
    for (const lectureHint of lectureTopicHints) {
      pushHint(lectureHint);
    }
    const lectureRange = formatLectureRange(lectureNumbers);
    const weekLabel = uniqueSectionTitles.length === 1 && lectureRange
      ? `${uniqueSectionTitles[0]}: ${lectureRange}`
      : uniqueSectionTitles.length === 1
        ? uniqueSectionTitles[0]!
        : lectureRange;

    return [{
      weekNumber: fallbackWeek.weekNumber,
      weekLabel,
      topicHints: topicHints.slice(0, 4),
    }];
  });
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

// ─── Step 2: EXTRACT (single-pass per block) ───────────────────────────────

interface ExtractionResult {
  topics: ParsedTopic[];
  usedLabel: string;
  usedWindow: string;
  scheduleShape: ScheduleShape;
  rowSemantics: RowSemantics;
  hasExplicitDates: boolean;
  hasExplicitBreakRows: boolean;
}

function isCanonicalTimelineExtraction(extraction: ExtractionResult): boolean {
  if (extraction.scheduleShape === "none") return false;

  // A lecture-by-lecture outline without explicit dates is useful content,
  // but it is not a canonical week timeline. Per the redesign, we fail
  // closed here and let assignment-based fallback provide dated structure.
  if (extraction.rowSemantics === "lecture_number" && !extraction.hasExplicitDates) {
    return false;
  }

  return true;
}

/**
 * Extracts topics from all syllabus candidates. Single-pass per block —
 * no timeline/content role split. Iterates candidates, picks best result,
 * merges complementary sources by weekNumber.
 */
async function extractFromBlocks(
  candidates: ScoredSource[],
  courseName: string,
): Promise<ExtractionResult> {
  const FULL_TEXT_THRESHOLD = 40_000;
  const LARGE_WINDOW_SIZE = 30_000;

  const allGoodResults: Array<{
    result: ParsedTopic[];
    label: string;
    fmt: string;
    win: string;
    parsedSchedule: ParsedSchedule;
  }> = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const src = candidates[ci];

    const win = src.text.length <= FULL_TEXT_THRESHOLD
      ? src.text
      : bestWindow(src.text, LARGE_WINDOW_SIZE);

    const fmt = detectSourceFormat(src.text);
    const hint = `${src.label}, format: ${fmt}`;
    const parsedSchedule = await parseSyllabusSchedule(win, hint, "high");
    const result = sanitizeSchedule(parsedSchedule.weeks).filter(isContentfulTopic);

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
      allGoodResults.push({ result, label: src.label, fmt, win, parsedSchedule });
    }
  }

  if (allGoodResults.length === 0) {
    return {
      topics: [], usedLabel: "none", usedWindow: "",
      scheduleShape: "none", rowSemantics: "unknown",
      hasExplicitDates: false, hasExplicitBreakRows: false,
    };
  }

  // Merge: start with highest-coverage source, fill gaps from others
  allGoodResults.sort((a, b) => b.result.length - a.result.length);
  const merged = new Map<number, ParsedTopic>();
  const sourceLabels: string[] = [];
  let usedWindow = allGoodResults[0].win;
  const mergedScheduleShape = allGoodResults[0].parsedSchedule.shape;
  const mergedRowSemantics = allGoodResults[0].parsedSchedule.rowSemantics;
  const mergedHasExplicitDates = allGoodResults.some((item) => item.parsedSchedule.hasExplicitDates);
  const mergedHasExplicitBreakRows = allGoodResults.some((item) => item.parsedSchedule.hasExplicitBreakRows);

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

  // Audit pass — fires when result looks partial/messy
  if (needsAudit(topics)) {
    const audited = await auditSchedule(topics, usedWindow, mergedRowSemantics);
    if (audited.length > 0) {
      topics = audited;
    }
  }

  // Normalize week numbers to sequential 1..N
  topics = renumberSequentialWeeks(topics);

  return {
    topics, usedLabel, usedWindow,
    scheduleShape: mergedScheduleShape,
    rowSemantics: mergedRowSemantics,
    hasExplicitDates: mergedHasExplicitDates,
    hasExplicitBreakRows: mergedHasExplicitBreakRows,
  };
}

// ─── Module-Only Fallback ───────────────────────────────────────────────────

/**
 * If the syllabus has no usable schedule, fall back to an honest assignment
 * timeline built from Canvas due dates. This is explicitly not a lecture plan.
 */
function organizeAssignmentsAsTimeline(
  assignments: AssignmentDateInfo[],
  courseName: string,
): ParsedTopic[] {
  const datedAssignments = assignments
    .filter((assignment): assignment is AssignmentDateInfo & { dueDate: string } =>
      typeof assignment.dueDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(assignment.dueDate),
    )
    .map((assignment) => ({
      title: assignment.title,
      dueDate: assignment.dueDate.slice(0, 10),
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));

  if (datedAssignments.length === 0) return [];

  const grouped = new Map<string, string[]>();
  for (const assignment of datedAssignments) {
    const parsed = parseISO(`${assignment.dueDate}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime())) continue;
    const monday = startOfWeek(parsed, { weekStartsOn: 1 }).toISOString().slice(0, 10);
    const titles = grouped.get(monday) ?? [];
    if (!titles.includes(assignment.title)) {
      titles.push(assignment.title);
    }
    grouped.set(monday, titles);
  }

  const timeline = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monday, titles], index) => ({
      weekNumber: index + 1,
      weekLabel: `Assignments due week of ${monday}`,
      startDate: monday,
      topics: titles,
      readings: [],
      notes: "Generated from Canvas assignment due dates",
      courseName,
    }));

  console.log(
    `[pipeline] ${courseName}: assignment fallback organized ${datedAssignments.length} assignments → ${timeline.length} weekly entries`,
  );
  return timeline;
}

/**
 * When AI extraction fails but we have content modules, build a timeline
 * from module labels. Modules provide structure but are explicitly labeled
 * as canvas_modules source — never presented as a "Course Schedule".
 */
function organizeModulesAsTimeline(
  contentModules: CanvasModuleInfo[],
  courseName: string,
  termStartDate: string | null,
  termEndDate: string | null,
): ParsedTopic[] {
  if (contentModules.length === 0) return [];

  const parsed = contentModules.map((m) => {
    const label = m.weekLabel;
    const unitMatch = label.match(/\b(?:unit|module|week)\s*(\d+)/i);
    const unitNum = unitMatch ? parseInt(unitMatch[1], 10) : null;
    const lecMatch = label.match(/lectures?\s*(\d+)\s*[-–]\s*(\d+)/i);
    const lecStart = lecMatch ? parseInt(lecMatch[1], 10) : null;
    const lecEnd = lecMatch ? parseInt(lecMatch[2], 10) : null;

    const cleanLabel = cleanModuleWeekLabel(label);

    return { module: m, unitNum, lecStart, lecEnd, cleanLabel };
  });

  parsed.sort((a, b) => {
    if (a.unitNum !== null && b.unitNum !== null) return a.unitNum - b.unitNum;
    if (a.unitNum !== null) return -1;
    if (b.unitNum !== null) return 1;
    if (a.lecStart !== null && b.lecStart !== null) return a.lecStart - b.lecStart;
    return 0;
  });

  const ASSIGNED_READING_RX = /reading|chapter|paper|article|\.pdf$|et\s+al|journal|\(\d{4}\)/i;
  const SKIP_READING_RX = /\b(quiz|exam)\s+(blank|key)\b|regrade\s+request|setup\s+instructions|gradescope|slide|powerpoint|worksheet|problem\s+set|packet|handout|video/i;
  const SKIP_TOPIC_RX = /^(assignments?|homework|quiz\s+information|quiz\s+and\s+exam|suggested\s+readings?|lecture\s+powerpoint|section\s+\d|quiz\s+policies|exam\s+room)/i;

  const timeline: ParsedTopic[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const usefulTopics = p.module.topics.filter((t) => !SKIP_TOPIC_RX.test(t));
    const usefulReadings = p.module.readings.filter(
      (r) => ASSIGNED_READING_RX.test(r) && !SKIP_READING_RX.test(r),
    );

    // Try to infer date from module text (limited — no fabricated calendar)
    const startDate = inferIsoDateFromText(
      [p.cleanLabel, ...p.module.topics, ...p.module.readings].join(" | "),
      termStartDate,
      termEndDate,
    ) ?? null;

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

// ─── Module Normalizer ──────────────────────────────────────────────────────

interface ModuleDelta {
  weekNumber: number;
  addTopics: string[];
  addReadings: string[];
  sourceModule: string;
}

interface WeekLabelHint {
  weekNumber: number;
  weekLabel: string;
  sourceModule: string;
}

interface NormalizerResult {
  deltas: ModuleDelta[];
  coveredWeeks: number[];
  weekLabelHints: WeekLabelHint[];
}

const moduleDeltaSchema = z.object({
  deltas: z.array(z.object({
    weekNumber: z.number(),
    addTopics: z.array(z.string()),
    addReadings: z.array(z.string()),
    sourceModule: z.string(),
  })),
  coveredWeeks: z.array(z.number()),
  weekLabelHints: z.array(z.object({
    weekNumber: z.number(),
    weekLabel: z.string(),
    sourceModule: z.string(),
  })).default([]),
});

async function normalizeModules(
  modules: CanvasModuleInfo[],
  spine: { weekNumber: number; weekLabel: string; startDate: string | null; topics: string[]; readings: string[] }[],
  courseName: string,
): Promise<NormalizerResult> {
  if (modules.length === 0 || spine.length === 0) {
    return { deltas: [], coveredWeeks: [], weekLabelHints: [] };
  }

  const deterministicSparse = buildDeterministicSparseModuleResult(modules, spine);
  if (deterministicSparse.coveredWeeks.length > 0) {
    console.log(
      `[pipeline] ${courseName}: normalizeModules used deterministic sparse mapping — ` +
      `${deterministicSparse.deltas.length} deltas, ${deterministicSparse.coveredWeeks.length} covered`,
    );
    return deterministicSparse;
  }

  const t0 = Date.now();
  try {
    const { object } = await generateObject({
      ...modelConfig("medium"),
      schema: moduleDeltaSchema,
      system: `You normalize Canvas module content into typed additions for a course timeline.

You receive:
1. SPINE: The weekly structure with weekNumber, weekLabel, startDate, and existing topics/readings already extracted from the syllabus
2. MODULES: Canvas module names with their content items (topics and readings arrays)

For each module:
- Match it to the best spine week by comparing module content against the week's existing topics, readings, and weekLabel. Use topic/subject overlap as the primary signal, sequential position as a tiebreaker (e.g. "Class 1 Paper" → week 1, "Unit 3" → week with matching topic)
- Classify each item in the module:
  - topic: actual subject matter, lecture themes, discussion topics → addTopics
  - assigned_reading: papers, textbook chapters, articles, author names → addReadings
  - resource: slides, problem sets, handouts, worksheets, videos, PowerPoints → SKIP
  - assessment: quiz blanks, exam keys, answer sheets, homework submissions → SKIP
- Extract readable titles from filenames (e.g. "prinz_marder_2004.pdf" → "Prinz & Marder (2004)")
- Only output items classified as topic or assigned_reading
- Do NOT output items that are already present in a week's existing topics or readings
- If a module cannot be confidently matched to any week, skip it entirely

Also return coveredWeeks: a list of ALL spine weekNumbers where you matched at least one module, even if you classified all items as resource/assessment and added nothing to addTopics/addReadings. This distinguishes "no modules matched this week" from "modules matched but nothing was worth adding."

Also return weekLabelHints when helpful:
- If a matched module gives a cleaner student-facing summary for a week than the current spine weekLabel, emit a short replacement label for that week
- This is especially useful when the spine weekLabel is generic or assignment-based, such as "Assignments due week of 2026-03-30"
- Base the label on the module name and module content only. Keep it concise and grounded, like "Unit 9", "Buffers", or "Unit 9: Buffers"
- Do NOT copy raw assignment titles into weekLabelHints
- Do NOT emit a label hint unless the module evidence is strong and specific`,
      prompt: JSON.stringify({
        spine: spine.map((w) => ({
          weekNumber: w.weekNumber,
          weekLabel: w.weekLabel,
          startDate: w.startDate,
          topics: w.topics,
          readings: w.readings,
        })),
        modules: modules.map((m) => ({
          name: m.weekLabel,
          topics: m.topics,
          readings: m.readings,
        })),
      }),
      abortSignal: AbortSignal.timeout(45_000),
    });

    const deltas = object.deltas as ModuleDelta[];
    const validWeeks = new Set(spine.map((w) => w.weekNumber));
    const valid = deltas.filter((d) => validWeeks.has(d.weekNumber));
    const validCovered = [...new Set(object.coveredWeeks ?? [])].filter((w) => validWeeks.has(w));
    const validWeekLabelHints = (object.weekLabelHints ?? [])
      .filter((hint) => validWeeks.has(hint.weekNumber))
      .map((hint) => ({
        weekNumber: hint.weekNumber,
        weekLabel: cleanModuleWeekLabel(hint.weekLabel),
        sourceModule: hint.sourceModule,
      }))
      .filter((hint) => hint.weekLabel.length > 0);

    console.log(
      `[pipeline] ${courseName}: normalizeModules done in ${Date.now() - t0}ms — ` +
      `${valid.length} deltas, ${validCovered.length} covered, ${validWeekLabelHints.length} label hints from ${modules.length} modules`,
    );
    return { deltas: valid, coveredWeeks: validCovered, weekLabelHints: validWeekLabelHints };
  } catch (err) {
    console.warn(`[pipeline] ${courseName}: normalizeModules FAILED after ${Date.now() - t0}ms:`, err);
    return { deltas: [], coveredWeeks: [], weekLabelHints: [] };
  }
}

// ─── Fusion (deterministic) ──────────────────────────────────────────────────

function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function fuseTimeline(
  syllabusFacts: ParsedTopic[],
  moduleDeltas: ModuleDelta[],
  courseName: string,
): ParsedTopic[] {
  if (moduleDeltas.length === 0) return syllabusFacts;

  const deltasByWeek = new Map<number, ModuleDelta[]>();
  for (const delta of moduleDeltas) {
    const existing = deltasByWeek.get(delta.weekNumber);
    if (existing) {
      existing.push(delta);
    } else {
      deltasByWeek.set(delta.weekNumber, [delta]);
    }
  }

  let totalAdded = 0;

  const fused = syllabusFacts.map((week) => {
    const deltas = deltasByWeek.get(week.weekNumber);
    if (!deltas) return week;

    const existingTopicNorms = new Set(
      (week.topics ?? []).map(normalizeForDedup),
    );
    const existingReadingNorms = new Set(
      (week.readings ?? []).map(normalizeForDedup),
    );

    const newTopics = [...(week.topics ?? [])];
    const newReadings = [...(week.readings ?? [])];
    let addedContent = false;

    for (const delta of deltas) {
      for (const topic of delta.addTopics) {
        const norm = normalizeForDedup(topic);
        if (norm && !existingTopicNorms.has(norm)) {
          existingTopicNorms.add(norm);
          newTopics.push(topic);
          totalAdded++;
          addedContent = true;
        }
      }
      for (const reading of delta.addReadings) {
        const norm = normalizeForDedup(reading);
        if (norm && !existingReadingNorms.has(norm)) {
          existingReadingNorms.add(norm);
          newReadings.push(reading);
          totalAdded++;
          addedContent = true;
        }
      }
    }

    return {
      ...week,
      topics: newTopics,
      readings: newReadings,
      notes: addedContent && DATE_ONLY_PLACEHOLDER_NOTE_RX.test(week.notes ?? "")
        ? null
        : week.notes,
    };
  });

  if (totalAdded > 0) {
    console.log(`[pipeline] ${courseName}: fuseTimeline added ${totalAdded} items from module deltas`);
  }

  return fused;
}

function applyWeekLabelHintsToTimeline(
  topics: ReconciledTopic[],
  weekLabelHints: WeekLabelHint[],
): ReconciledTopic[] {
  if (topics.length === 0 || weekLabelHints.length === 0) return topics;

  const hintByWeek = new Map<number, WeekLabelHint>();
  for (const hint of weekLabelHints) {
    const existing = hintByWeek.get(hint.weekNumber);
    if (!existing || hint.weekLabel.length > existing.weekLabel.length) {
      hintByWeek.set(hint.weekNumber, hint);
    }
  }

  return topics.map((week) => {
    const hint = hintByWeek.get(week.weekNumber);
    if (!hint) return week;

    const labelIsGeneric =
      GENERIC_MEETING_LABEL_RX.test(week.weekLabel) ||
      /^week\s+\d+$/i.test(week.weekLabel) ||
      isAssignmentFallbackLabel(week.weekLabel);

    const hasNoVisibleContent = (week.topics?.length ?? 0) === 0 && (week.readings?.length ?? 0) === 0;
    if (!labelIsGeneric && !hasNoVisibleContent) return week;

    return { ...week, weekLabel: hint.weekLabel };
  });
}

function applyPerWeekFallback(
  fused: ParsedTopic[],
  fallback: ParsedTopic[],
  coveredWeeks: Set<number>,
): ParsedTopic[] {
  const fallbackByWeek = new Map<number, ParsedTopic>();
  for (const t of fallback) fallbackByWeek.set(t.weekNumber, t);

  return fused.map((week) => {
    if (coveredWeeks.has(week.weekNumber)) return week;

    const fb = fallbackByWeek.get(week.weekNumber);
    if (!fb) return week;

    const existingTopicNorms = new Set((week.topics ?? []).map(normalizeForDedup));
    const existingReadingNorms = new Set((week.readings ?? []).map(normalizeForDedup));

    const mergedTopics = [...(week.topics ?? [])];
    for (const t of fb.topics ?? []) {
      const norm = normalizeForDedup(t);
      if (norm && !existingTopicNorms.has(norm)) {
        existingTopicNorms.add(norm);
        mergedTopics.push(t);
      }
    }

    const mergedReadings = [...(week.readings ?? [])];
    for (const r of fb.readings ?? []) {
      const norm = normalizeForDedup(r);
      if (norm && !existingReadingNorms.has(norm)) {
        existingReadingNorms.add(norm);
        mergedReadings.push(r);
      }
    }

    return { ...week, topics: mergedTopics, readings: mergedReadings };
  });
}

function refineAssignmentFallbackPresentation(
  topics: ReconciledTopic[],
  assignmentFallbackTopics: ParsedTopic[],
  moduleDeltas: ModuleDelta[],
  weekLabelHints: WeekLabelHint[],
  outlineHints: OutlineFallbackHint[],
): ReconciledTopic[] {
  if (assignmentFallbackTopics.length === 0 || topics.length === 0) return topics;

  const assignmentTitlesByWeek = new Map<number, string[]>();
  for (const week of assignmentFallbackTopics) {
    assignmentTitlesByWeek.set(week.weekNumber, [...(week.topics ?? [])]);
  }

  const moduleSignalByWeek = new Map<number, { topicAdds: number; readingAdds: number }>();
  for (const delta of moduleDeltas) {
    const existing = moduleSignalByWeek.get(delta.weekNumber) ?? { topicAdds: 0, readingAdds: 0 };
    existing.topicAdds += delta.addTopics.length;
    existing.readingAdds += delta.addReadings.length;
    moduleSignalByWeek.set(delta.weekNumber, existing);
  }

  const weekLabelHintByWeek = new Map<number, WeekLabelHint>();
  for (const hint of weekLabelHints) {
    const existing = weekLabelHintByWeek.get(hint.weekNumber);
    if (!existing || hint.weekLabel.length > existing.weekLabel.length) {
      weekLabelHintByWeek.set(hint.weekNumber, hint);
    }
  }

  const outlineHintByWeek = new Map<number, OutlineFallbackHint>();
  for (const hint of outlineHints) {
    outlineHintByWeek.set(hint.weekNumber, hint);
  }

  return topics.map((week) => {
    if (week.sourceBlock !== "canvas_assignments") return week;

    const rawAssignmentTitles = assignmentTitlesByWeek.get(week.weekNumber) ?? [];
    if (rawAssignmentTitles.length === 0) return week;

    const assignmentNorms = new Set(rawAssignmentTitles.map(normalizeForDedup));
    const nonAssignmentTopics = (week.topics ?? []).filter(
      (topic) => !assignmentNorms.has(normalizeForDedup(topic)),
    );
    const assignmentSummary = summarizeAssignmentFallbackWeek(rawAssignmentTitles);
    const moduleSignal = moduleSignalByWeek.get(week.weekNumber);
    const hint = weekLabelHintByWeek.get(week.weekNumber);
    const outlineHint = outlineHintByWeek.get(week.weekNumber);
    const hasModuleEvidence = Boolean(hint) || Boolean(moduleSignal && (moduleSignal.topicAdds > 0 || moduleSignal.readingAdds > 0));
    const hasOutlineEvidence = Boolean(outlineHint && (outlineHint.weekLabel || outlineHint.topicHints.length > 0));

    const mergedTopicHints: string[] = [];
    const mergedTopicHintKeys = new Set<string>();
    const pushVisibleTopic = (value: string | null | undefined) => {
      const normalized = normalizeForDedup(value ?? "");
      if (!normalized || mergedTopicHintKeys.has(normalized)) return;
      mergedTopicHintKeys.add(normalized);
      mergedTopicHints.push((value ?? "").trim());
    };

    if (hasOutlineEvidence) {
      for (const topicHint of outlineHint?.topicHints ?? []) {
        pushVisibleTopic(topicHint);
      }
    }
    if (hasModuleEvidence) {
      for (const topicHint of nonAssignmentTopics) {
        pushVisibleTopic(topicHint);
      }
    }

    const nextTopics = mergedTopicHints.length > 0
      ? mergedTopicHints.slice(0, 4)
      : assignmentSummary.topicHints.length > 0
        ? assignmentSummary.topicHints
        : rawAssignmentTitles.slice(0, 3);

    const nextWeekLabel = outlineHint?.weekLabel
      ?? hint?.weekLabel
      ?? (isAssignmentFallbackLabel(week.weekLabel) && assignmentSummary.weekLabelHint
        ? assignmentSummary.weekLabelHint
        : week.weekLabel);

    return {
      ...week,
      weekLabel: nextWeekLabel,
      topics: nextTopics,
    };
  });
}

// ─── Validate ────────────────────────────────────────────────────────────────

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

// ─── Finalize ────────────────────────────────────────────────────────────────

function pickPreferredWeekLabel(a: ParsedTopic, b: ParsedTopic): string {
  const score = (topic: ParsedTopic) => {
    let value = hasInstructionalContent(topic) ? 4 : 0;
    if (!isBreakTopic(topic)) value += 2;
    if (topic.weekLabel && !GENERIC_WEEK_LABEL_RX.test(topic.weekLabel) && !isAssignmentFallbackLabel(topic.weekLabel)) {
      value += 2;
    }
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
  reconciliation: ReconciliationDiagnostics;
  usedModuleScaffold: boolean;
}): TimelineQuality {
  const datedTopics = args.topics.filter((topic) => Boolean(topic.startDate));
  const datedRatio = args.topics.length > 0 ? datedTopics.length / args.topics.length : 0;
  const warningPenalty = args.warnings.length;
  const repairPenalty = args.repairActionsApplied.filter((action) => action !== "used_module_scaffold").length;
  const verifiedOrCorroborated = args.reconciliation.verified + args.reconciliation.corroborated;
  const totalReconciled = verifiedOrCorroborated + args.reconciliation.unverified + args.reconciliation.conflicted;

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

  const splitBreakTopics = splitMixedBreakWeeks(finalizedTopics, args.termStartDate, args.termEndDate);
  if (splitBreakTopics.length > finalizedTopics.length) {
    repairActionsApplied.push(`split_mixed_break_weeks:${splitBreakTopics.length - finalizedTopics.length}`);
  }
  finalizedTopics = splitBreakTopics;

  // No more date-gap break inference — only explicitly stated breaks survive.
  // This is the "fail-closed" principle: gaps are shown as gaps, not fabricated breaks.

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

  // Deduplicate topics and readings within each week
  for (const topic of finalizedTopics) {
    if (topic.readings && topic.readings.length > 1) {
      const seen = new Set<string>();
      topic.readings = topic.readings.filter((r) => {
        const norm = normalizeForDedup(r);
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
      });
    }
    if (topic.topics && topic.topics.length > 1) {
      const seen = new Set<string>();
      topic.topics = topic.topics.filter((t) => {
        const norm = normalizeForDedup(t);
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

// ─── Step 4: COMMIT — Synthesize with verification states ───────────────────

function synthesizeTopics(args: {
  reconciledTopics: ReconciledTopic[];
  scheduleMode: ScheduleMode;
  usedModuleScaffold: boolean;
  usedLabel: string;
}): { topics: SynthesizedTopic[]; anchors: TimelineAnchorRecord[] } {
  const topics: SynthesizedTopic[] = [];
  const anchors: TimelineAnchorRecord[] = [];

  for (let i = 0; i < args.reconciledTopics.length; i++) {
    const rt = args.reconciledTopics[i];

    // Map verification status to confidence levels
    const dateConfidence: ConfidenceLevel =
      rt.verificationStatus === "verified" || rt.verificationStatus === "corroborated"
        ? "high"
        : rt.verificationStatus === "unverified"
          ? "medium"
          : rt.verificationStatus === "conflicted"
            ? "low"
            : "unknown";

    const hasContent = (rt.topics?.length ?? 0) > 0 || (rt.readings?.length ?? 0) > 0;
    const contentConfidence: ConfidenceLevel =
      !hasContent
        ? "low"
        : rt.sourceBlock === "schedule_table" || rt.sourceBlock === "syllabus_body"
          ? "high"
          : rt.sourceBlock === "canvas_modules" || rt.sourceBlock === "canvas_assignments"
            ? "medium"
            : "low";

    // Map verification status to anchor type
    const isBreak = isBreakTopic(rt);
    let anchorType: TimelineAnchorType;
    if (isBreak) {
      anchorType = "break";
    } else if (rt.sourceBlock === "canvas_modules" || rt.sourceBlock === "canvas_assignments") {
      anchorType = "canvas_only";
    } else {
      switch (rt.verificationStatus) {
        case "verified": anchorType = "syllabus_verified"; break;
        case "corroborated": anchorType = "syllabus_corroborated"; break;
        case "conflicted": anchorType = "conflicted"; break;
        default: anchorType = "syllabus_unverified"; break;
      }
    }

    topics.push({
      ...rt,
      dateConfidence,
      contentConfidence,
      scheduleMode: args.scheduleMode,
      provenance: {
        sourceBlock: rt.sourceBlock,
        verificationStatus: rt.verificationStatus,
        matchedAssignment: rt.matchedAssignment ?? null,
        usedLabel: args.usedLabel,
        usedModuleScaffold: args.usedModuleScaffold,
      },
      verificationStatus: rt.verificationStatus,
      sourceBlock: rt.sourceBlock,
    });

    anchors.push({
      sequenceNumber: i + 1,
      anchorDate: rt.startDate ?? null,
      anchorType,
      isInstructional: !isBreak && hasInstructionalContent(rt),
      calendarConfidence: dateConfidence,
      sourceRefs: { sourceBlock: rt.sourceBlock, verificationStatus: rt.verificationStatus },
      notes: rt.notes ?? null,
    });
  }

  return { topics, anchors };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function runTopicPipeline(input: PipelineInput): Promise<PipelineResult> {
  const debug: PipelineDebug = {
    stage1Classifications: [],
    stage2Sources: input.candidates.length,
    stage2Weeks: 0,
    stage3Reconciliation: { verified: 0, corroborated: 0, unverified: 0, conflicted: 0, gaps: 0, dayOfWeekMismatches: 0, outOfTermBounds: 0 },
    stage4OutputWeeks: 0,
    stage4Warnings: [],
    fallbackUsed: false,
  };

  // ── STEP 1: SEGMENT — classify modules ──
  const moduleClassifications = input.modules.length > 0
    ? await classifyModules(input.modules.map((m) => m.weekLabel))
    : new Map<string, ModuleCategory>();

  debug.stage1Classifications = input.modules.map((m) => ({
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
    `[pipeline] ${input.courseName}: Step 1 classified ${input.modules.length} modules → ` +
    `${contentModules.length} content, ${nonContentModuleIds.length} non-content`,
  );

  // ── STEP 2: EXTRACT — single-pass per block ──
  const extraction = await extractFromBlocks(input.candidates, input.courseName);
  const canonicalExtraction = isCanonicalTimelineExtraction(extraction);

  debug.stage2Weeks = extraction.topics.length;
  debug.extractedScheduleShape = extraction.scheduleShape;
  debug.extractedRowSemantics = extraction.rowSemantics;

  let aiTopics = canonicalExtraction ? extraction.topics : [];
  let usedModuleScaffold = false;
  let sourceBlock = "schedule_table";
  let assignmentFallbackTopics: ParsedTopic[] = [];
  let lectureOutlineFallbackHints: OutlineFallbackHint[] = [];

  // Determine source block from extraction shape
  if (extraction.scheduleShape === "none") {
    sourceBlock = "syllabus_body";
  }

  console.log(
    `[pipeline] ${input.courseName}: Step 2 extracted ${aiTopics.length} entries` +
    ` | source=${extraction.usedLabel} | shape=${extraction.scheduleShape}`,
  );

  if (!canonicalExtraction && extraction.rowSemantics === "lecture_number" && !extraction.hasExplicitDates) {
    console.log(
      `[pipeline] ${input.courseName}: Step 2 ignored undated lecture-number outline ` +
      `(${extraction.topics.length} lecture rows) → not a canonical weekly timeline`,
    );
  }

  // Assignment fallback: if there is no usable syllabus schedule, prefer
  // Canvas due dates over module ordering because due dates are ground truth.
  if (aiTopics.length === 0) {
    const assignmentTimeline = organizeAssignmentsAsTimeline(input.assignments, input.courseName);
    if (assignmentTimeline.length > 0) {
      aiTopics = assignmentTimeline;
      assignmentFallbackTopics = assignmentTimeline.map((week) => ({
        ...week,
        topics: [...(week.topics ?? [])],
        readings: [...(week.readings ?? [])],
      }));
      lectureOutlineFallbackHints = extraction.rowSemantics === "lecture_number"
        ? buildOutlineFallbackHints(extraction.topics, assignmentFallbackTopics)
        : [];
      sourceBlock = "canvas_assignments";
      debug.fallbackUsed = true;
      console.log(
        `[pipeline] ${input.courseName}: Step 2 fallback → ${assignmentTimeline.length} assignment-timeline entries` +
        (lectureOutlineFallbackHints.length > 0 ? ` + ${lectureOutlineFallbackHints.length} outline hint week(s)` : ""),
      );
    }
  }

  // Module scaffold fallback: only when both syllabus extraction and assignment
  // fallback produced nothing.
  if (aiTopics.length === 0 && contentModules.length >= 4) {
    const scaffold = organizeModulesAsTimeline(
      contentModules, input.courseName, input.termStartDate, input.termEndDate,
    );
    if (scaffold.length > 0) {
      aiTopics = scaffold;
      usedModuleScaffold = true;
      sourceBlock = "canvas_modules";
      debug.fallbackUsed = true;
      console.log(`[pipeline] ${input.courseName}: Step 2 fallback → ${scaffold.length} module entries`);
    }
  }

  // ── STEP 3: RECONCILE — verify against Canvas ground truth ──
  const reconciliation = reconcileAgainstCanvas({
    extractedTopics: aiTopics,
    assignments: input.assignments,
    syllabusEvents: input.syllabusEvents ?? [],
    termStartDate: input.termStartDate,
    termEndDate: input.termEndDate,
    classSchedule: input.classSchedule,
    sourceBlock,
  });

  debug.stage3Reconciliation = reconciliation.diagnostics;

  console.log(
    `[pipeline] ${input.courseName}: Step 3 reconciled → ` +
    `verified=${reconciliation.diagnostics.verified} corroborated=${reconciliation.diagnostics.corroborated} ` +
    `unverified=${reconciliation.diagnostics.unverified} conflicted=${reconciliation.diagnostics.conflicted} ` +
    `gaps=${reconciliation.diagnostics.gaps}`,
  );

  // ── STEP 4: COMMIT — normalize, fuse, finalize, synthesize ──
  let finalTopics: ReconciledTopic[] = reconciliation.topics;
  let moduleIdsToDelete: string[];

  if (aiTopics.length === 0 && contentModules.length === 0) {
    // Nothing from either source
    moduleIdsToDelete = [];
    debug.fallbackUsed = true;
    console.log(`[pipeline] ${input.courseName}: Step 4 skipped — no data from either source`);

  } else if (usedModuleScaffold) {
    // Module scaffold path — run normalizer for content humanization
    const spineForNormalizer = finalTopics.map((t) => ({
      weekNumber: t.weekNumber,
      weekLabel: t.weekLabel,
      startDate: t.startDate ?? null,
      topics: t.topics ?? [],
      readings: t.readings ?? [],
    }));

    const { deltas: moduleDeltas, coveredWeeks, weekLabelHints } = await normalizeModules(
      contentModules, spineForNormalizer, input.courseName,
    );

    const fused = fuseTimeline(finalTopics, moduleDeltas, input.courseName);
    const withFallback = applyPerWeekFallback(fused, aiTopics, new Set(coveredWeeks));

    // Re-apply reconciliation data to fused topics
    finalTopics = withFallback.map((t, i) => ({
      ...t,
      verificationStatus: finalTopics[i]?.verificationStatus ?? "unverified" as VerificationStatus,
      sourceBlock: finalTopics[i]?.sourceBlock ?? sourceBlock,
      matchedAssignment: finalTopics[i]?.matchedAssignment,
    }));
    finalTopics = applyWeekLabelHintsToTimeline(finalTopics, weekLabelHints);
    finalTopics = refineAssignmentFallbackPresentation(
      finalTopics,
      assignmentFallbackTopics,
      moduleDeltas,
      weekLabelHints,
      lectureOutlineFallbackHints,
    );

    moduleIdsToDelete = input.modules.map((m) => m.id);
    console.log(
      `[pipeline] ${input.courseName}: Step 4 scaffold path → ${finalTopics.length} weeks ` +
      `(${moduleDeltas.length} deltas, ${coveredWeeks.length} covered)`,
    );

  } else {
    // Normal path — normalize modules into deltas and fuse
    const spineForNormalizer = finalTopics.map((t) => ({
      weekNumber: t.weekNumber,
      weekLabel: t.weekLabel,
      startDate: t.startDate ?? null,
      topics: t.topics ?? [],
      readings: t.readings ?? [],
    }));

    const { deltas: moduleDeltas, coveredWeeks, weekLabelHints } = await normalizeModules(
      contentModules, spineForNormalizer, input.courseName,
    );

    const fused = fuseTimeline(finalTopics, moduleDeltas, input.courseName);

    // Re-apply reconciliation data to fused topics
    finalTopics = fused.map((t, i) => ({
      ...t,
      verificationStatus: finalTopics[i]?.verificationStatus ?? "unverified" as VerificationStatus,
      sourceBlock: finalTopics[i]?.sourceBlock ?? sourceBlock,
      matchedAssignment: finalTopics[i]?.matchedAssignment,
    }));
    finalTopics = applyWeekLabelHintsToTimeline(finalTopics, weekLabelHints);
    finalTopics = refineAssignmentFallbackPresentation(
      finalTopics,
      assignmentFallbackTopics,
      moduleDeltas,
      weekLabelHints,
      lectureOutlineFallbackHints,
    );

    moduleIdsToDelete = input.modules.map((m) => m.id);
    console.log(
      `[pipeline] ${input.courseName}: Step 4 produced ${finalTopics.length} weeks ` +
      `(${moduleDeltas.length} deltas, ${coveredWeeks.length} covered)`,
    );
  }

  // Finalize: break splitting, dedup, collapse, validation
  const finalized = finalizeTimelineForPersistence({
    topics: finalTopics,
    termStartDate: input.termStartDate,
    termEndDate: input.termEndDate,
    courseName: input.courseName,
    usedModuleScaffold,
    reconciliation: reconciliation.diagnostics,
  });
  debug.stage4OutputWeeks = finalized.topics.length;
  debug.stage4Warnings = finalized.warnings;

  if (finalized.warnings.length > 0) {
    console.warn(`[pipeline] ${input.courseName}: validation warnings:`, finalized.warnings);
  }

  // Re-reconcile after finalization (break splitting / collapsing may have changed topics)
  // Map finalized topics back to reconciled topics using weekNumber matching
  const reconciledByWeek = new Map<number, ReconciledTopic>();
  for (const rt of finalTopics) {
    reconciledByWeek.set(rt.weekNumber, rt);
  }

  const finalReconciledTopics: ReconciledTopic[] = finalized.topics.map((t) => {
    const original = reconciledByWeek.get(t.weekNumber);
    return {
      ...t,
      verificationStatus: original?.verificationStatus ?? "unverified" as VerificationStatus,
      sourceBlock: original?.sourceBlock ?? sourceBlock,
      matchedAssignment: original?.matchedAssignment,
    };
  });

  // Determine schedule mode
  const scheduleMode: ScheduleMode = isSparseTimeline(finalized.topics)
    ? "sparse"
    : finalized.topics.some((t) => Boolean(t.startDate))
      ? "weekly"
      : usedModuleScaffold
        ? "inferred"
        : "unknown";

  // Synthesize final output with verification states
  const synthesized = synthesizeTopics({
    reconciledTopics: finalReconciledTopics,
    scheduleMode,
    usedModuleScaffold,
    usedLabel: extraction.usedLabel,
  });

  return {
    topics: synthesized.topics,
    anchors: synthesized.anchors,
    timelineMode: scheduleMode,
    timelineDiagnostics: {
      extractionSource: extraction.usedLabel,
      reconciliation: reconciliation.diagnostics,
      usedModuleScaffold,
      stage4Warnings: debug.stage4Warnings,
      repairActionsApplied: finalized.repairActionsApplied,
      timelineQuality: finalized.timelineQuality,
      extractedScheduleShape: debug.extractedScheduleShape ?? "none",
      extractedRowSemantics: debug.extractedRowSemantics ?? "unknown",
    },
    moduleIdsToDelete,
    debug,
  };
}
