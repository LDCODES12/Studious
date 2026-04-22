import { Prisma } from "@prisma/client";
import { addDays, addWeeks, differenceInCalendarDays, isValid, parseISO, startOfWeek } from "date-fns";
import { db } from "@/lib/db";
import { inferMaterialSourceRole, type MaterialAnalysis } from "@/lib/analyze-material";
import { hashMaterialText, normalizeSourceUpdatedAt } from "@/lib/material-sync";
import {
  classScheduleProbe,
  deriveCandidateStatus,
  hasUsefulMeetingTimes,
  htmlToText,
  materialStateKey,
  normalizeScheduleForTerm,
} from "@/lib/canvas-sync/import-support";
import {
  bestWindow,
  extractClassSchedule,
  extractScheduleFromCalendarEvents,
  parseSyllabusText,
  parseSyllabusTopics,
  scheduleScore,
  type ExtractedClassSchedule,
  type ParsedTopic,
} from "@/lib/parse-syllabus";
import { ensureEvidenceChunks } from "@/lib/course-corpus/evidence-chunks";
import { extractCourseEvidenceHints } from "@/lib/course-corpus/hints";
import type {
  CorpusWeekBucket,
  CourseEvidenceHints,
  CourseEvidenceSourceKind,
  EvidenceIngestInput,
  EvidencePlacementKind,
  EvidenceProvenanceEntry,
  PlacementDecision,
  ProjectedMaterialRecord,
} from "@/lib/course-corpus/types";

interface SyllabusText {
  fileName: string;
  text: string;
  sourceKey?: string | null;
  sourceKind?: string | null;
  remoteUpdatedAt?: string | null;
  remoteSize?: number | null;
}

interface MaterialCandidate {
  fileName: string;
  moduleName: string;
  contentId: string;
  sourceKind?: string | null;
  remoteUpdatedAt?: string | null;
  remoteSize?: number | null;
}

interface CanvasCourseSyncInput {
  id: number;
  name: string;
  term?: string | null;
  syllabusBody?: string | null;
  syllabusTexts?: SyllabusText[];
  materialTexts?: SyllabusText[];
  pageTexts?: SyllabusText[];
  materialCandidates?: MaterialCandidate[];
  termStartAt?: string | null;
  termEndAt?: string | null;
  calendarEvents?: { title: string; startAt: string; endAt: string; location: string | null }[];
}

interface CanvasAssignmentSyncInput {
  id: number;
  courseId: number;
  title: string;
  dueDate: string | null;
  availableFrom?: string | null;
  availableUntil?: string | null;
  description: string | null;
  submissionType: string;
  submissionTypes?: string[];
  gradingType?: string | null;
  omitFromFinalGrade?: boolean;
  htmlUrl: string | null;
  pointsPossible: number | null;
  submissionStatus?: string | null;
  score?: number | null;
  submittedAt?: string | null;
  excused?: boolean;
  late?: boolean;
  missing?: boolean;
  assignmentGroupId?: number | null;
}

interface CanvasModuleSyncInput {
  courseId: number;
  moduleId: number;
  position: number;
  name: string;
  topics: string[];
  readings: string[];
}

interface CanvasAnnouncementSyncInput {
  courseId: number;
  canvasId: string;
  title: string;
  body: string | null;
  postedAt: string | null;
}

export interface LoadedEvidence {
  id: string;
  courseId: string;
  sourceKind: CourseEvidenceSourceKind | string;
  sourceKey: string;
  title: string;
  bodyText: string | null;
  structuredPayload: Record<string, unknown> | null;
  provenance: EvidenceProvenanceEntry[];
  capturedAt: Date;
  remoteUpdatedAt: Date | null;
  contentHash: string | null;
  derivedHints: CourseEvidenceHints;
}

interface BucketSelectionMeta {
  labelPriority: number;
  diagnostics: string[];
}

interface WeekPlacementContext {
  buckets: CorpusWeekBucket[];
  meetingsPerWeek: number;
  hasNonAnnouncementScheduleEvidence: boolean;
}

export interface CorpusProjectionResult {
  termRange: { startDate: string; endDate: string };
  placementDecisions: PlacementDecision[];
  finalPlacements: PlacementDecision[];
  finalBuckets: CorpusWeekBucket[];
  projectedMaterials: ProjectedMaterialRecord[];
}

interface RebuildCourseCorpusInput {
  courseId: string;
  courseName: string;
  termStartAt?: string | null;
  termEndAt?: string | null;
  calendarEvents?: { title: string; startAt: string; endAt: string; location: string | null }[];
}

export interface CanvasCourseCorpusSyncInput extends RebuildCourseCorpusInput {
  course: CanvasCourseSyncInput;
  assignments: CanvasAssignmentSyncInput[];
  modules: CanvasModuleSyncInput[];
  announcements: CanvasAnnouncementSyncInput[];
}

const CANONICAL_CONTENT_TYPES = new Set<MaterialAnalysis["detectedType"]>([
  "lecture_notes",
  "lecture_slides",
  "textbook",
  "problem_set",
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTextBody(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function tryParseIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = parseISO(value);
  if (!isValid(parsed)) return null;
  return parsed.toISOString().slice(0, 10);
}

function tryParseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim().toLowerCase();
  }
}

function slugify(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value ?? "");
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function evidenceKindPriority(kind: string): number {
  switch (kind) {
    case "canvas_syllabus_pdf":
      return 8;
    case "canvas_syllabus_page":
      return 7;
    case "canvas_linked_file":
      return 6;
    case "canvas_media_transcript":
      return 5;
    case "canvas_page":
      return 4;
    case "canvas_module_item":
      return 3;
    case "canvas_assignment":
      return 2;
    case "canvas_calendar_event":
      return 2;
    case "canvas_announcement":
      return 1;
    default:
      return 0;
  }
}

function provenanceFingerprint(entry: EvidenceProvenanceEntry): string {
  return [
    entry.discoveredVia,
    entry.rawSourceKind,
    entry.sourceKey ?? "",
    entry.remoteId ?? "",
    entry.sourceUrl ?? "",
    entry.moduleName ?? "",
    entry.pageName ?? "",
    entry.fileName ?? "",
    entry.label ?? "",
  ].join("|");
}

function mergeProvenance(
  existing: EvidenceProvenanceEntry[],
  incoming: EvidenceProvenanceEntry,
): EvidenceProvenanceEntry[] {
  const merged = [...existing];
  const fingerprint = provenanceFingerprint(incoming);
  if (!merged.some((entry) => provenanceFingerprint(entry) === fingerprint)) {
    merged.push(incoming);
  }
  return merged;
}

function ensureHints(value: unknown): CourseEvidenceHints {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      roles: [],
      dateMentions: [],
      weekNumbers: [],
      lectureNumbers: [],
      unitNumbers: [],
      breakSignals: [],
      noClassSignals: [],
      sourceRoleSignals: [],
    };
  }

  const raw = value as Partial<CourseEvidenceHints>;
  return {
    roles: Array.isArray(raw.roles) ? raw.roles.filter((item): item is CourseEvidenceHints["roles"][number] => typeof item === "string") : [],
    dateMentions: Array.isArray(raw.dateMentions)
      ? raw.dateMentions
          .filter((item): item is CourseEvidenceHints["dateMentions"][number] => !!item && typeof item === "object")
          .map((item) => ({
            raw: typeof item.raw === "string" ? item.raw : "",
            isoDate: typeof item.isoDate === "string" ? item.isoDate : null,
          }))
          .filter((item) => item.raw.length > 0)
      : [],
    weekNumbers: Array.isArray(raw.weekNumbers) ? raw.weekNumbers.filter((item): item is number => typeof item === "number") : [],
    lectureNumbers: Array.isArray(raw.lectureNumbers) ? raw.lectureNumbers.filter((item): item is number => typeof item === "number") : [],
    unitNumbers: Array.isArray(raw.unitNumbers) ? raw.unitNumbers.filter((item): item is number => typeof item === "number") : [],
    breakSignals: Array.isArray(raw.breakSignals) ? raw.breakSignals.filter((item): item is string => typeof item === "string") : [],
    noClassSignals: Array.isArray(raw.noClassSignals) ? raw.noClassSignals.filter((item): item is string => typeof item === "string") : [],
    sourceRoleSignals: Array.isArray(raw.sourceRoleSignals) ? raw.sourceRoleSignals.filter((item): item is string => typeof item === "string") : [],
  };
}

function mergeHints(existing: CourseEvidenceHints, incoming: CourseEvidenceHints): CourseEvidenceHints {
  const dateMentions = [...existing.dateMentions, ...incoming.dateMentions].filter((hint, index, all) => {
    const key = `${hint.raw.toLowerCase()}:${hint.isoDate ?? "none"}`;
    return all.findIndex((other) => `${other.raw.toLowerCase()}:${other.isoDate ?? "none"}` === key) === index;
  });
  return {
    roles: uniqueStrings([...existing.roles, ...incoming.roles]) as CourseEvidenceHints["roles"],
    dateMentions,
    weekNumbers: [...new Set([...existing.weekNumbers, ...incoming.weekNumbers])].sort((a, b) => a - b),
    lectureNumbers: [...new Set([...existing.lectureNumbers, ...incoming.lectureNumbers])].sort((a, b) => a - b),
    unitNumbers: [...new Set([...existing.unitNumbers, ...incoming.unitNumbers])].sort((a, b) => a - b),
    breakSignals: uniqueStrings([...existing.breakSignals, ...incoming.breakSignals]),
    noClassSignals: uniqueStrings([...existing.noClassSignals, ...incoming.noClassSignals]),
    sourceRoleSignals: uniqueStrings([...existing.sourceRoleSignals, ...incoming.sourceRoleSignals]),
  };
}

function normalizeFileSourceKey(rawSourceKey: string | null | undefined, title: string, contentHash: string | null): string {
  const candidate = normalizeWhitespace(rawSourceKey ?? "");
  if (candidate) {
    if (looksLikeUrl(candidate)) return `url:${normalizeUrl(candidate)}`;
    return `canvas-file:${candidate}`;
  }
  if (contentHash) return `hash:${contentHash}`;
  return `title:${slugify(title)}`;
}

function deriveCanonicalSourceKey(args: {
  rawSourceKind: string;
  rawSourceKey?: string | null;
  title: string;
  contentHash: string | null;
  announcedId?: string | null;
  calendarSeed?: string | null;
}): string {
  const rawSourceKey = normalizeWhitespace(args.rawSourceKey ?? "");
  switch (args.rawSourceKind) {
    case "manual_upload":
      return `manual-upload:${rawSourceKey || args.contentHash || slugify(args.title)}`;
    case "auto_route":
      return `auto-route:${rawSourceKey || args.contentHash || slugify(args.title)}`;
    case "canvas_syllabus_page":
      return `canvas-syllabus-page:${rawSourceKey || "syllabus-body"}`;
    case "canvas_page":
      return `canvas-page:${rawSourceKey || slugify(args.title)}`;
    case "canvas_announcement":
      return `canvas-announcement:${args.announcedId || rawSourceKey || slugify(args.title)}`;
    case "canvas_media":
      return `canvas-media:${rawSourceKey || args.contentHash || slugify(args.title)}`;
    case "canvas_assignment":
      return `canvas-assignment:${rawSourceKey || slugify(args.title)}`;
    case "canvas_calendar_event":
      return `canvas-calendar:${args.calendarSeed || rawSourceKey || hashMaterialText(args.title).slice(0, 16)}`;
    case "canvas_module_item":
      return `canvas-module:${rawSourceKey || slugify(args.title)}`;
    default:
      return normalizeFileSourceKey(rawSourceKey, args.title, args.contentHash);
  }
}

function inferEvidenceSourceKind(args: {
  rawSourceKind: string;
  title: string;
  bodyText: string | null;
  hints: CourseEvidenceHints;
}): CourseEvidenceSourceKind {
  const title = `${args.title}\n${args.bodyText ?? ""}`;
  switch (args.rawSourceKind) {
    case "canvas_syllabus_page":
      return "canvas_syllabus_page";
    case "canvas_page":
      return "canvas_page";
    case "canvas_announcement":
      return "canvas_announcement";
    case "canvas_media":
      return "canvas_media_transcript";
    case "canvas_assignment":
      return "canvas_assignment";
    case "canvas_calendar_event":
      return "canvas_calendar_event";
    case "canvas_module_item":
      return "canvas_module_item";
    case "manual_upload":
      return "manual_upload";
    case "auto_route":
      return "auto_route";
    default:
      if (
        /\bsyllab|course schedule|course calendar\b/i.test(title) ||
        (args.hints.roles.includes("schedule_like") && /\b(week|lecture|schedule|calendar)\b/i.test(title))
      ) {
        return "canvas_syllabus_pdf";
      }
      return "canvas_linked_file";
  }
}

function chooseSourceKind(existingKind: string, incomingKind: string): string {
  return evidenceKindPriority(incomingKind) > evidenceKindPriority(existingKind)
    ? incomingKind
    : existingKind;
}

function parseStructuredPayload(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseProvenance(value: Prisma.JsonValue): EvidenceProvenanceEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : null;
      return {
        discoveredVia: typeof record?.discoveredVia === "string" ? record.discoveredVia : "unknown",
        rawSourceKind: typeof record?.rawSourceKind === "string" ? record.rawSourceKind : "unknown",
        sourceKey: typeof record?.sourceKey === "string" ? record.sourceKey : null,
        remoteId: typeof record?.remoteId === "string" ? record.remoteId : null,
        sourceUrl: typeof record?.sourceUrl === "string" ? record.sourceUrl : null,
        moduleName: typeof record?.moduleName === "string" ? record.moduleName : null,
        pageName: typeof record?.pageName === "string" ? record.pageName : null,
        fileName: typeof record?.fileName === "string" ? record.fileName : null,
        label: typeof record?.label === "string" ? record.label : null,
        capturedAt: typeof record?.capturedAt === "string" ? record.capturedAt : new Date().toISOString(),
      };
    });
}

function mergeStructuredPayload(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!existing && !incoming) return null;
  return {
    ...(existing ?? {}),
    ...(incoming ?? {}),
  };
}

function preferIncomingText(existingText: string | null, incomingText: string | null, existingRemoteUpdatedAt: Date | null, incomingRemoteUpdatedAt: Date | null): boolean {
  if (incomingText && !existingText) return true;
  if (!incomingText) return false;
  if (!existingText) return true;
  if (incomingText.length > existingText.length + 200) return true;
  if (incomingRemoteUpdatedAt && (!existingRemoteUpdatedAt || incomingRemoteUpdatedAt > existingRemoteUpdatedAt)) {
    return true;
  }
  return false;
}

async function upsertCourseEvidence(input: EvidenceIngestInput) {
  const existing = await db.courseEvidence.findUnique({
    where: {
      courseId_sourceKey: {
        courseId: input.courseId,
        sourceKey: input.sourceKey,
      },
    },
    select: {
      id: true,
      sourceKind: true,
      title: true,
      bodyText: true,
      structuredPayload: true,
      provenance: true,
      remoteUpdatedAt: true,
      contentHash: true,
      derivedHints: true,
    },
  });

  const incomingRemoteUpdatedAt = normalizeSourceUpdatedAt(input.remoteUpdatedAt);

  if (!existing) {
    return db.courseEvidence.create({
      data: {
        courseId: input.courseId,
        sourceKind: input.sourceKind,
        sourceKey: input.sourceKey,
        title: input.title,
        bodyText: input.bodyText,
        structuredPayload: input.structuredPayload
          ? input.structuredPayload as Prisma.InputJsonValue
          : Prisma.JsonNull,
        provenance: [input.provenanceEntry] as unknown as Prisma.InputJsonValue,
        capturedAt: new Date(),
        remoteUpdatedAt: incomingRemoteUpdatedAt,
        contentHash: input.contentHash ?? null,
        derivedHints: input.derivedHints as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, courseId: true, sourceKey: true, bodyText: true, contentHash: true },
    });
  }

  const existingHints = ensureHints(existing.derivedHints);
  const mergedHints = mergeHints(existingHints, input.derivedHints);
  const existingStructuredPayload = parseStructuredPayload(existing.structuredPayload);
  const mergedPayload = mergeStructuredPayload(existingStructuredPayload, input.structuredPayload);
  const mergedProvenance = mergeProvenance(parseProvenance(existing.provenance), input.provenanceEntry);
  const existingRemoteUpdatedAt = existing.remoteUpdatedAt;
  const chosenIncomingText = preferIncomingText(existing.bodyText, input.bodyText, existingRemoteUpdatedAt, incomingRemoteUpdatedAt)
    ? input.bodyText
    : existing.bodyText;
  const nextRemoteUpdatedAt = incomingRemoteUpdatedAt && (!existingRemoteUpdatedAt || incomingRemoteUpdatedAt > existingRemoteUpdatedAt)
    ? incomingRemoteUpdatedAt
    : existingRemoteUpdatedAt;

  return db.courseEvidence.update({
    where: { id: existing.id },
    data: {
      sourceKind: chooseSourceKind(existing.sourceKind, input.sourceKind),
      title: input.title.length > existing.title.length ? input.title : existing.title,
      bodyText: chosenIncomingText,
      structuredPayload: mergedPayload
        ? mergedPayload as Prisma.InputJsonValue
        : Prisma.JsonNull,
      provenance: mergedProvenance as unknown as Prisma.InputJsonValue,
      capturedAt: new Date(),
      remoteUpdatedAt: nextRemoteUpdatedAt,
      contentHash: chosenIncomingText === input.bodyText ? input.contentHash ?? existing.contentHash : existing.contentHash,
      derivedHints: mergedHints as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, courseId: true, sourceKey: true, bodyText: true, contentHash: true },
  });
}

function decodeAnnouncementBody(body: string | null): string {
  return (body ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEvidenceInput(args: {
  courseId: string;
  rawSourceKind: string;
  rawSourceKey?: string | null;
  title: string;
  bodyText?: string | null;
  structuredPayload?: Record<string, unknown> | null;
  remoteUpdatedAt?: string | Date | null;
  discoveredVia: string;
  sourceUrl?: string | null;
  moduleName?: string | null;
  pageName?: string | null;
  remoteId?: string | null;
  label?: string | null;
  calendarSeed?: string | null;
}): EvidenceIngestInput {
  const normalizedBodyText = normalizeTextBody(args.bodyText);
  const contentHash = normalizedBodyText ? hashMaterialText(normalizedBodyText) : null;
  const hints = extractCourseEvidenceHints({
    sourceKind: inferEvidenceSourceKind({
      rawSourceKind: args.rawSourceKind,
      title: args.title,
      bodyText: normalizedBodyText,
      hints: {
        roles: [],
        dateMentions: [],
        weekNumbers: [],
        lectureNumbers: [],
        unitNumbers: [],
        breakSignals: [],
        noClassSignals: [],
        sourceRoleSignals: [],
      },
    }),
    title: args.title,
    bodyText: normalizedBodyText,
    structuredPayload: args.structuredPayload ?? null,
    remoteUpdatedAt: args.remoteUpdatedAt ?? null,
  });
  const sourceKind = inferEvidenceSourceKind({
    rawSourceKind: args.rawSourceKind,
    title: args.title,
    bodyText: normalizedBodyText,
    hints,
  });
  const sourceKey = deriveCanonicalSourceKey({
    rawSourceKind: args.rawSourceKind,
    rawSourceKey: args.rawSourceKey,
    title: args.title,
    contentHash,
    announcedId: args.remoteId ?? null,
    calendarSeed: args.calendarSeed ?? null,
  });
  return {
    courseId: args.courseId,
    sourceKind,
    sourceKey,
    title: args.title,
    bodyText: normalizedBodyText,
    structuredPayload: args.structuredPayload ?? null,
    provenanceEntry: {
      discoveredVia: args.discoveredVia,
      rawSourceKind: args.rawSourceKind,
      sourceKey: args.rawSourceKey ?? null,
      remoteId: args.remoteId ?? null,
      sourceUrl: args.sourceUrl ?? null,
      moduleName: args.moduleName ?? null,
      pageName: args.pageName ?? null,
      fileName: args.title,
      label: args.label ?? null,
      capturedAt: new Date().toISOString(),
    },
    remoteUpdatedAt: args.remoteUpdatedAt ?? null,
    contentHash,
    derivedHints: hints,
  };
}

async function ingestCanvasCourseEvidence(input: CanvasCourseCorpusSyncInput): Promise<void> {
  const { courseId, course, assignments, modules, announcements } = input;
  const evidenceInputs: EvidenceIngestInput[] = [];

  if (course.syllabusBody?.trim()) {
    const bodyText = htmlToText(course.syllabusBody);
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: "canvas_syllabus_page",
        rawSourceKey: "syllabus-body",
        title: "Canvas syllabus page",
        bodyText,
        structuredPayload: {
          courseName: course.name,
          term: course.term ?? null,
        },
        discoveredVia: "syllabus tab",
      }),
    );
  }

  for (const textEntry of course.syllabusTexts ?? []) {
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: textEntry.sourceKind ?? "canvas_syllabus",
        rawSourceKey: textEntry.sourceKey ?? null,
        title: textEntry.fileName,
        bodyText: normalizeTextBody(textEntry.text),
        structuredPayload: {
          remoteSize: textEntry.remoteSize ?? null,
        },
        remoteUpdatedAt: textEntry.remoteUpdatedAt ?? null,
        discoveredVia: "syllabus pdf",
      }),
    );
  }

  for (const textEntry of course.materialTexts ?? []) {
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: textEntry.sourceKind ?? "canvas_module",
        rawSourceKey: textEntry.sourceKey ?? null,
        title: textEntry.fileName,
        bodyText: normalizeTextBody(textEntry.text),
        structuredPayload: {
          remoteSize: textEntry.remoteSize ?? null,
        },
        remoteUpdatedAt: textEntry.remoteUpdatedAt ?? null,
        discoveredVia: (textEntry.sourceKind ?? "canvas_module") === "canvas_media" ? "media gallery" : "module file",
      }),
    );
  }

  for (const pageText of course.pageTexts ?? []) {
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: "canvas_page",
        rawSourceKey: pageText.sourceKey ?? null,
        title: pageText.fileName,
        bodyText: normalizeTextBody(pageText.text),
        structuredPayload: {
          remoteSize: pageText.remoteSize ?? null,
        },
        remoteUpdatedAt: pageText.remoteUpdatedAt ?? null,
        discoveredVia: "module page",
        pageName: pageText.fileName,
      }),
    );
  }

  for (const candidate of course.materialCandidates ?? []) {
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: candidate.sourceKind ?? "canvas_module",
        rawSourceKey: candidate.contentId,
        title: candidate.fileName,
        bodyText: null,
        structuredPayload: {
          remoteSize: candidate.remoteSize ?? null,
          moduleName: candidate.moduleName,
        },
        remoteUpdatedAt: candidate.remoteUpdatedAt ?? null,
        discoveredVia: "module file candidate",
        moduleName: candidate.moduleName,
      }),
    );
  }

  for (const courseModule of modules) {
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: "canvas_module_item",
        rawSourceKey: String(courseModule.moduleId),
        title: courseModule.name,
        bodyText: normalizeWhitespace([...courseModule.topics, ...courseModule.readings].join("\n")),
        structuredPayload: {
          moduleId: courseModule.moduleId,
          modulePosition: courseModule.position,
          topics: courseModule.topics,
          readings: courseModule.readings,
        },
        discoveredVia: "module list",
        moduleName: courseModule.name,
        remoteId: String(courseModule.moduleId),
      }),
    );
  }

  for (const announcement of announcements) {
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: "canvas_announcement",
        rawSourceKey: announcement.canvasId,
        title: announcement.title,
        bodyText: decodeAnnouncementBody(announcement.body),
        structuredPayload: {
          postedAt: announcement.postedAt,
        },
        remoteUpdatedAt: announcement.postedAt ?? null,
        discoveredVia: "announcement feed",
        remoteId: announcement.canvasId,
      }),
    );
  }

  for (const assignment of assignments) {
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: "canvas_assignment",
        rawSourceKey: String(assignment.id),
        title: assignment.title,
        bodyText: assignment.description?.replace(/<[^>]+>/g, " ") ?? null,
        structuredPayload: {
          dueDate: assignment.dueDate,
          availableFrom: assignment.availableFrom ?? null,
          availableUntil: assignment.availableUntil ?? null,
          submissionType: assignment.submissionType,
          submissionTypes: assignment.submissionTypes ?? [],
          gradingType: assignment.gradingType ?? null,
          pointsPossible: assignment.pointsPossible ?? null,
          htmlUrl: assignment.htmlUrl ?? null,
          status: assignment.submissionStatus ?? "not_started",
        },
        remoteUpdatedAt: assignment.dueDate ?? null,
        discoveredVia: "assignment list",
        sourceUrl: assignment.htmlUrl ?? null,
        remoteId: String(assignment.id),
      }),
    );
  }

  for (const calendarEvent of course.calendarEvents ?? []) {
    evidenceInputs.push(
      buildEvidenceInput({
        courseId,
        rawSourceKind: "canvas_calendar_event",
        title: calendarEvent.title,
        bodyText: null,
        structuredPayload: {
          startAt: calendarEvent.startAt,
          endAt: calendarEvent.endAt,
          location: calendarEvent.location ?? null,
        },
        remoteUpdatedAt: calendarEvent.startAt,
        discoveredVia: "calendar feed",
        calendarSeed: `${calendarEvent.title}|${calendarEvent.startAt}|${calendarEvent.endAt}`,
      }),
    );
  }

  const touched = new Set<string>();
  for (const evidenceInput of evidenceInputs) {
    const evidence = await upsertCourseEvidence(evidenceInput);
    touched.add(evidence.id);
    if (evidence.bodyText && evidence.contentHash) {
      await ensureEvidenceChunks({
        evidenceId: evidence.id,
        courseId: evidence.courseId,
        text: evidence.bodyText,
        contentHash: evidence.contentHash,
      }).catch(() => undefined);
    }
  }
}

async function loadCourseEvidence(courseId: string): Promise<LoadedEvidence[]> {
  const rows = await db.courseEvidence.findMany({
    where: { courseId },
    orderBy: [{ remoteUpdatedAt: "desc" }, { capturedAt: "desc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    courseId: row.courseId,
    sourceKind: row.sourceKind,
    sourceKey: row.sourceKey,
    title: row.title,
    bodyText: row.bodyText,
    structuredPayload: parseStructuredPayload(row.structuredPayload),
    provenance: parseProvenance(row.provenance),
    capturedAt: row.capturedAt,
    remoteUpdatedAt: row.remoteUpdatedAt,
    contentHash: row.contentHash,
    derivedHints: ensureHints(row.derivedHints),
  }));
}

function getEvidenceDateSet(evidence: LoadedEvidence[]): string[] {
  return evidence
    .flatMap((item) => item.derivedHints.dateMentions.map((hint) => hint.isoDate).filter((value): value is string => Boolean(value)))
    .sort();
}

function deriveTermRange(args: {
  termStartAt?: string | null;
  termEndAt?: string | null;
  classSchedule: ExtractedClassSchedule | null;
  evidence: LoadedEvidence[];
}): { startDate: string; endDate: string } {
  const explicitStart = tryParseIsoDate(args.termStartAt)
    ?? args.classSchedule?.semesterStart
    ?? null;
  const explicitEnd = tryParseIsoDate(args.termEndAt)
    ?? args.classSchedule?.semesterEnd
    ?? args.classSchedule?.finalExamDate
    ?? null;

  const evidenceDates = getEvidenceDateSet(args.evidence);
  const fallbackStart = evidenceDates[0] ?? new Date().toISOString().slice(0, 10);
  const fallbackEnd = evidenceDates[evidenceDates.length - 1] ?? addDays(parseISO(fallbackStart), 98).toISOString().slice(0, 10);

  const startDate = explicitStart ?? fallbackStart;
  const endDate = explicitEnd ?? fallbackEnd;

  if (differenceInCalendarDays(parseISO(endDate), parseISO(startDate)) < 35) {
    return {
      startDate,
      endDate: addDays(parseISO(startDate), 98).toISOString().slice(0, 10),
    };
  }

  return { startDate, endDate };
}

function buildEmptyWeekBuckets(startDate: string, endDate: string): CorpusWeekBucket[] {
  const buckets: CorpusWeekBucket[] = [];
  let cursor = startOfWeek(parseISO(startDate), { weekStartsOn: 1 });
  const end = startOfWeek(parseISO(endDate), { weekStartsOn: 1 });

  while (cursor <= end) {
    buckets.push({
      weekNumber: buckets.length + 1,
      weekLabel: `Week ${buckets.length + 1}`,
      startDate: cursor.toISOString().slice(0, 10),
      placementKind: "instructional_week",
      sourceEvidenceIds: [],
      eventEvidenceIds: [],
      topics: [],
      readings: [],
      notes: [],
    });
    cursor = addWeeks(cursor, 1);
    if (buckets.length > 24) break;
  }

  return buckets;
}

function bucketIndexForDate(buckets: CorpusWeekBucket[], isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  const parsed = parseISO(isoDate);
  if (!isValid(parsed)) return null;
  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index];
    if (!bucket.startDate) continue;
    const bucketStart = parseISO(bucket.startDate);
    const bucketEnd = addDays(bucketStart, 7);
    if (parsed >= bucketStart && parsed < bucketEnd) return index;
  }
  return null;
}

function bucketIndexForWeekNumber(buckets: CorpusWeekBucket[], weekNumber: number | null | undefined): number | null {
  if (!weekNumber || weekNumber <= 0) return null;
  if (weekNumber > buckets.length) return null;
  return weekNumber - 1;
}

function inferMeetingsPerWeek(classSchedule: ExtractedClassSchedule | null, calendarEvents: RebuildCourseCorpusInput["calendarEvents"]): number {
  const scheduleMeetings = classSchedule?.meetings?.flatMap((meeting) => meeting.days ?? []).length ?? 0;
  if (scheduleMeetings > 0) return Math.min(Math.max(scheduleMeetings, 1), 5);

  const eventWeekdays = new Set<number>();
  for (const event of calendarEvents ?? []) {
    const start = tryParseDate(event.startAt);
    if (start) eventWeekdays.add(start.getUTCDay());
  }
  return Math.min(Math.max(eventWeekdays.size, 1), 5);
}

async function deriveClassSchedule(args: RebuildCourseCorpusInput & { evidence: LoadedEvidence[] }): Promise<{
  classSchedule: ExtractedClassSchedule | null;
  classScheduleSource: string;
}> {
  const scheduleCandidates = args.evidence
    .filter((item) => item.bodyText && item.derivedHints.roles.includes("schedule_like"))
    .sort((a, b) => {
      const scoreDelta = evidenceKindPriority(b.sourceKind) - evidenceKindPriority(a.sourceKind);
      if (scoreDelta !== 0) return scoreDelta;
      return (scheduleScore(bestWindow(b.bodyText ?? "")) - scheduleScore(bestWindow(a.bodyText ?? "")));
    })
    .slice(0, 3);

  let syllabusClassSchedule: ExtractedClassSchedule | null = null;
  let classScheduleSource = "none";
  for (const candidate of scheduleCandidates) {
    if (!candidate.bodyText || candidate.bodyText.length < 120) continue;
    const probe = classScheduleProbe(candidate.bodyText);
    if (!probe.hasDayNames && !probe.hasCompactDays && !probe.hasTimeRange && candidate.sourceKind !== "canvas_syllabus_page") {
      continue;
    }
    const extracted = await extractClassSchedule(candidate.bodyText).catch(() => null);
    if (extracted) {
      syllabusClassSchedule = extracted;
      classScheduleSource = candidate.title;
      break;
    }
  }

  const calendarSchedule = (args.calendarEvents?.length ?? 0) > 0
    ? extractScheduleFromCalendarEvents(args.calendarEvents ?? [], args.termStartAt ?? null, args.termEndAt ?? null)
    : null;

  const normalizedSyllabusSchedule = normalizeScheduleForTerm(
    syllabusClassSchedule,
    args.termStartAt ?? null,
    args.termEndAt ?? null,
  );
  const normalizedCalendarSchedule = normalizeScheduleForTerm(
    calendarSchedule,
    args.termStartAt ?? null,
    args.termEndAt ?? null,
  );

  if (normalizedSyllabusSchedule && hasUsefulMeetingTimes(normalizedSyllabusSchedule)) {
    return { classSchedule: normalizedSyllabusSchedule, classScheduleSource };
  }
  if (normalizedCalendarSchedule) {
    return { classSchedule: normalizedCalendarSchedule, classScheduleSource: `calendar(${args.calendarEvents?.length ?? 0})` };
  }
  if (normalizedSyllabusSchedule) {
    return { classSchedule: normalizedSyllabusSchedule, classScheduleSource };
  }
  return { classSchedule: null, classScheduleSource: "none" };
}

async function deriveSyllabusEvents(evidence: LoadedEvidence[]): Promise<Array<{ title: string; dueDate: string; type: string }>> {
  const sources = evidence
    .filter((item) =>
      item.bodyText &&
      item.bodyText.length >= 500 &&
      (item.sourceKind === "canvas_syllabus_pdf" || item.sourceKind === "canvas_syllabus_page"),
    )
    .sort((a, b) => evidenceKindPriority(b.sourceKind) - evidenceKindPriority(a.sourceKind))
    .slice(0, 2);

  const merged = new Map<string, { title: string; dueDate: string; type: string }>();
  for (const source of sources) {
    const events = await parseSyllabusText(source.bodyText ?? "").catch(() => []);
    for (const event of events) {
      const key = `${event.title.toLowerCase()}|${event.dueDate}`;
      if (!merged.has(key)) {
        merged.set(key, {
          title: event.title,
          dueDate: event.dueDate,
          type: event.type,
        });
      }
    }
  }
  return [...merged.values()];
}

async function deriveParsedScheduleWeeks(args: { courseName: string; evidence: LoadedEvidence[] }): Promise<Array<{ evidenceId: string; weeks: ParsedTopic[] }>> {
  const scheduleSources = args.evidence
    .filter((item) =>
      item.bodyText &&
      item.bodyText.length >= 250 &&
      item.derivedHints.roles.includes("schedule_like") &&
      item.sourceKind !== "canvas_announcement" &&
      item.sourceKind !== "canvas_assignment" &&
      item.sourceKind !== "canvas_calendar_event",
    )
    .sort((a, b) => {
      const priority = evidenceKindPriority(b.sourceKind) - evidenceKindPriority(a.sourceKind);
      if (priority !== 0) return priority;
      return scheduleScore(bestWindow(b.bodyText ?? "")) - scheduleScore(bestWindow(a.bodyText ?? ""));
    })
    .slice(0, 3);

  const parsed: Array<{ evidenceId: string; weeks: ParsedTopic[] }> = [];
  for (const source of scheduleSources) {
    const text = bestWindow(source.bodyText ?? "");
    if (text.length < 200) continue;
    const weeks = await parseSyllabusTopics(text, args.courseName, "low").catch(() => []);
    if (weeks.length > 0) {
      parsed.push({ evidenceId: source.id, weeks });
    }
  }
  return parsed;
}

function applyParsedWeeksToBuckets(
  buckets: CorpusWeekBucket[],
  parsedWeeks: Array<{ evidenceId: string; weeks: ParsedTopic[] }>,
): Map<number, BucketSelectionMeta> {
  const selectionMeta = new Map<number, BucketSelectionMeta>();

  for (const parsedSource of parsedWeeks) {
    for (const week of parsedSource.weeks) {
      let bucketIndex = bucketIndexForDate(buckets, week.startDate);
      if (bucketIndex == null) bucketIndex = bucketIndexForWeekNumber(buckets, week.weekNumber);
      if (bucketIndex == null) continue;

      const bucket = buckets[bucketIndex];
      const nextPriority = week.startDate ? 3 : 2;
      const existingMeta = selectionMeta.get(bucketIndex) ?? { labelPriority: 0, diagnostics: [] };
      if (nextPriority >= existingMeta.labelPriority && week.weekLabel?.trim()) {
        bucket.weekLabel = week.weekLabel.trim();
        existingMeta.labelPriority = nextPriority;
      }

      bucket.topics = uniqueStrings([...bucket.topics, ...week.topics]);
      bucket.readings = uniqueStrings([...bucket.readings, ...week.readings]);
      if (week.notes) bucket.notes = uniqueStrings([...bucket.notes, week.notes]);
      bucket.sourceEvidenceIds = uniqueStrings([...bucket.sourceEvidenceIds, parsedSource.evidenceId]);
      existingMeta.diagnostics.push(`${parsedSource.evidenceId}:${week.weekLabel}`);
      selectionMeta.set(bucketIndex, existingMeta);
    }
  }

  return selectionMeta;
}

function placementKindFromEvidence(evidence: LoadedEvidence, context: WeekPlacementContext): EvidencePlacementKind {
  const roles = evidence.derivedHints.roles;
  if (evidence.derivedHints.breakSignals.length > 0) return "explicit_break";
  if (evidence.sourceKind === "canvas_announcement") {
    if (roles.includes("schedule_like") && !context.hasNonAnnouncementScheduleEvidence) {
      return "instructional_week";
    }
    return "event_only";
  }
  if (evidence.sourceKind === "canvas_assignment" || evidence.sourceKind === "canvas_calendar_event") {
    return "event_only";
  }
  if (
    evidence.sourceKind === "canvas_syllabus_pdf" ||
    evidence.sourceKind === "canvas_syllabus_page"
  ) {
    return "global";
  }
  if (roles.includes("event_like") && !roles.includes("schedule_like")) {
    return "event_only";
  }
  if (roles.includes("content_like") || roles.includes("schedule_like")) {
    return "instructional_week";
  }
  return evidence.bodyText ? "global" : "unplaced";
}

function bucketIndexFromEvidence(evidence: LoadedEvidence, context: WeekPlacementContext): number | null {
  const hints = evidence.derivedHints;

  for (const mention of hints.dateMentions) {
    const bucketIndex = bucketIndexForDate(context.buckets, mention.isoDate);
    if (bucketIndex != null) return bucketIndex;
  }

  const modulePosition = typeof evidence.structuredPayload?.modulePosition === "number"
    ? evidence.structuredPayload.modulePosition
    : null;
  if (modulePosition != null) {
    const bucketIndex = bucketIndexForWeekNumber(context.buckets, modulePosition);
    if (bucketIndex != null) return bucketIndex;
  }

  for (const weekNumber of hints.weekNumbers) {
    const bucketIndex = bucketIndexForWeekNumber(context.buckets, weekNumber);
    if (bucketIndex != null) return bucketIndex;
  }

  if (hints.lectureNumbers.length > 0) {
    const approximateWeek = Math.ceil(hints.lectureNumbers[0] / Math.max(context.meetingsPerWeek, 1));
    const bucketIndex = bucketIndexForWeekNumber(context.buckets, approximateWeek);
    if (bucketIndex != null) return bucketIndex;
  }

  if (hints.unitNumbers.length > 0) {
    const bucketIndex = bucketIndexForWeekNumber(context.buckets, hints.unitNumbers[0]);
    if (bucketIndex != null) return bucketIndex;
  }

  return null;
}

function buildPlacementDecisions(evidence: LoadedEvidence[], context: WeekPlacementContext): PlacementDecision[] {
  const decisions: PlacementDecision[] = [];

  for (const item of evidence) {
    const placementKind = placementKindFromEvidence(item, context);
    if (placementKind === "global") {
      decisions.push({
        evidenceId: item.id,
        placementKind,
        confidence: item.derivedHints.roles.includes("schedule_like") ? "high" : "medium",
        rationale: "course-wide evidence",
        signals: item.derivedHints.sourceRoleSignals,
        isPrimary: item.derivedHints.roles.includes("schedule_like"),
      });
      continue;
    }

    if (placementKind === "unplaced") {
      decisions.push({
        evidenceId: item.id,
        placementKind,
        confidence: "low",
        rationale: "no stable week/date signals",
        signals: item.derivedHints.sourceRoleSignals,
        isPrimary: false,
      });
      continue;
    }

    const bucketIndex = bucketIndexFromEvidence(item, context);
    if (bucketIndex == null) {
      decisions.push({
        evidenceId: item.id,
        placementKind: item.bodyText ? "global" : "unplaced",
        confidence: "low",
        rationale: "missing date/week mapping",
        signals: item.derivedHints.sourceRoleSignals,
        isPrimary: false,
      });
      continue;
    }

    const bucket = context.buckets[bucketIndex];
    decisions.push({
      evidenceId: item.id,
      placementKind,
      weekNumber: bucket.weekNumber,
      weekLabel: bucket.weekLabel,
      startDate: bucket.startDate,
      confidence:
        item.derivedHints.dateMentions.length > 0
          ? "high"
          : item.derivedHints.weekNumbers.length > 0 || item.derivedHints.lectureNumbers.length > 0
            ? "medium"
            : "low",
      rationale:
        item.derivedHints.dateMentions.length > 0
          ? "explicit date mention"
          : item.derivedHints.weekNumbers.length > 0
            ? "explicit week number"
            : item.derivedHints.lectureNumbers.length > 0
              ? "lecture-to-week inference"
              : "module position mapping",
      signals: item.derivedHints.sourceRoleSignals,
      isPrimary:
        placementKind === "instructional_week" &&
        item.sourceKind !== "canvas_announcement" &&
        item.sourceKind !== "canvas_assignment" &&
        item.sourceKind !== "canvas_calendar_event",
    });
  }

  return decisions;
}

function applyPlacementsToBuckets(
  buckets: CorpusWeekBucket[],
  evidenceById: Map<string, LoadedEvidence>,
  decisions: PlacementDecision[],
): void {
  for (const decision of decisions) {
    if (decision.weekNumber == null || decision.weekNumber <= 0) continue;
    const bucket = buckets[decision.weekNumber - 1];
    if (!bucket) continue;
    const evidence = evidenceById.get(decision.evidenceId);
    if (!evidence) continue;

    if (decision.placementKind === "explicit_break") {
      bucket.placementKind = "explicit_break";
      bucket.weekLabel = evidence.derivedHints.breakSignals[0] ?? evidence.title;
      bucket.notes = uniqueStrings([...bucket.notes, evidence.title]);
      bucket.sourceEvidenceIds = uniqueStrings([...bucket.sourceEvidenceIds, decision.evidenceId]);
      continue;
    }

    if (decision.placementKind === "event_only") {
      bucket.eventEvidenceIds = uniqueStrings([...bucket.eventEvidenceIds, decision.evidenceId]);
      bucket.notes = uniqueStrings([...bucket.notes, evidence.title]);
      continue;
    }

    if (decision.placementKind === "instructional_week") {
      bucket.sourceEvidenceIds = uniqueStrings([...bucket.sourceEvidenceIds, decision.evidenceId]);
      if (evidence.structuredPayload?.topics && Array.isArray(evidence.structuredPayload.topics)) {
        bucket.topics = uniqueStrings([
          ...bucket.topics,
          ...evidence.structuredPayload.topics.filter((value): value is string => typeof value === "string"),
        ]);
      } else if (
        evidence.sourceKind !== "canvas_syllabus_pdf" &&
        evidence.sourceKind !== "canvas_syllabus_page" &&
        !/\.(pdf|ppt|pptx|doc|docx|txt)$/i.test(evidence.title)
      ) {
        bucket.topics = uniqueStrings([...bucket.topics, evidence.title]);
      }
      if (evidence.structuredPayload?.readings && Array.isArray(evidence.structuredPayload.readings)) {
        bucket.readings = uniqueStrings([
          ...bucket.readings,
          ...evidence.structuredPayload.readings.filter((value): value is string => typeof value === "string"),
        ]);
      }
      if (evidence.sourceKind === "canvas_linked_file" || evidence.sourceKind === "canvas_media_transcript") {
        bucket.notes = uniqueStrings([...bucket.notes, evidence.title]);
      }
    }
  }
}

function pruneAndRenumberBuckets(buckets: CorpusWeekBucket[]): CorpusWeekBucket[] {
  const kept = buckets.filter((bucket) =>
    bucket.placementKind === "explicit_break" ||
    bucket.sourceEvidenceIds.length > 0 ||
    bucket.eventEvidenceIds.length > 0 ||
    bucket.topics.length > 0 ||
    bucket.readings.length > 0,
  );

  return kept.map((bucket, index) => ({
    ...bucket,
    weekNumber: index + 1,
    weekLabel:
      bucket.placementKind === "explicit_break"
        ? bucket.weekLabel
        : bucket.weekLabel?.trim()
          ? bucket.weekLabel
          : `Week ${index + 1}`,
  }));
}

function mapFinalBucketsByStartDate(buckets: CorpusWeekBucket[]): Map<string, CorpusWeekBucket> {
  const map = new Map<string, CorpusWeekBucket>();
  for (const bucket of buckets) {
    if (bucket.startDate) map.set(bucket.startDate, bucket);
  }
  return map;
}

function remapPlacementDecisions(decisions: PlacementDecision[], finalBuckets: CorpusWeekBucket[]): PlacementDecision[] {
  const finalByStartDate = mapFinalBucketsByStartDate(finalBuckets);
  return decisions.map((decision) => {
    if (!decision.startDate) return decision;
    const bucket = finalByStartDate.get(decision.startDate);
    if (!bucket) {
      if (decision.placementKind === "instructional_week" || decision.placementKind === "explicit_break" || decision.placementKind === "event_only") {
        return {
          ...decision,
          placementKind: decision.placementKind === "event_only" ? "global" : "global",
          weekNumber: null,
          weekLabel: null,
          startDate: null,
          confidence: "low",
          rationale: `${decision.rationale}; pruned empty week`,
          isPrimary: false,
        };
      }
      return decision;
    }
    return {
      ...decision,
      weekNumber: bucket.weekNumber,
      weekLabel: bucket.weekLabel,
      startDate: bucket.startDate,
    };
  });
}

export function deriveCorpusProjection(args: {
  courseName: string;
  evidence: LoadedEvidence[];
  termStartAt?: string | null;
  termEndAt?: string | null;
  classSchedule: ExtractedClassSchedule | null;
  calendarEvents?: RebuildCourseCorpusInput["calendarEvents"];
  parsedScheduleWeeks?: Array<{ evidenceId: string; weeks: ParsedTopic[] }>;
}): CorpusProjectionResult {
  const evidenceById = new Map(args.evidence.map((item) => [item.id, item]));
  const termRange = deriveTermRange({
    termStartAt: args.termStartAt ?? null,
    termEndAt: args.termEndAt ?? null,
    classSchedule: args.classSchedule,
    evidence: args.evidence,
  });

  const baseBuckets = buildEmptyWeekBuckets(termRange.startDate, termRange.endDate);
  applyParsedWeeksToBuckets(baseBuckets, args.parsedScheduleWeeks ?? []);

  const placementContext: WeekPlacementContext = {
    buckets: baseBuckets,
    meetingsPerWeek: inferMeetingsPerWeek(args.classSchedule, args.calendarEvents),
    hasNonAnnouncementScheduleEvidence: args.evidence.some((item) =>
      item.sourceKind !== "canvas_announcement" && item.derivedHints.roles.includes("schedule_like"),
    ),
  };

  const placementDecisions = buildPlacementDecisions(args.evidence, placementContext);
  applyPlacementsToBuckets(baseBuckets, evidenceById, placementDecisions);
  const finalBuckets = pruneAndRenumberBuckets(baseBuckets);
  const finalPlacements = remapPlacementDecisions(placementDecisions, finalBuckets);
  const projectedMaterials = projectMaterials(args.evidence, finalPlacements, finalBuckets);

  return {
    termRange,
    placementDecisions,
    finalPlacements,
    finalBuckets,
    projectedMaterials,
  };
}

function materialTypeFromEvidence(item: LoadedEvidence): MaterialAnalysis["detectedType"] {
  const title = item.title.toLowerCase();
  if (item.sourceKind === "canvas_syllabus_pdf" || item.sourceKind === "canvas_syllabus_page") return "syllabus";
  if (item.sourceKind === "canvas_media_transcript") return "lecture_notes";
  if (/\b(slides?|delivered)\b/.test(title)) return "lecture_slides";
  if (/\b(textbook|chapter|reading)\b/.test(title)) return "textbook";
  if (/\b(problem set|worksheet|homework|assignment)\b/.test(title)) return "problem_set";
  if (/\b(lecture|notes?|lab|experiment|review|study guide|handout)\b/.test(title)) return "lecture_notes";
  return "other";
}

function sourceRoleFromEvidence(item: LoadedEvidence, detectedType: MaterialAnalysis["detectedType"]): "timeline" | "content" | "mixed" | "unknown" {
  if (item.sourceKind === "canvas_syllabus_pdf") return "timeline";
  if (item.sourceKind === "canvas_syllabus_page") return "mixed";
  return inferMaterialSourceRole(detectedType, item.title);
}

function shouldProjectAsMaterial(item: LoadedEvidence): boolean {
  return [
    "canvas_syllabus_pdf",
    "canvas_linked_file",
    "canvas_media_transcript",
    "manual_upload",
    "auto_route",
  ].includes(item.sourceKind);
}

function projectedSourceKind(item: LoadedEvidence): string {
  if (item.sourceKind === "canvas_syllabus_pdf") return "canvas_syllabus";
  if (item.sourceKind === "canvas_media_transcript") return "canvas_media";
  if (item.sourceKind === "canvas_linked_file") {
    const rawKinds = item.provenance.map((entry) => entry.rawSourceKind);
    if (rawKinds.includes("canvas_syllabus")) return "canvas_syllabus";
    if (rawKinds.includes("canvas_media")) return "canvas_media";
    return "canvas_module";
  }
  return item.sourceKind;
}

function projectionSourceKey(item: LoadedEvidence): string | null {
  const firstRawSourceKey = item.provenance.find((entry) => entry.sourceKey)?.sourceKey ?? null;
  return firstRawSourceKey ?? item.sourceKey;
}

function summarizeEvidence(item: LoadedEvidence, detectedType: MaterialAnalysis["detectedType"]): string {
  if (item.sourceKind === "canvas_syllabus_pdf") {
    return "Syllabus automatically imported from Canvas.";
  }
  if (item.sourceKind === "canvas_media_transcript") {
    return "Auto-imported lecture transcript from Canvas Media Gallery.";
  }
  if (item.sourceKind === "canvas_linked_file") {
    return "Canvas-linked file imported into the course corpus.";
  }
  if (item.sourceKind === "manual_upload") {
    return "Manually uploaded course material.";
  }
  if (item.sourceKind === "auto_route") {
    return "Uploaded material auto-routed into this course.";
  }
  if (detectedType === "lecture_slides") return "Lecture slides imported from Canvas.";
  if (detectedType === "lecture_notes") return "Course notes imported from Canvas.";
  return "Course material imported into the canonical course corpus.";
}

function relatedTopicsForMaterial(item: LoadedEvidence, placements: PlacementDecision[], finalBuckets: CorpusWeekBucket[]): string[] {
  const placement = placements.find((candidate) => candidate.evidenceId === item.id && candidate.weekNumber);
  if (!placement?.weekNumber) return [];
  const bucket = finalBuckets.find((candidate) => candidate.weekNumber === placement.weekNumber);
  if (!bucket) return [];
  return uniqueStrings([bucket.weekLabel, ...bucket.topics]).slice(0, 6);
}

function projectMaterials(evidence: LoadedEvidence[], placements: PlacementDecision[], finalBuckets: CorpusWeekBucket[]): ProjectedMaterialRecord[] {
  return evidence
    .filter(shouldProjectAsMaterial)
    .map((item) => {
      const detectedType = materialTypeFromEvidence(item);
      const sourceRole = sourceRoleFromEvidence(item, detectedType);
      const autoStoredForAI = item.sourceKind === "canvas_media_transcript" || CANONICAL_CONTENT_TYPES.has(detectedType);
      return {
        courseId: item.courseId,
        fileName: item.title,
        detectedType,
        sourceRole,
        sourceKind: projectedSourceKind(item),
        sourceKey: projectionSourceKey(item),
        summary: summarizeEvidence(item, detectedType),
        relatedTopics: relatedTopicsForMaterial(item, placements, finalBuckets),
        rawText: item.bodyText
          ? item.sourceKind === "canvas_media_transcript"
            ? item.bodyText
            : item.bodyText.slice(0, 25_000)
          : "",
        storedForAI: autoStoredForAI,
        autoStoredForAI,
        contentHash: item.contentHash,
        sourceUpdatedAt: item.remoteUpdatedAt,
        syncStatus: "ready",
      };
    });
}

function verificationStatusForBucket(bucket: CorpusWeekBucket): string {
  if (bucket.placementKind === "explicit_break") return "verified";
  if (bucket.sourceEvidenceIds.length >= 2) return "corroborated";
  if (bucket.sourceEvidenceIds.length === 1) return "unverified";
  if (bucket.eventEvidenceIds.length > 0) return "gap";
  return "unverified";
}

async function persistPlacements(courseId: string, decisions: PlacementDecision[]): Promise<void> {
  await db.courseEvidencePlacement.deleteMany({ where: { courseId } });
  if (decisions.length === 0) return;

  await db.courseEvidencePlacement.createMany({
    data: decisions.map((decision) => ({
      courseId,
      evidenceId: decision.evidenceId,
      placementKind: decision.placementKind,
      weekNumber: decision.weekNumber ?? null,
      weekLabel: decision.weekLabel ?? null,
      startDate: decision.startDate ?? null,
      confidence: decision.confidence,
      rationale: decision.rationale,
      signals: decision.signals,
      isPrimary: decision.isPrimary,
    })),
  });
}

async function persistProjectedMaterials(courseId: string, materials: ProjectedMaterialRecord[]): Promise<void> {
  const existing = await db.courseMaterial.findMany({
    where: { courseId },
    select: {
      id: true,
      sourceKind: true,
      sourceKey: true,
      userStoredForAIOverride: true,
    },
  });
  const existingOverrideMap = new Map(
    existing
      .filter((item): item is typeof item & { sourceKey: string } => Boolean(item.sourceKey))
      .map((item) => [materialStateKey(item.sourceKind as never, item.sourceKey), item.userStoredForAIOverride]),
  );

  await db.courseMaterial.deleteMany({
    where: {
      courseId,
      OR: [
        { sourceKey: { not: null } },
        { sourceKind: { in: ["canvas_page", "canvas_syllabus_page", "canvas_announcement", "manual_upload", "auto_route"] } },
      ],
    },
  });

  if (materials.length === 0) return;

  await db.courseMaterial.createMany({
    data: materials.map((material) => {
      const overrideKey = material.sourceKey ? materialStateKey(material.sourceKind as never, material.sourceKey) : null;
      const override = overrideKey ? existingOverrideMap.get(overrideKey) : undefined;
      const storedForAI = override ?? material.autoStoredForAI;
      return {
        courseId,
        fileName: material.fileName,
        detectedType: material.detectedType,
        sourceRole: material.sourceRole,
        sourceKind: material.sourceKind,
        sourceKey: material.sourceKey,
        summary: material.summary,
        relatedTopics: material.relatedTopics,
        rawText: material.rawText,
        storedForAI,
        autoStoredForAI: material.autoStoredForAI,
        userStoredForAIOverride: override ?? null,
        contentHash: material.contentHash,
        sourceUpdatedAt: material.sourceUpdatedAt,
        lastSyncedAt: new Date(),
        syncStatus: material.syncStatus,
      };
    }),
  });
}

async function persistProjectedTopicsAndAnchors(
  courseId: string,
  finalBuckets: CorpusWeekBucket[],
): Promise<void> {
  await db.courseTopic.deleteMany({ where: { courseId } });
  await db.courseTimelineAnchor.deleteMany({ where: { courseId } });

  if (finalBuckets.length === 0) return;

  await db.courseTimelineAnchor.createMany({
    data: finalBuckets.map((bucket) => ({
      courseId,
      sequenceNumber: bucket.weekNumber,
      anchorDate: bucket.startDate,
      anchorType:
        bucket.placementKind === "explicit_break"
          ? "break"
          : bucket.sourceEvidenceIds.length >= 2
            ? "syllabus_corroborated"
            : bucket.sourceEvidenceIds.length === 1
              ? "syllabus_unverified"
              : "canvas_only",
      isInstructional: bucket.placementKind !== "explicit_break",
      calendarConfidence:
        bucket.startDate
          ? "high"
          : "low",
      sourceRefs: {
        sourceEvidenceIds: bucket.sourceEvidenceIds,
        eventEvidenceIds: bucket.eventEvidenceIds,
      } as Prisma.InputJsonValue,
      notes: bucket.notes[0] ?? null,
    })),
  });

  await db.courseTopic.createMany({
    data: finalBuckets.map((bucket) => ({
      courseId,
      weekNumber: bucket.weekNumber,
      weekLabel: bucket.weekLabel,
      startDate: bucket.startDate,
      topics: bucket.placementKind === "explicit_break"
        ? uniqueStrings([bucket.weekLabel, ...bucket.topics])
        : bucket.topics,
      readings: bucket.readings,
      notes: uniqueStrings(bucket.notes).join(" | ") || null,
      dateConfidence: bucket.startDate ? "high" : "medium",
      contentConfidence:
        bucket.sourceEvidenceIds.length >= 2
          ? "high"
          : bucket.sourceEvidenceIds.length === 1
            ? "medium"
            : "low",
      scheduleMode: "weekly",
      provenance: {
        sourceEvidenceIds: bucket.sourceEvidenceIds,
        eventEvidenceIds: bucket.eventEvidenceIds,
      } as Prisma.InputJsonValue,
      verificationStatus: verificationStatusForBucket(bucket),
      sourceBlock: "course_evidence",
      canvasModuleId: null,
    })),
  });
}

async function refreshCanvasCandidateStates(courseId: string): Promise<void> {
  const [importedMaterials, candidates] = await Promise.all([
    db.courseMaterial.findMany({
      where: {
        courseId,
        sourceKind: { in: ["canvas_syllabus", "canvas_module", "canvas_media"] },
        sourceKey: { not: null },
      },
      select: {
        sourceKind: true,
        sourceKey: true,
        sourceUpdatedAt: true,
      },
    }),
    db.canvasMaterialCandidate.findMany({
      where: { courseId },
      select: {
        id: true,
        contentId: true,
        requested: true,
        remoteUpdatedAt: true,
        remoteSize: true,
      },
    }),
  ]);

  const importedMaterialMap = new Map(
    importedMaterials
      .filter((material): material is typeof material & { sourceKey: string } => Boolean(material.sourceKey))
      .map((material) => [
        materialStateKey(material.sourceKind as never, material.sourceKey),
        { sourceUpdatedAt: material.sourceUpdatedAt },
      ]),
  );

  await Promise.all(
    candidates.map((candidate) => {
      const importedMaterial =
        importedMaterialMap.get(materialStateKey("canvas_module" as never, candidate.contentId)) ??
        importedMaterialMap.get(materialStateKey("canvas_syllabus" as never, candidate.contentId)) ??
        importedMaterialMap.get(materialStateKey("canvas_media" as never, candidate.contentId)) ??
        null;
      const requested = importedMaterial ? false : candidate.requested;
      return db.canvasMaterialCandidate.update({
        where: { id: candidate.id },
        data: {
          requested,
          status: deriveCandidateStatus({
            requested,
            importedMaterial,
            remoteUpdatedAt: candidate.remoteUpdatedAt ?? null,
            remoteSize: candidate.remoteSize ?? null,
            previousRemoteSize: candidate.remoteSize ?? null,
          }),
          lastSeenAt: new Date(),
        },
      });
    }),
  );
}

export async function rebuildCourseCorpusProjections(input: RebuildCourseCorpusInput): Promise<{
  weeksWritten: number;
  classScheduleSource: string;
  classSchedule: ExtractedClassSchedule | null;
  syllabusEvents: Array<{ title: string; dueDate: string; type: string }>;
}> {
  const evidence = await loadCourseEvidence(input.courseId);
  const { classSchedule, classScheduleSource } = await deriveClassSchedule({
    ...input,
    evidence,
  });
  const syllabusEvents = await deriveSyllabusEvents(evidence);
  const parsedScheduleWeeks = await deriveParsedScheduleWeeks({
    courseName: input.courseName,
    evidence,
  });
  const projection = deriveCorpusProjection({
    courseName: input.courseName,
    evidence,
    termStartAt: input.termStartAt ?? null,
    termEndAt: input.termEndAt ?? null,
    classSchedule,
    calendarEvents: input.calendarEvents,
    parsedScheduleWeeks,
  });

  await Promise.all([
    persistPlacements(input.courseId, projection.finalPlacements),
    persistProjectedTopicsAndAnchors(input.courseId, projection.finalBuckets),
    persistProjectedMaterials(input.courseId, projection.projectedMaterials),
    db.course.update({
      where: { id: input.courseId },
      data: {
        classSchedule: classSchedule
          ? classSchedule as unknown as Prisma.InputJsonValue
          : Prisma.JsonNull,
        syllabusEvents: syllabusEvents as unknown as Prisma.InputJsonValue,
        timelineMode: projection.finalBuckets.length > 0 ? "weekly" : "unknown",
        timelineDiagnostics: {
          timelineQuality: projection.finalBuckets.length > 0 ? "corpus-first" : "empty",
          corpusFirst: true,
          termRange: projection.termRange,
          classScheduleSource,
          evidenceCount: evidence.length,
          parsedScheduleSources: parsedScheduleWeeks.map((source) => ({
            evidenceId: source.evidenceId,
            weekCount: source.weeks.length,
          })),
          projectedMaterialCount: projection.projectedMaterials.length,
          placementCounts: projection.finalPlacements.reduce<Record<string, number>>((acc, placement) => {
            acc[placement.placementKind] = (acc[placement.placementKind] ?? 0) + 1;
            return acc;
          }, {}),
        } as Prisma.InputJsonValue,
      },
    }),
  ]);

  await refreshCanvasCandidateStates(input.courseId).catch(() => undefined);

  return {
    weeksWritten: projection.finalBuckets.length,
    classScheduleSource,
    classSchedule,
    syllabusEvents,
  };
}

export async function runCanvasCourseCorpusSync(input: CanvasCourseCorpusSyncInput): Promise<{
  weeksWritten: number;
  classScheduleSource: string;
}> {
  await ingestCanvasCourseEvidence(input);
  const rebuilt = await rebuildCourseCorpusProjections({
    courseId: input.courseId,
    courseName: input.courseName,
    termStartAt: input.termStartAt ?? input.course.termStartAt ?? null,
    termEndAt: input.termEndAt ?? input.course.termEndAt ?? null,
    calendarEvents: input.calendarEvents ?? input.course.calendarEvents ?? [],
  });

  return {
    weeksWritten: rebuilt.weeksWritten,
    classScheduleSource: rebuilt.classScheduleSource,
  };
}

export async function ingestStandaloneEvidence(args: {
  courseId: string;
  rawSourceKind: "manual_upload" | "auto_route";
  sourceKey?: string | null;
  title: string;
  text: string;
}): Promise<void> {
  const evidence = await upsertCourseEvidence(
    buildEvidenceInput({
      courseId: args.courseId,
      rawSourceKind: args.rawSourceKind,
      rawSourceKey: args.sourceKey ?? args.title,
      title: args.title,
      bodyText: args.text,
      discoveredVia: args.rawSourceKind === "manual_upload" ? "manual upload" : "auto-route upload",
    }),
  );

  if (evidence.bodyText && evidence.contentHash) {
    await ensureEvidenceChunks({
      evidenceId: evidence.id,
      courseId: evidence.courseId,
      text: evidence.bodyText,
      contentHash: evidence.contentHash,
    }).catch(() => undefined);
  }
}

export const __testables = {
  deriveCanonicalSourceKey,
  deriveCorpusProjection,
  mergeProvenance,
};
