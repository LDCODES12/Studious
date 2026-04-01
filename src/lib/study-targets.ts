import {
  computeCourseContext,
  type CourseContextInput,
  type WeekPosition,
} from "./course-context";
import type { ExtractedClassSchedule } from "./parse-syllabus";

export interface StudyTarget {
  courseId: string;
  courseName: string;
  courseColor: string;
  topicName: string;
  readings: string[];
  evidence: StudyTargetEvidence;
  source:
    | "current_topic"
    | "review_topic"
    | "reading"
    | "material_topic"
    | "week_label";
}

export interface StudyTargetEvidence {
  source: StudyTarget["source"];
  weekLabel: string | null;
  readings: string[];
  materials: Array<{
    id: string;
    fileName: string;
  }>;
  candidates: Array<{
    id: string;
    fileName: string;
    moduleName: string;
    requested: boolean;
  }>;
}

export interface StudyTargetCourseInput
  extends Omit<CourseContextInput, "classSchedule"> {
  classSchedule: unknown;
  materials?: {
    id: string;
    fileName: string;
    detectedType: string;
    relatedTopics: string[];
  }[];
  materialCandidates?: {
    id: string;
    fileName: string;
    moduleName: string;
    requested?: boolean;
  }[];
}

interface RankedTarget {
  label: string;
  readings: string[];
  score: number;
  source: StudyTarget["source"];
  weekLabel: string | null;
}

const STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "into",
  "about",
  "this",
  "that",
  "your",
  "chapter",
  "lectures",
  "lecture",
  "week",
  "unit",
  "class",
  "session",
  "text",
  "review",
  "study",
  "problem",
  "set",
  "sets",
  "quiz",
  "quizzes",
  "exam",
  "exams",
  "blank",
  "key",
  "keys",
  "solution",
  "solutions",
  "worksheet",
  "worksheets",
  "student",
  "copy",
  "discussion",
  "discussions",
  "question",
  "questions",
  "topic",
  "topics",
  "outline",
  "schedule",
  "calendar",
  "resource",
  "resources",
  "activity",
  "information",
  "instructions",
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanTopicLabel(raw: string): string | null {
  let value = normalizeWhitespace(raw);
  if (!value) return null;

  value = value.replace(/\.[A-Za-z0-9]+$/, "");
  value = value.replace(/^Experiment\s+\d+(?:\.\d+)?\s*:\s*/i, "");
  value = value.replace(/^Problem Set\s+\d+(?:\.\d+)?\s*:\s*/i, "");
  value = value.replace(/\s+\[[A-Z]+\](?:\s+\[[A-Z]+\])*$/g, "");
  value = normalizeWhitespace(value);

  if ((value.length > 90 || /;/.test(value)) && value.includes(":")) {
    const head = normalizeWhitespace(value.split(":")[0] ?? "");
    if (head.length >= 4 && head.length <= 60) value = head;
  }

  value = value.replace(/[_]+/g, " ");
  value = normalizeWhitespace(value);

  if (value.length < 3 || value.length > 100) return null;
  return value;
}

function cleanReadingLabel(raw: string): string | null {
  const value = cleanTopicLabel(raw);
  if (!value) return null;
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+\- ]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function hasSharedTokens(value: string, nearbyTerms: Set<string>): boolean {
  return tokenize(value).some((token) => nearbyTerms.has(token));
}

function buildNearbyTerms(weeks: Array<WeekPosition | null | undefined>): Set<string> {
  const terms = new Set<string>();
  for (const week of weeks) {
    if (!week) continue;
    for (const value of [week.weekLabel, ...week.topics, ...week.readings]) {
      for (const token of tokenize(value)) terms.add(token);
    }
  }
  return terms;
}

function isAdministrativeLabel(value: string): boolean {
  return /\b(no lecture|no lab|no experiment|bye week|spring break|holiday|break week|course information|orientation|reading days|mlk day|ungraded problem sets|report discussions|exam resources|assignment descriptions|quiz files)\b/i.test(
    value
  );
}

function isAssessmentLabel(value: string): boolean {
  return /^(exam|quiz|midterm|final|test)\b/i.test(value);
}

function isGenericStructureLabel(value: string): boolean {
  return /^(lecture|module|week|unit|chapter|session|class(?: meeting)?)\s*\d+(?:\.\d+)?\b(?:\s*[-:]\s*)?$/i.test(
    value
  );
}

function isUsefulStudyLabel(value: string): boolean {
  if (isAdministrativeLabel(value)) return false;
  if (isAssessmentLabel(value)) return false;
  if (isGenericStructureLabel(value)) return false;
  if (/^e\d+\b/i.test(value)) return false;
  return true;
}

function isSemanticTopic(value: string): boolean {
  return !/^(lecture|module|week|unit|chapter|session|class)\s*\d+$/i.test(value);
}

function addTargets(
  out: RankedTarget[],
  labels: string[],
  readings: string[],
  score: number,
  source: StudyTarget["source"],
  weekLabel: string | null,
  requireSharedTerms = false,
  nearbyTerms?: Set<string>
) {
  for (const raw of labels) {
    const cleaned = cleanTopicLabel(raw);
    if (!cleaned) continue;
    if (!isUsefulStudyLabel(cleaned)) continue;
    if (!isSemanticTopic(cleaned) && source !== "reading") continue;
    if (requireSharedTerms && nearbyTerms && nearbyTerms.size > 0 && !hasSharedTokens(cleaned, nearbyTerms)) {
      continue;
    }
    out.push({ label: cleaned, readings, score, source, weekLabel });
  }
}

function countSharedTokens(tokens: Set<string>, value: string): number {
  return tokenize(value).filter((token) => tokens.has(token)).length;
}

function normalizeAnchorLabel(raw: string): string {
  const value = raw.toLowerCase();
  if (value.startsWith("lect")) return "lecture";
  if (value.startsWith("class")) return "class";
  if (value.startsWith("exper")) return "experiment";
  if (value.startsWith("unit")) return "unit";
  if (value.startsWith("chap")) return "chapter";
  return value;
}

function extractAnchorTokens(value: string): string[] {
  const anchors: string[] = [];
  const regex =
    /\b(class(?:\s+meeting)?|lecture|lectures|experiment|experiments|unit|units|chapter|chapters)\s*#?\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi;

  for (const match of value.matchAll(regex)) {
    const label = normalizeAnchorLabel(match[1] ?? "");
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    if (high - low > 10) continue;
    for (let n = low; n <= high; n += 1) {
      anchors.push(`${label}:${n}`);
    }
  }

  return anchors;
}

function buildAnchorSet(values: string[]): Set<string> {
  const anchors = new Set<string>();
  for (const value of values) {
    for (const anchor of extractAnchorTokens(value)) anchors.add(anchor);
  }
  return anchors;
}

function countAnchorOverlap(anchors: Set<string>, value: string): number {
  const ownAnchors = new Set(extractAnchorTokens(value));
  let count = 0;
  for (const anchor of ownAnchors) {
    if (anchors.has(anchor)) count += 1;
  }
  return count;
}

function buildTargetEvidence(
  target: RankedTarget,
  course: StudyTargetCourseInput,
  nearbyTerms: Set<string>
): StudyTargetEvidence {
  const targetTerms = new Set([
    ...tokenize(target.label),
    ...target.readings.flatMap((reading) => tokenize(reading)),
  ]);
  const targetAnchors = buildAnchorSet([
    target.label,
    target.weekLabel ?? "",
    ...target.readings,
  ]);

  const matchedMaterials = (course.materials ?? [])
    .map((material) => {
      const relatedScore = Math.max(
        0,
        ...material.relatedTopics.map((topic) => countSharedTokens(targetTerms, topic))
      );
      const fileScore = countSharedTokens(targetTerms, material.fileName);
      const anchorScore = Math.max(
        ...material.relatedTopics.map((topic) => countAnchorOverlap(targetAnchors, topic)),
        countAnchorOverlap(targetAnchors, material.fileName),
        0
      );
      const nearbyScore = Math.max(
        ...material.relatedTopics.map((topic) => countSharedTokens(nearbyTerms, topic)),
        countSharedTokens(nearbyTerms, material.fileName),
        0
      );
      const score = relatedScore * 4 + fileScore * 3 + anchorScore * 4 + nearbyScore;
      return { material, score, strongMatch: relatedScore > 0 || fileScore > 0 || anchorScore > 0 };
    })
    .filter((entry) => entry.strongMatch && entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.material);

  const matchedCandidates = (course.materialCandidates ?? [])
    .map((candidate) => {
      const moduleScore = countSharedTokens(targetTerms, candidate.moduleName);
      const fileScore = countSharedTokens(targetTerms, candidate.fileName);
      const anchorScore =
        countAnchorOverlap(targetAnchors, candidate.moduleName) * 3 +
        countAnchorOverlap(targetAnchors, candidate.fileName) * 4;
      const nearbyScore =
        countSharedTokens(nearbyTerms, candidate.moduleName) +
        countSharedTokens(nearbyTerms, candidate.fileName);
      const requestedBoost = candidate.requested ? 1 : 0;
      return {
        candidate,
        score: moduleScore * 3 + fileScore * 4 + anchorScore + nearbyScore + requestedBoost,
        strongMatch: moduleScore > 0 || fileScore > 0 || anchorScore > 0,
      };
    })
    .filter((entry) => entry.strongMatch && entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.candidate);

  const candidates = matchedCandidates.slice(0, 3).map((candidate) => ({
    id: candidate.id,
    fileName: candidate.fileName,
    moduleName: candidate.moduleName,
    requested: !!candidate.requested,
  }));

  return {
    source: target.source,
    weekLabel: target.weekLabel,
    readings: target.readings,
    materials: matchedMaterials.map((material) => ({
      id: material.id,
      fileName: material.fileName,
    })),
    candidates,
  };
}

export function buildStudyTargets(
  course: StudyTargetCourseInput,
  now: Date = new Date()
): StudyTarget[] {
  const ctx = computeCourseContext(
    {
      ...course,
      classSchedule: course.classSchedule as ExtractedClassSchedule | null,
    },
    now
  );
  const ranked: RankedTarget[] = [];

  const current = ctx.currentWeek;
  const previous = ctx.previousWeek;
  const next = ctx.nextWeek;

  const currentTopics = (current?.topics ?? []).map(cleanTopicLabel).filter((v): v is string => !!v);
  const goodCurrentTopics = currentTopics.filter(isUsefulStudyLabel);
  const currentIsWeak =
    !current ||
    goodCurrentTopics.length === 0 ||
    goodCurrentTopics.every((topic) => isAssessmentLabel(topic) || isAdministrativeLabel(topic));

  if (current && goodCurrentTopics.length > 0) {
    addTargets(ranked, goodCurrentTopics, current.readings, 100, "current_topic", current.weekLabel);
  }

  if (currentIsWeak && previous) {
    addTargets(ranked, previous.topics, previous.readings, 85, "review_topic", previous.weekLabel);
  }

  if (current && ranked.length === 0) {
    const readingTargets = current.readings
      .map(cleanReadingLabel)
      .filter((value): value is string => !!value);
    addTargets(ranked, readingTargets, current.readings, 75, "reading", current.weekLabel);
  }

  if (ranked.length === 0 && previous && previous.readings.length > 0) {
    const readingTargets = previous.readings
      .map(cleanReadingLabel)
      .filter((value): value is string => !!value);
    addTargets(ranked, readingTargets, previous.readings, 72, "reading", previous.weekLabel);
  }

  const nearbyTerms = buildNearbyTerms([current, previous, next]);
  const materialTopics = (course.materials ?? []).flatMap((material) => material.relatedTopics);
  if (ranked.length === 0 && materialTopics.length > 0) {
    addTargets(
      ranked,
      materialTopics,
      current?.readings ?? [],
      65,
      "material_topic",
      current?.weekLabel ?? previous?.weekLabel ?? null,
      true,
      nearbyTerms
    );
  }

  if (ranked.length === 0 && current?.weekLabel) {
    addTargets(ranked, [current.weekLabel], current.readings, 60, "week_label", current.weekLabel);
  }

  if (ranked.length === 0 && next) {
    addTargets(ranked, next.topics, next.readings, 55, "review_topic", next.weekLabel);
  }

  const deduped = new Map<string, RankedTarget>();
  for (const target of ranked) {
    const key = target.label.toLowerCase();
    const existing = deduped.get(key);
    if (!existing || target.score > existing.score) deduped.set(key, target);
  }

  return [...deduped.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((target) => ({
      courseId: course.id,
      courseName: course.name,
      courseColor: course.color,
      topicName: target.label,
      readings: target.readings,
      evidence: buildTargetEvidence(target, course, nearbyTerms),
      source: target.source,
    }));
}
