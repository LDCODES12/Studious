import { addDays, differenceInCalendarDays, format, isValid, parseISO, startOfWeek, subDays } from "date-fns";
import { db } from "@/lib/db";
import { generateEmbedding } from "@/lib/embeddings";
import type { CourseContextSnapshot, DeadlineItem } from "@/lib/course-context";
import type { StudyTargetEvidence } from "@/lib/study-targets";

export type MaterialSourceRole = "canonical" | "transcript" | "structural";

interface MaterialRecord {
  id: string;
  courseId: string;
  courseName: string | null;
  fileName: string;
  detectedType: string;
  sourceKind: string;
  sourceRole: string;
  summary: string;
  relatedTopics: string[];
  rawText: string;
  storedForAI: boolean;
  contentHash: string | null;
  sourceUpdatedAt: Date | null;
  uploadedAt: Date;
}

export interface SelectionCandidate extends EvidenceMaterial {
  matchScore: number;
  preferred: boolean;
}

export interface EvidenceMaterial {
  id: string;
  fileName: string;
  courseName?: string | null;
  detectedType: string;
  sourceKind: string;
  sourceRole: string;
  summary: string;
  relatedTopics: string[];
  rawText: string;
  storedForAI: boolean;
  contentHash: string | null;
  sourceUpdatedAt?: string | null;
  uploadedAt: string;
  materialSourceRole: Exclude<MaterialSourceRole, "structural">;
}

export interface TranscriptDigest {
  emphasizedConcepts: string[];
  workedExamples: string[];
  reviewSignals: string[];
  clarifications: string[];
}

export interface StructuralDeadlineEvidence {
  title: string;
  type: string;
  dueDate: string;
  pointsPossible: number | null;
  status: string;
}

export interface ResolvedWeeklyEvidence {
  structuralContext: {
    courseId: string;
    courseName: string;
    weekLabel: string | null;
    topics: string[];
    readings: string[];
    notes: string | null;
    deadlines: StructuralDeadlineEvidence[];
    nextAssessmentTitle: string | null;
  };
  canonicalMaterials: EvidenceMaterial[];
  transcriptMaterials: EvidenceMaterial[];
  transcriptDigest: TranscriptDigest | null;
}

export interface ResolvedStudyEvidence {
  structuralContext: {
    courseId: string;
    courseName: string | null;
    topicName: string | null;
    weekLabel: string | null;
    readings: string[];
  };
  canonicalMaterials: EvidenceMaterial[];
  transcriptMaterials: EvidenceMaterial[];
  transcriptDigest: TranscriptDigest | null;
  pendingCandidates: Array<{
    id: string;
    fileName: string;
    moduleName: string;
    requested: boolean;
  }>;
  lectureSpecific: boolean;
}

interface SelectionCaps {
  maxCanonical: number;
  maxTranscript: number;
  transcriptOnlyMax: number;
}

interface WeeklyEvidenceInput {
  courseId: string;
  courseName: string;
  context: CourseContextSnapshot;
  now?: Date;
}

interface StudyEvidenceInput {
  courseId: string;
  courseName?: string | null;
  topicName?: string | null;
  questionText?: string | null;
  targetEvidence?: StudyTargetEvidence | null;
  materialIds?: string[];
  storedForAIOnly?: boolean;
  selectionCaps?: Partial<SelectionCaps>;
}

interface CrossCourseStudyEvidenceInput {
  userId: string;
  questionText?: string | null;
  selectionCaps?: Partial<SelectionCaps>;
}

const DEFAULT_WEEKLY_CAPS: SelectionCaps = {
  maxCanonical: 2,
  maxTranscript: 2,
  transcriptOnlyMax: 3,
};

const DEFAULT_STUDY_CAPS: SelectionCaps = {
  maxCanonical: 3,
  maxTranscript: 2,
  transcriptOnlyMax: 3,
};

const DEFAULT_GENERATION_CAPS: SelectionCaps = {
  maxCanonical: 6,
  maxTranscript: 4,
  transcriptOnlyMax: 6,
};

const STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "that",
  "this",
  "these",
  "your",
  "into",
  "about",
  "lecture",
  "lectures",
  "section",
  "review",
  "session",
  "class",
  "course",
  "student",
  "students",
  "discussion",
  "worksheet",
  "questions",
  "question",
  "problem",
  "problems",
  "chapter",
  "chapters",
  "unit",
  "week",
  "weeks",
  "textbook",
]);

const REVIEW_SIGNAL_RX = /\b(review|exam|quiz|midterm|final|practice exam|practice quiz)\b/i;
const WORKED_EXAMPLE_RX = /\b(example|examples|practice|walkthrough|worked|calculation|calculating|interpret|interpreting|problem|problems)\b/i;
const CLARIFICATION_RX = /\b(focuses on|introduced?|covers|explains?|clarif(?:y|ies|ied)|connects?|relates?|how to|how .* relates?|demonstrates?)\b/i;
const LECTURE_SPECIFIC_RX = /\b(lecture|in class|class|professor|prof|in lecture|covered|say|said|emphasized|review session)\b/i;
const WEAK_CANONICAL_RX = /\b(syllabus|schedule|calendar|welcome|orientation|announcement|policy|rubric|attendance|chat file|transcript|recording|zoom|media gallery)\b/i;
const CANONICAL_BACKBONE_TYPES = new Set(["lecture_notes", "lecture_slides", "textbook", "problem_set"]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9+\- ]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function dedupeStrings(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values.map(normalizeWhitespace)) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function canonicalPriority(material: EvidenceMaterial): number {
  switch (material.detectedType) {
    case "lecture_notes":
      return 6;
    case "lecture_slides":
      return 5;
    case "textbook":
      return 4;
    case "problem_set":
      return 3;
    default:
      return 1;
  }
}

function transcriptPriority(material: EvidenceMaterial): number {
  const text = `${material.fileName} ${material.summary}`.toLowerCase();
  if (/\b(exam|quiz|review|midterm|final)\b/.test(text)) return 5;
  if (/\b(lecture|class)\b/.test(text)) return 3;
  return 1;
}

function materialFreshnessPriority(material: Pick<EvidenceMaterial, "sourceUpdatedAt" | "uploadedAt">): number {
  const freshnessRaw = material.sourceUpdatedAt ?? material.uploadedAt;
  if (!freshnessRaw) return 0;
  const freshness = new Date(freshnessRaw);
  if (!Number.isFinite(freshness.getTime())) return 0;
  const daysOld = differenceInCalendarDays(new Date(), freshness);
  if (daysOld <= 3) return 4;
  if (daysOld <= 7) return 3;
  if (daysOld <= 14) return 2;
  if (daysOld <= 21) return 1;
  return 0;
}

export function classifyMaterialSourceRole(
  material: Pick<MaterialRecord | EvidenceMaterial, "sourceKind">
): Exclude<MaterialSourceRole, "structural"> {
  return material.sourceKind === "canvas_media" ? "transcript" : "canonical";
}

function isCanonicalBackboneMaterial(
  material: Pick<EvidenceMaterial, "detectedType" | "fileName" | "summary" | "sourceKind" | "sourceRole">
): boolean {
  if (material.sourceKind === "canvas_syllabus") return false;
  if (material.sourceRole === "timeline") return false;
  if (CANONICAL_BACKBONE_TYPES.has(material.detectedType)) return true;
  if (material.detectedType === "other") {
    return !WEAK_CANONICAL_RX.test(`${material.fileName} ${material.summary}`);
  }
  return false;
}

function toEvidenceMaterial(material: MaterialRecord, matchScore: number, preferred: boolean): SelectionCandidate {
  return {
    id: material.id,
    fileName: material.fileName,
    courseName: material.courseName,
    detectedType: material.detectedType,
    sourceKind: material.sourceKind,
    sourceRole: material.sourceRole,
    summary: material.summary,
    relatedTopics: material.relatedTopics,
    rawText: material.rawText,
    storedForAI: material.storedForAI,
    contentHash: material.contentHash,
    sourceUpdatedAt: material.sourceUpdatedAt?.toISOString() ?? null,
    uploadedAt: material.uploadedAt.toISOString(),
    materialSourceRole: classifyMaterialSourceRole(material),
    matchScore,
    preferred,
  };
}

async function fetchMaterialDetails(
  courseId: string,
  ids?: string[],
  storedForAIOnly = false,
): Promise<MaterialRecord[]> {
  return db.courseMaterial.findMany({
    where: {
      courseId,
      ...(ids ? { id: { in: ids } } : {}),
      ...(storedForAIOnly ? { storedForAI: true } : {}),
    },
    select: {
      id: true,
      courseId: true,
      course: { select: { name: true } },
      fileName: true,
      detectedType: true,
      sourceKind: true,
      sourceRole: true,
      summary: true,
      relatedTopics: true,
      rawText: true,
      storedForAI: true,
      contentHash: true,
      sourceUpdatedAt: true,
      uploadedAt: true,
    },
  }).then((materials) =>
    materials.map(({ course, ...material }) => ({
      ...material,
      courseName: course?.name ?? null,
    }))
  );
}

async function searchMaterialIds(courseId: string, query: string, limit: number): Promise<string[]> {
  if (!query.trim()) return [];
  const vector = await generateEmbedding(query);
  const vectorStr = JSON.stringify(vector);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM "CourseMaterial"
    WHERE "courseId" = ${courseId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

async function fetchUserMaterialDetails(
  userId: string,
  ids: string[],
): Promise<MaterialRecord[]> {
  if (ids.length === 0) return [];
  return db.courseMaterial.findMany({
    where: {
      id: { in: ids },
      course: { userId },
    },
    select: {
      id: true,
      courseId: true,
      course: { select: { name: true } },
      fileName: true,
      detectedType: true,
      sourceKind: true,
      sourceRole: true,
      summary: true,
      relatedTopics: true,
      rawText: true,
      storedForAI: true,
      contentHash: true,
      sourceUpdatedAt: true,
      uploadedAt: true,
    },
  }).then((materials) =>
    materials.map(({ course, ...material }) => ({
      ...material,
      courseName: course?.name ?? null,
    }))
  );
}

async function searchUserMaterialIds(userId: string, query: string, limit: number): Promise<string[]> {
  if (!query.trim()) return [];
  const vector = await generateEmbedding(query);
  const vectorStr = JSON.stringify(vector);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT cm.id
    FROM "CourseMaterial" cm
    INNER JOIN "Course" c ON c.id = cm."courseId"
    WHERE c."userId" = ${userId}
      AND cm.embedding IS NOT NULL
    ORDER BY cm.embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

async function fetchRecentUserMaterials(userId: string, limit: number): Promise<MaterialRecord[]> {
  const cutoff = subDays(new Date(), 10);
  return db.courseMaterial.findMany({
    where: {
      course: { userId },
      OR: [
        { sourceUpdatedAt: { gte: cutoff } },
        { uploadedAt: { gte: cutoff } },
      ],
    },
    select: {
      id: true,
      courseId: true,
      course: { select: { name: true } },
      fileName: true,
      detectedType: true,
      sourceKind: true,
      sourceRole: true,
      summary: true,
      relatedTopics: true,
      rawText: true,
      storedForAI: true,
      contentHash: true,
      sourceUpdatedAt: true,
      uploadedAt: true,
    },
    orderBy: [{ sourceUpdatedAt: "desc" }, { uploadedAt: "desc" }],
    take: limit,
  }).then((materials) =>
    materials.map(({ course, ...material }) => ({
      ...material,
      courseName: course?.name ?? null,
    }))
  );
}

function mergeRankedMaterials(
  preferredMaterials: MaterialRecord[],
  semanticMaterials: MaterialRecord[],
): SelectionCandidate[] {
  const ranked = new Map<string, SelectionCandidate>();

  preferredMaterials.forEach((material, index) => {
    ranked.set(material.id, toEvidenceMaterial(material, 100 - index, true));
  });

  semanticMaterials.forEach((material, index) => {
    const existing = ranked.get(material.id);
    const next = toEvidenceMaterial(material, 70 - index, false);
    if (!existing || existing.matchScore < next.matchScore) {
      ranked.set(material.id, next);
    }
  });

  return [...ranked.values()];
}

export function selectSourceAwareMaterials(
  materials: SelectionCandidate[],
  caps: SelectionCaps,
): {
  canonicalMaterials: EvidenceMaterial[];
  transcriptMaterials: EvidenceMaterial[];
} {
  const strongCanonical = materials
    .filter((material) => material.materialSourceRole === "canonical" && isCanonicalBackboneMaterial(material))
    .sort((a, b) => {
      const delta = Number(b.preferred) - Number(a.preferred)
        || canonicalPriority(b) - canonicalPriority(a)
        || materialFreshnessPriority(b) - materialFreshnessPriority(a)
        || b.matchScore - a.matchScore;
      return delta || a.fileName.localeCompare(b.fileName);
    });

  const weakCanonical = materials
    .filter((material) => material.materialSourceRole === "canonical" && !isCanonicalBackboneMaterial(material))
    .sort((a, b) => {
      const delta = Number(b.preferred) - Number(a.preferred)
        || materialFreshnessPriority(b) - materialFreshnessPriority(a)
        || b.matchScore - a.matchScore;
      return delta || a.fileName.localeCompare(b.fileName);
    });

  const transcripts = materials
    .filter((material) => material.materialSourceRole === "transcript")
    .sort((a, b) => {
      const delta = Number(b.preferred) - Number(a.preferred)
        || transcriptPriority(b) - transcriptPriority(a)
        || materialFreshnessPriority(b) - materialFreshnessPriority(a)
        || b.matchScore - a.matchScore;
      return delta || a.fileName.localeCompare(b.fileName);
    });

  const canonicalPool =
    strongCanonical.length > 0 || transcripts.length > 0
      ? strongCanonical
      : weakCanonical;
  const selectedCanonical = canonicalPool.slice(0, caps.maxCanonical).map(stripRankFields);
  const selectedTranscript = transcripts
    .slice(0, selectedCanonical.length > 0 ? caps.maxTranscript : caps.transcriptOnlyMax)
    .map(stripRankFields);

  return {
    canonicalMaterials: selectedCanonical,
    transcriptMaterials: selectedTranscript,
  };
}

function stripRankFields(material: SelectionCandidate): EvidenceMaterial {
  const { matchScore, preferred, ...rest } = material;
  void matchScore;
  void preferred;
  return rest;
}

function collectWeekDeadlines(
  context: CourseContextSnapshot,
  now: Date,
): StructuralDeadlineEvidence[] {
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = addDays(weekStart, 6);
  return [...context.urgentAssignments, ...context.upcomingAssignments]
    .filter((assignment) => {
      const due = parseISO(assignment.dueDate);
      return isValid(due) && due >= weekStart && due <= weekEnd;
    })
    .map((assignment) => ({
      title: assignment.title,
      type: assignment.type,
      dueDate: assignment.dueDate,
      pointsPossible: assignment.pointsPossible,
      status: assignment.status,
    }));
}

function pickHighSalienceAssessment(deadlines: StructuralDeadlineEvidence[]): string | null {
  const highlighted = deadlines.find((deadline) =>
    REVIEW_SIGNAL_RX.test(`${deadline.title} ${deadline.type}`) ||
    deadline.type === "exam" ||
    deadline.type === "quiz"
  );
  return highlighted?.title ?? deadlines[0]?.title ?? null;
}

function buildWeeklyQuery(
  topics: string[],
  readings: string[],
  deadlines: StructuralDeadlineEvidence[],
  nextAssessmentTitle: string | null,
): string {
  const parts = dedupeStrings(
    [
      ...topics,
      ...readings,
      ...deadlines.map((deadline) => deadline.title),
      ...(nextAssessmentTitle ? [nextAssessmentTitle] : []),
    ],
    10
  );
  return parts.join(" | ");
}

function collectTranscriptSentences(materials: EvidenceMaterial[]): string[] {
  return materials.flatMap((material) =>
    material.summary
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => normalizeWhitespace(sentence))
      .filter(Boolean)
  );
}

export function buildTranscriptDigest(
  materials: Array<Pick<EvidenceMaterial, "fileName" | "summary" | "relatedTopics">>,
  structuralTerms: string[] = [],
): TranscriptDigest | null {
  if (materials.length === 0) return null;

  const structuralTokenSet = new Set(structuralTerms.flatMap((term) => tokenize(term)));
  const relatedTopics = materials.flatMap((material) => material.relatedTopics);
  const topicScores = new Map<string, number>();
  for (const topic of relatedTopics) {
    const normalized = normalizeWhitespace(topic);
    if (!normalized) continue;
    const score = tokenize(normalized).reduce(
      (sum, token) => sum + (structuralTokenSet.has(token) ? 3 : 1),
      0,
    );
    topicScores.set(normalized, Math.max(topicScores.get(normalized) ?? 0, score));
  }

  const emphasizedConcepts = [...topicScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([topic]) => topic);

  const sentences = collectTranscriptSentences(materials as EvidenceMaterial[]);
  const workedExamples = dedupeStrings(
    [
      ...materials
        .filter((material) => WORKED_EXAMPLE_RX.test(`${material.fileName} ${material.summary}`))
        .map((material) => material.summary),
      ...sentences.filter((sentence) => WORKED_EXAMPLE_RX.test(sentence)),
    ],
    3,
  );

  const reviewSignals = dedupeStrings(
    materials
      .flatMap((material) => [material.fileName, material.summary])
      .filter((value) => REVIEW_SIGNAL_RX.test(value)),
    3,
  );

  const clarifications = dedupeStrings(
    [
      ...materials
        .filter((material) => CLARIFICATION_RX.test(material.summary))
        .map((material) => material.summary),
      ...sentences.filter((sentence) => CLARIFICATION_RX.test(sentence)),
    ],
    3,
  );

  if (
    emphasizedConcepts.length === 0 &&
    workedExamples.length === 0 &&
    reviewSignals.length === 0 &&
    clarifications.length === 0
  ) {
    return null;
  }

  return {
    emphasizedConcepts,
    workedExamples,
    reviewSignals,
    clarifications,
  };
}

export function formatTranscriptDigest(digest: TranscriptDigest | null): string {
  if (!digest) return "";
  const parts: string[] = [];
  if (digest.emphasizedConcepts.length > 0) {
    parts.push(`Emphasized concepts: ${digest.emphasizedConcepts.join(", ")}`);
  }
  if (digest.workedExamples.length > 0) {
    parts.push(`Worked examples: ${digest.workedExamples.join(" | ")}`);
  }
  if (digest.reviewSignals.length > 0) {
    parts.push(`Review signals: ${digest.reviewSignals.join(" | ")}`);
  }
  if (digest.clarifications.length > 0) {
    parts.push(`Clarifications: ${digest.clarifications.join(" | ")}`);
  }
  return parts.join("\n");
}

function summarizeMaterial(material: EvidenceMaterial): string {
  const summary = normalizeWhitespace(material.summary);
  if (summary && summary !== "Unable to analyze document.") return summary;
  const topics = dedupeStrings(material.relatedTopics, 3);
  if (topics.length > 0) return `Related topics: ${topics.join(", ")}`;
  return material.fileName;
}

function formatMaterialLabel(material: Pick<EvidenceMaterial, "fileName" | "courseName">): string {
  return material.courseName ? `${material.courseName} — ${material.fileName}` : material.fileName;
}

function clipText(rawText: string, maxChars: number): string {
  return normalizeWhitespace(rawText).slice(0, maxChars);
}

function resolveCaps(overrides: Partial<SelectionCaps> | undefined, defaults: SelectionCaps): SelectionCaps {
  return {
    maxCanonical: overrides?.maxCanonical ?? defaults.maxCanonical,
    maxTranscript: overrides?.maxTranscript ?? defaults.maxTranscript,
    transcriptOnlyMax: overrides?.transcriptOnlyMax ?? defaults.transcriptOnlyMax,
  };
}

export async function resolveWeeklyEvidence({
  courseId,
  courseName,
  context,
  now = new Date(),
}: WeeklyEvidenceInput): Promise<ResolvedWeeklyEvidence> {
  const topics = context.currentWeek?.topics ?? [];
  const readings = context.currentWeek?.readings ?? [];
  const notes = context.currentWeek?.notes ?? null;
  const deadlines = collectWeekDeadlines(context, now);
  const nextAssessmentTitle = pickHighSalienceAssessment(deadlines);
  const query = buildWeeklyQuery(topics, readings, deadlines, nextAssessmentTitle);
  const semanticIds = query ? await searchMaterialIds(courseId, query, 8) : [];
  const semanticMaterials = semanticIds.length > 0 ? await fetchMaterialDetails(courseId, semanticIds) : [];
  const rankedMaterials = mergeRankedMaterials([], semanticMaterials);
  const selection = selectSourceAwareMaterials(rankedMaterials, DEFAULT_WEEKLY_CAPS);
  const transcriptDigest = buildTranscriptDigest(
    selection.transcriptMaterials,
    [context.currentWeek?.weekLabel ?? "", ...topics, ...readings, ...deadlines.map((deadline) => deadline.title)],
  );

  return {
    structuralContext: {
      courseId,
      courseName,
      weekLabel: context.currentWeek?.weekLabel ?? null,
      topics,
      readings,
      notes,
      deadlines,
      nextAssessmentTitle,
    },
    canonicalMaterials: selection.canonicalMaterials,
    transcriptMaterials: selection.transcriptMaterials,
    transcriptDigest,
  };
}

export async function resolveStudyEvidence({
  courseId,
  courseName = null,
  topicName = null,
  questionText = null,
  targetEvidence = null,
  materialIds,
  storedForAIOnly = false,
  selectionCaps,
}: StudyEvidenceInput): Promise<ResolvedStudyEvidence> {
  const caps = resolveCaps(selectionCaps, materialIds || storedForAIOnly ? DEFAULT_GENERATION_CAPS : DEFAULT_STUDY_CAPS);
  const lectureSpecific = questionText ? LECTURE_SPECIFIC_RX.test(questionText) : false;

  let rankedMaterials: SelectionCandidate[] = [];
  if (materialIds && materialIds.length > 0) {
    const selectedMaterials = await fetchMaterialDetails(courseId, materialIds, storedForAIOnly);
    rankedMaterials = selectedMaterials.map((material, index) => toEvidenceMaterial(material, 80 - index, true));
  } else if (storedForAIOnly) {
    const selectedMaterials = await fetchMaterialDetails(courseId, undefined, true);
    rankedMaterials = selectedMaterials.map((material, index) => toEvidenceMaterial(material, 60 - index, false));
  } else {
    const preferredIds = targetEvidence?.materials.map((material) => material.id) ?? [];
    const [preferredMaterials, semanticMaterials] = await Promise.all([
      preferredIds.length > 0 ? fetchMaterialDetails(courseId, preferredIds) : Promise.resolve([]),
      (async () => {
        const parts = [
          topicName ?? "",
          questionText ?? "",
          targetEvidence?.weekLabel ?? "",
          ...(targetEvidence?.readings ?? []),
          ...((targetEvidence?.candidates ?? []).map((candidate) => candidate.moduleName)),
        ].filter(Boolean);
        const query = dedupeStrings(parts, 12).join(" | ");
        if (!query) return [] as MaterialRecord[];
        const semanticIds = await searchMaterialIds(courseId, query, 8);
        return semanticIds.length > 0 ? fetchMaterialDetails(courseId, semanticIds) : [];
      })(),
    ]);

    rankedMaterials = mergeRankedMaterials(preferredMaterials, semanticMaterials);
  }

  const selection = selectSourceAwareMaterials(rankedMaterials, caps);
  const transcriptDigest = buildTranscriptDigest(
    selection.transcriptMaterials,
    [topicName ?? "", targetEvidence?.weekLabel ?? "", ...(targetEvidence?.readings ?? [])],
  );

  return {
    structuralContext: {
      courseId,
      courseName,
      topicName,
      weekLabel: targetEvidence?.weekLabel ?? null,
      readings: targetEvidence?.readings ?? [],
    },
    canonicalMaterials: selection.canonicalMaterials,
    transcriptMaterials: selection.transcriptMaterials,
    transcriptDigest,
    pendingCandidates: (targetEvidence?.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      fileName: candidate.fileName,
      moduleName: candidate.moduleName,
      requested: candidate.requested,
    })),
    lectureSpecific,
  };
}

export async function resolveCrossCourseStudyEvidence({
  userId,
  questionText = null,
  selectionCaps,
}: CrossCourseStudyEvidenceInput): Promise<ResolvedStudyEvidence> {
  const caps = resolveCaps(selectionCaps, DEFAULT_STUDY_CAPS);
  const lectureSpecific = questionText ? LECTURE_SPECIFIC_RX.test(questionText) : false;
  const semanticMaterials = questionText
    ? await (async () => {
        const semanticIds = await searchUserMaterialIds(userId, questionText, 10);
        return semanticIds.length > 0 ? fetchUserMaterialDetails(userId, semanticIds) : [];
      })()
    : [];
  const recentMaterials = lectureSpecific ? await fetchRecentUserMaterials(userId, 8) : [];
  const rankedMaterials = mergeRankedMaterials(recentMaterials, semanticMaterials);
  const selection = selectSourceAwareMaterials(rankedMaterials, caps);
  const transcriptDigest = buildTranscriptDigest(
    selection.transcriptMaterials,
    questionText ? [questionText] : [],
  );

  return {
    structuralContext: {
      courseId: "cross-course",
      courseName: null,
      topicName: lectureSpecific ? "Recent lecture coverage" : null,
      weekLabel: null,
      readings: [],
    },
    canonicalMaterials: selection.canonicalMaterials,
    transcriptMaterials: selection.transcriptMaterials,
    transcriptDigest,
    pendingCandidates: [],
    lectureSpecific,
  };
}

export function formatStudyEvidenceForPrompt(
  evidence: ResolvedStudyEvidence,
  options?: {
    canonicalExcerptChars?: number;
    transcriptExcerptChars?: number;
    transcriptOnlyChars?: number;
  },
): string {
  const canonicalExcerptChars = options?.canonicalExcerptChars ?? 850;
  const transcriptExcerptChars = options?.transcriptExcerptChars ?? 500;
  const transcriptOnlyChars = options?.transcriptOnlyChars ?? 1600;

  const sections: string[] = [];

  const structuralLines: string[] = [];
  if (evidence.structuralContext.topicName) {
    structuralLines.push(`Focus topic: ${evidence.structuralContext.topicName}`);
  }
  if (evidence.structuralContext.weekLabel) {
    structuralLines.push(`Anchor week: ${evidence.structuralContext.weekLabel}`);
  }
  if (evidence.structuralContext.readings.length > 0) {
    structuralLines.push(`Related readings: ${evidence.structuralContext.readings.join(", ")}`);
  }
  if (structuralLines.length > 0) {
    sections.push(
      "Structured context:\n" + structuralLines.map((line) => `- ${line}`).join("\n")
    );
  }

  if (evidence.lectureSpecific) {
    sections.push(
      "The student is asking specifically about lecture coverage or instructor emphasis. Transcript evidence may be primary for that part of the answer."
    );
  }

  if (evidence.canonicalMaterials.length > 0) {
    sections.push(
      "Canonical course content:\n" +
        evidence.canonicalMaterials
          .map((material) => {
            const excerpt = clipText(material.rawText, canonicalExcerptChars);
            return `- ${formatMaterialLabel(material)}\n  Summary: ${summarizeMaterial(material)}\n  Excerpt: ${excerpt}`;
          })
          .join("\n")
    );
  }

  if (evidence.transcriptMaterials.length > 0 || evidence.transcriptDigest) {
    const transcriptLines: string[] = [];
    const digestText = formatTranscriptDigest(evidence.transcriptDigest);
    if (digestText) transcriptLines.push(digestText);

    const transcriptChars =
      evidence.canonicalMaterials.length > 0 ? transcriptExcerptChars : transcriptOnlyChars;

    transcriptLines.push(
      ...evidence.transcriptMaterials.map((material) => {
        const excerpt = clipText(material.rawText, transcriptChars);
        return `- ${formatMaterialLabel(material)}\n  Summary: ${summarizeMaterial(material)}\n  Excerpt: ${excerpt}`;
      })
    );

    sections.push(
      "Lecture emphasis and review-session details:\n" + transcriptLines.join("\n")
    );
  }

  if (evidence.pendingCandidates.length > 0) {
    sections.push(
      "Relevant Canvas files exist for this topic, but their contents are not imported yet:\n" +
        evidence.pendingCandidates
          .slice(0, 5)
          .map((candidate) => `- ${candidate.fileName}`)
          .join("\n")
    );
  }

  if (sections.length === 0) {
    return "No imported course materials were found for this question. Be honest about that.";
  }

  sections.push(
    "Use canonical materials as the clean backbone when present. Use transcripts for instructor emphasis, clarifications, examples, and review-session details. Do not let transcript details override structured course facts."
  );

  return sections.join("\n\n");
}

export function formatGenerationEvidenceForPrompt(
  evidence: ResolvedStudyEvidence,
  kind: "quiz" | "flashcards",
): string {
  const canonicalCharBudget = kind === "quiz" ? 45_000 : 28_000;
  const transcriptCharBudget = kind === "quiz" ? 10_000 : 8_000;
  const transcriptOnlyBudget = kind === "quiz" ? 45_000 : 30_000;

  const sections: string[] = [];

  if (evidence.canonicalMaterials.length > 0) {
    let canonicalText = "";
    for (const material of evidence.canonicalMaterials) {
      if (canonicalText.length >= canonicalCharBudget) break;
      canonicalText += `\n\n--- ${formatMaterialLabel(material)} ---\n${material.rawText}`;
    }
    sections.push(`Canonical course content:\n${canonicalText.slice(0, canonicalCharBudget)}`);
  }

  if (evidence.transcriptMaterials.length > 0 || evidence.transcriptDigest) {
    const digestText = formatTranscriptDigest(evidence.transcriptDigest);
    let transcriptText = "";
    if (digestText) {
      transcriptText += `Transcript digest:\n${digestText}`;
    }

    if (evidence.canonicalMaterials.length > 0) {
      const transcriptSnippets: string[] = [];
      let remaining = transcriptCharBudget;
      for (const material of evidence.transcriptMaterials) {
        if (remaining <= 0) break;
        const body = clipText(material.rawText, Math.min(remaining, 1_200));
        const block = `--- ${formatMaterialLabel(material)} ---\nSummary: ${summarizeMaterial(material)}\nExcerpt: ${body}`;
        transcriptSnippets.push(block);
        remaining -= block.length + 2;
      }
      if (transcriptSnippets.length > 0) {
        transcriptText += `${transcriptText ? "\n\n" : ""}${transcriptSnippets.join("\n\n")}`;
      }
    } else {
      let transcriptBody = "";
      for (const material of evidence.transcriptMaterials) {
        if (transcriptBody.length >= transcriptOnlyBudget) break;
        transcriptBody += `\n\n--- ${formatMaterialLabel(material)} ---\n${material.rawText}`;
      }
      transcriptText += `${transcriptText ? "\n\n" : ""}${transcriptBody.slice(0, transcriptOnlyBudget)}`;
    }

    sections.push(`Lecture emphasis and review-session details:\n${transcriptText}`.trim());
  }

  sections.push(
    "Use canonical materials to define the main concept boundaries, terminology, and topic coverage. Use transcript materials to add instructor emphasis, examples, likely-tested nuances, and review-session details. If canonical materials are absent, use transcript materials fully rather than withholding value."
  );

  return sections.join("\n\n");
}

export function buildWeeklyEvidencePromptBlock(evidence: ResolvedWeeklyEvidence): string {
  const parts: string[] = [];

  if (evidence.canonicalMaterials.length > 0) {
    parts.push(
      `Canonical materials: ${evidence.canonicalMaterials
        .map((material) => `${formatMaterialLabel(material)} (${summarizeMaterial(material)})`)
        .join("; ")}`
    );
  }

  const digestText = formatTranscriptDigest(evidence.transcriptDigest);
  if (digestText) {
    parts.push(`Lecture emphasis:\n${digestText}`);
  } else if (evidence.transcriptMaterials.length > 0) {
    parts.push(
      `Transcript signals: ${evidence.transcriptMaterials
        .map((material) => summarizeMaterial(material))
        .join(" | ")}`
    );
  }

  return parts.join(" | ");
}

export function buildEvidenceFingerprintFragment(
  evidence: ResolvedWeeklyEvidence,
): Record<string, unknown> {
  return {
    canonicalMaterials: evidence.canonicalMaterials.map((material) => ({
      id: material.id,
      contentHash: material.contentHash,
      fileName: material.fileName,
    })),
    transcriptMaterials: evidence.transcriptMaterials.map((material) => ({
      id: material.id,
      contentHash: material.contentHash,
      fileName: material.fileName,
    })),
    transcriptDigest: evidence.transcriptDigest,
  };
}

export function formatWeekDeadlineForEvidence(deadline: DeadlineItem): string {
  const due = parseISO(deadline.dueDate);
  if (!isValid(due)) return deadline.title;
  return `${deadline.title} (${format(due, "MMM d")})`;
}
