import { db } from "@/lib/db";
import {
  bestWindow,
  detectSourceFormat,
  scheduleScore,
  type ExtractedClassSchedule,
} from "@/lib/parse-syllabus";
import {
  effectiveStoredForAI,
  hashMaterialText,
  isRemoteSourceNewer,
  normalizeSourceUpdatedAt,
  updateMaterialSearchIndex,
  type MaterialSourceKind,
} from "@/lib/material-sync";
import { addDays, addYears, parseISO, subDays } from "date-fns";

export type ScheduleSourceAuthority = "primary" | "supporting" | "enrichment";

export function htmlToText(html: string): string {
  return html
    .replace(/<\/?(tr|li|p|br|h[1-6]|div|section|thead|tbody)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "-")
    .replace(/&#8211;|&#x2013;/gi, "-")
    .replace(/&#8212;|&#x2014;/gi, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function classScheduleProbe(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  return {
    chars: text.length,
    hasMeetingHeading: /\b(meeting times?|class times?|course schedule)\b/i.test(text),
    hasDayNames: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|wednesdays|fridays)\b/i.test(
      text,
    ),
    hasCompactDays: /\b(MWF|TR|TTH|MON\/WED\/FRI)\b/i.test(text),
    hasTimeRange:
      /\d{1,2}(?::\d{2})?\s*[AP]M\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*[AP]M/i.test(text) ||
      /\d{1,2}(?::\d{2})?\s*[AP]M\s+to\s+\d{1,2}(?::\d{2})?\s*[AP]M/i.test(text),
    snippet: compact.slice(0, 500),
  };
}

export function classifyImportedPdfSource(
  fileName: string,
  scheduleWindow: string,
  score: number,
): {
  authority: ScheduleSourceAuthority;
  detectedType: "syllabus" | "lecture_notes" | "lecture_slides" | "other";
  sourceRole: "timeline" | "content" | "mixed" | "unknown";
  storedForAI: boolean;
} {
  const normalized = fileName.toLowerCase();
  const hasAuthorityName =
    /\bsyllab|schedul|calendar|course[\s._-]?(guide|outline|info|overview|pack)\b/i.test(normalized);
  const hasEnrichmentName =
    /\b(lecture|delivered|slides?|reading|paper|handout|worksheet|study outline|review questions?|exam\s*\d+)\b/i.test(
      normalized,
    );
  const format = detectSourceFormat(scheduleWindow);
  const looksStronglyScheduleStructured =
    score >= 1.5 ||
    format === "tab-separated table" ||
    format === "structured schedule (one entry per line)" ||
    format === "lecture outline with repeated Lecture N rows" ||
    format.startsWith("weekly calendar grid");
  const looksWeaklyScheduleStructured =
    looksStronglyScheduleStructured ||
    score >= 0.75 ||
    /\bweek\s+\d+|lecture\s+\d+|class meeting|session\s+\d+|spring break|no class\b/i.test(
      scheduleWindow,
    );

  let authority: ScheduleSourceAuthority;
  if (hasEnrichmentName && !hasAuthorityName) {
    authority = looksStronglyScheduleStructured && score >= 3 ? "supporting" : "enrichment";
  } else if (hasAuthorityName) {
    authority = looksWeaklyScheduleStructured ? "primary" : "supporting";
  } else if (looksStronglyScheduleStructured) {
    authority = "supporting";
  } else {
    authority = "enrichment";
  }

  if (authority !== "enrichment") {
    return {
      authority,
      detectedType: "syllabus",
      sourceRole: authority === "primary" ? "timeline" : "mixed",
      storedForAI: false,
    };
  }

  if (/\b(slides?|lecture|delivered)\b/i.test(normalized)) {
    return {
      authority,
      detectedType: "lecture_slides",
      sourceRole: "content",
      storedForAI: true,
    };
  }

  if (/\b(reading|paper|article|chapter|handout)\b/i.test(normalized)) {
    return {
      authority,
      detectedType: "lecture_notes",
      sourceRole: "content",
      storedForAI: true,
    };
  }

  return {
    authority,
    detectedType: "other",
    sourceRole: "content",
    storedForAI: false,
  };
}

function summarizeCanvasTextDocumentSource(
  sourceKind: MaterialSourceKind,
  sourceRole: "timeline" | "content" | "mixed" | "unknown",
): string {
  if (sourceKind === "canvas_syllabus_page") {
    return "Canvas syllabus text imported from the course syllabus page.";
  }
  if (sourceKind === "canvas_announcement") {
    return "Canvas announcement imported from the course updates feed.";
  }
  if (sourceRole === "timeline") {
    return "Canvas page imported from the course pages/modules and identified as schedule-relevant.";
  }
  if (sourceRole === "mixed") {
    return "Canvas page imported from the course pages/modules with both schedule and content signals.";
  }
  return "Canvas page imported from the course pages/modules.";
}

export function classifyCanvasTextDocument(
  sourceKind: MaterialSourceKind,
  fileName: string,
  text: string,
): {
  authority: ScheduleSourceAuthority;
  detectedType: "syllabus" | "lecture_notes" | "lecture_slides" | "other";
  sourceRole: "timeline" | "content" | "mixed" | "unknown";
  storedForAI: boolean;
  summary: string;
} {
  const rawText = text.trim();
  const scheduleWindow = bestWindow(rawText);
  const score = scheduleScore(scheduleWindow);
  const heuristic = classifyImportedPdfSource(fileName, scheduleWindow, score);

  if (sourceKind === "canvas_syllabus_page") {
    const authority = heuristic.authority === "enrichment" ? "supporting" : heuristic.authority;
    const sourceRole = authority === "primary" ? "timeline" : "mixed";
    return {
      authority,
      detectedType: "syllabus",
      sourceRole,
      storedForAI: false,
      summary: summarizeCanvasTextDocumentSource(sourceKind, sourceRole),
    };
  }

  if (sourceKind === "canvas_announcement") {
    const sourceRole =
      /\b(exam|quiz|midterm|final|deadline|due date|schedule|lecture|class|office hour|cancel(?:led)?|review)\b/i.test(
        `${fileName}\n${rawText}`,
      )
        ? "mixed"
        : "unknown";
    return {
      authority: "enrichment",
      detectedType: "other",
      sourceRole,
      storedForAI: false,
      summary: summarizeCanvasTextDocumentSource(sourceKind, sourceRole),
    };
  }

  if (heuristic.authority !== "enrichment") {
    return {
      authority: heuristic.authority,
      detectedType: "syllabus",
      sourceRole: heuristic.sourceRole,
      storedForAI: false,
      summary: summarizeCanvasTextDocumentSource(sourceKind, heuristic.sourceRole),
    };
  }

  const contentLikePage =
    /\b(lecture|class|unit|week|lab|discussion|review|exam|notes?|worksheet|guide)\b/i.test(fileName);
  const sourceRole = contentLikePage ? "content" : "unknown";
  return {
    authority: heuristic.authority,
    detectedType: "other",
    sourceRole,
    storedForAI: false,
    summary: summarizeCanvasTextDocumentSource(sourceKind, sourceRole),
  };
}

export function resolveCanvasSourceKey(
  sourceKind: MaterialSourceKind,
  fileName: string,
  sourceKey?: string | null,
): string {
  const normalized = sourceKey?.trim();
  if (normalized) return normalized;
  return `filename:${sourceKind}:${fileName.trim().toLowerCase()}`;
}

export function materialStateKey(sourceKind: MaterialSourceKind, sourceKey: string): string {
  return `${sourceKind}:${sourceKey}`;
}

function isCanvasFileSourceKind(
  sourceKind: string | null | undefined,
): sourceKind is Extract<MaterialSourceKind, "canvas_module" | "canvas_syllabus"> {
  return sourceKind === "canvas_module" || sourceKind === "canvas_syllabus";
}

function canvasFileSourceKindPriority(sourceKind: string | null | undefined): number {
  if (sourceKind === "canvas_module") return 2;
  if (sourceKind === "canvas_syllabus") return 1;
  return 0;
}

function canonicalCanvasFileSourceKind(
  incoming: MaterialSourceKind,
  existing?: string | null,
): MaterialSourceKind {
  if (!isCanvasFileSourceKind(incoming)) return incoming;
  if (!existing || !isCanvasFileSourceKind(existing)) return incoming;
  return canvasFileSourceKindPriority(existing) >= canvasFileSourceKindPriority(incoming)
    ? existing
    : incoming;
}

export function deriveCandidateStatus(args: {
  requested: boolean;
  importedMaterial: {
    sourceUpdatedAt: Date | null;
  } | null;
  remoteUpdatedAt?: string | null;
  remoteSize?: number | null;
  previousRemoteSize?: number | null;
}): "discovered" | "requested" | "imported" | "stale" {
  if (args.requested) return "requested";
  if (!args.importedMaterial) return "discovered";
  if (isRemoteSourceNewer(args.remoteUpdatedAt ?? null, args.importedMaterial.sourceUpdatedAt)) {
    return "stale";
  }
  if (
    typeof args.remoteSize === "number" &&
    args.remoteSize > 0 &&
    typeof args.previousRemoteSize === "number" &&
    args.previousRemoteSize > 0 &&
    args.remoteSize !== args.previousRemoteSize
  ) {
    return "stale";
  }
  return "imported";
}

export async function findExistingSyncedMaterial(
  courseId: string,
  sourceKind: MaterialSourceKind,
  sourceKey: string,
  fileName: string,
) {
  const byKey = await db.courseMaterial.findFirst({
    where: { courseId, sourceKind, sourceKey },
    select: {
      id: true,
      sourceKind: true,
      contentHash: true,
      sourceUpdatedAt: true,
      detectedType: true,
      sourceRole: true,
      summary: true,
      relatedTopics: true,
      storedForAI: true,
      autoStoredForAI: true,
      userStoredForAIOverride: true,
    },
  });
  if (byKey) return byKey;

  if (isCanvasFileSourceKind(sourceKind)) {
    const byCrossKindKey = await db.courseMaterial.findFirst({
      where: {
        courseId,
        sourceKey,
        sourceKind: { in: ["canvas_module", "canvas_syllabus"] },
      },
      orderBy: [{ sourceKind: "asc" }, { lastSyncedAt: "desc" }, { uploadedAt: "desc" }],
      select: {
        id: true,
        sourceKind: true,
        contentHash: true,
        sourceUpdatedAt: true,
        detectedType: true,
        sourceRole: true,
        summary: true,
        relatedTopics: true,
        storedForAI: true,
        autoStoredForAI: true,
        userStoredForAIOverride: true,
      },
    });
    if (byCrossKindKey) return byCrossKindKey;
  }

  if (sourceKind === "canvas_module" || sourceKind === "canvas_media") {
    const keylessMatches = await db.courseMaterial.findMany({
      where: {
        courseId,
        sourceKind,
        fileName,
        sourceKey: null,
      },
      select: {
        id: true,
        sourceKind: true,
        contentHash: true,
        sourceUpdatedAt: true,
        detectedType: true,
        sourceRole: true,
        summary: true,
        relatedTopics: true,
        storedForAI: true,
        autoStoredForAI: true,
        userStoredForAIOverride: true,
      },
      take: 2,
    });
    if (keylessMatches.length === 1) return keylessMatches[0];
  }

  if (sourceKind === "canvas_syllabus") {
    return db.courseMaterial.findFirst({
      where: {
        courseId,
        sourceKind: "legacy",
        fileName,
        OR: [
          { detectedType: "syllabus" },
          { summary: "Syllabus automatically imported from Canvas." },
          { summary: "Canvas-linked PDF imported from the syllabus page." },
        ],
      },
      select: {
        id: true,
        sourceKind: true,
        contentHash: true,
        sourceUpdatedAt: true,
        detectedType: true,
        sourceRole: true,
        summary: true,
        relatedTopics: true,
        storedForAI: true,
        autoStoredForAI: true,
        userStoredForAIOverride: true,
      },
    });
  }

  return null;
}

export async function dedupeCanvasFileMaterials(courseId: string): Promise<number> {
  const materials = await db.courseMaterial.findMany({
    where: {
      courseId,
      sourceKind: { in: ["canvas_module", "canvas_syllabus"] },
      sourceKey: { not: null },
    },
    select: {
      id: true,
      sourceKind: true,
      sourceKey: true,
      rawText: true,
      relatedTopics: true,
      autoStoredForAI: true,
      userStoredForAIOverride: true,
      sourceUpdatedAt: true,
      lastSyncedAt: true,
      uploadedAt: true,
    },
    orderBy: [{ lastSyncedAt: "desc" }, { uploadedAt: "desc" }],
  });

  const byKey = new Map<string, typeof materials>();
  for (const material of materials) {
    if (!material.sourceKey) continue;
    const bucket = byKey.get(material.sourceKey) ?? [];
    bucket.push(material);
    byKey.set(material.sourceKey, bucket);
  }

  let deleted = 0;

  for (const [sourceKey, bucket] of byKey) {
    const sourceKinds = new Set(bucket.map((material) => material.sourceKind));
    if (sourceKinds.size <= 1) continue;

    const ranked = [...bucket].sort((a, b) => {
      const sourcePriority =
        canvasFileSourceKindPriority(b.sourceKind as MaterialSourceKind) -
        canvasFileSourceKindPriority(a.sourceKind as MaterialSourceKind);
      if (sourcePriority !== 0) return sourcePriority;

      const updatedDelta = (b.sourceUpdatedAt?.getTime() ?? 0) - (a.sourceUpdatedAt?.getTime() ?? 0);
      if (updatedDelta !== 0) return updatedDelta;

      const syncDelta = (b.lastSyncedAt?.getTime() ?? 0) - (a.lastSyncedAt?.getTime() ?? 0);
      if (syncDelta !== 0) return syncDelta;

      const rawTextDelta = (b.rawText?.length ?? 0) - (a.rawText?.length ?? 0);
      if (rawTextDelta !== 0) return rawTextDelta;

      return b.uploadedAt.getTime() - a.uploadedAt.getTime();
    });

    const winner = ranked[0];
    const losers = ranked.slice(1);
    if (losers.length === 0) continue;

    const canonicalKind = canonicalCanvasFileSourceKind(
      winner.sourceKind as MaterialSourceKind,
      null,
    );
    const mergedRelatedTopics = Array.from(
      new Set(ranked.flatMap((material) => material.relatedTopics ?? [])),
    );
    const mergedAutoStoredForAI = ranked.some((material) => material.autoStoredForAI);
    const mergedSourceUpdatedAt =
      ranked
        .map((material) => material.sourceUpdatedAt)
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    await db.courseMaterial.update({
      where: { id: winner.id },
      data: {
        sourceKind: canonicalKind,
        relatedTopics: mergedRelatedTopics,
        autoStoredForAI: mergedAutoStoredForAI,
        storedForAI: effectiveStoredForAI(
          mergedAutoStoredForAI,
          winner.userStoredForAIOverride,
        ),
        sourceUpdatedAt: mergedSourceUpdatedAt,
      },
    });

    await db.courseMaterial.deleteMany({
      where: { id: { in: losers.map((material) => material.id) } },
    });

    deleted += losers.length;
    console.log(
      `[sync] deduped ${losers.length} duplicate canvas file material(s) for course ${courseId} sourceKey=${sourceKey}`,
    );
  }

  return deleted;
}

export async function saveSyncedMaterial(args: {
  existing?: {
    id: string;
    sourceKind: string;
    userStoredForAIOverride: boolean | null;
  } | null;
  courseId: string;
  fileName: string;
  detectedType: string;
  sourceRole: string;
  sourceKind: MaterialSourceKind;
  sourceKey: string;
  summary: string;
  relatedTopics: string[];
  rawText: string;
  contentHash: string;
  sourceUpdatedAt?: string | Date | null;
  autoStoredForAI: boolean;
}) {
  const sourceKind = canonicalCanvasFileSourceKind(args.sourceKind, args.existing?.sourceKind);
  const storedForAI = effectiveStoredForAI(
    args.autoStoredForAI,
    args.existing?.userStoredForAIOverride,
  );
  const sourceUpdatedAt = normalizeSourceUpdatedAt(args.sourceUpdatedAt);

  if (args.existing) {
    return db.courseMaterial.update({
      where: { id: args.existing.id },
      data: {
        fileName: args.fileName,
        detectedType: args.detectedType,
        sourceRole: args.sourceRole,
        sourceKind,
        sourceKey: args.sourceKey,
        summary: args.summary,
        relatedTopics: args.relatedTopics,
        rawText: args.rawText,
        storedForAI,
        autoStoredForAI: args.autoStoredForAI,
        contentHash: args.contentHash,
        sourceUpdatedAt,
        lastSyncedAt: new Date(),
        syncStatus: "ready",
      },
      select: { id: true },
    });
  }

  return db.courseMaterial.create({
    data: {
      courseId: args.courseId,
      fileName: args.fileName,
      detectedType: args.detectedType,
      sourceRole: args.sourceRole,
      sourceKind,
      sourceKey: args.sourceKey,
      summary: args.summary,
      relatedTopics: args.relatedTopics,
      rawText: args.rawText,
      storedForAI,
      autoStoredForAI: args.autoStoredForAI,
      contentHash: args.contentHash,
      sourceUpdatedAt,
      lastSyncedAt: new Date(),
      syncStatus: "ready",
    },
    select: { id: true },
  });
}

export async function saveImportedTextDocument(args: {
  courseId: string;
  fileName: string;
  text: string;
  sourceKind: MaterialSourceKind;
  sourceKey: string;
  sourceUpdatedAt?: string | Date | null;
  classification: {
    detectedType: "syllabus" | "lecture_notes" | "lecture_slides" | "other";
    sourceRole: "timeline" | "content" | "mixed" | "unknown";
    summary: string;
    storedForAI: boolean;
  };
}) {
  const rawText = args.text.trim();
  if (rawText.length === 0) return null;

  const existing = await findExistingSyncedMaterial(
    args.courseId,
    args.sourceKind,
    args.sourceKey,
    args.fileName,
  );
  const contentHash = hashMaterialText(rawText);
  const material = await saveSyncedMaterial({
    existing,
    courseId: args.courseId,
    fileName: args.fileName,
    detectedType: args.classification.detectedType,
    sourceRole: args.classification.sourceRole,
    sourceKind: args.sourceKind,
    sourceKey: args.sourceKey,
    summary: args.classification.summary,
    relatedTopics: [],
    rawText: rawText.slice(0, 25_000),
    contentHash,
    sourceUpdatedAt: args.sourceUpdatedAt ?? null,
    autoStoredForAI: args.classification.storedForAI,
  });

  if (!existing || existing.contentHash !== contentHash) {
    try {
      await updateMaterialSearchIndex({
        materialId: material.id,
        courseId: args.courseId,
        sourceKind: args.sourceKind,
        text: rawText,
        contentHash,
      });
    } catch {
      // search indexing never blocks import
    }
  }

  return material;
}

function isoDateOnly(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

function shiftDateIntoTerm(
  dateStr: string | null,
  termStart: string | null,
  termEnd: string | null,
): string | null {
  if (!dateStr) return null;
  const parsed = parseISO(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateStr;

  const termStartDate = termStart ? parseISO(`${termStart}T12:00:00Z`) : null;
  const termEndDate = termEnd ? parseISO(`${termEnd}T12:00:00Z`) : termStartDate;
  if (
    !termStartDate ||
    Number.isNaN(termStartDate.getTime()) ||
    !termEndDate ||
    Number.isNaN(termEndDate.getTime())
  ) {
    return dateStr;
  }

  const paddedStart = subDays(termStartDate, 21);
  const paddedEnd = addDays(termEndDate, 21);
  if (parsed >= paddedStart && parsed <= paddedEnd) {
    return dateStr;
  }

  let best = dateStr;
  let bestInRange = false;

  for (let shift = -3; shift <= 3; shift++) {
    const shifted = addYears(parsed, shift);
    const shiftedStr = shifted.toISOString().slice(0, 10);
    const inRange = shifted >= paddedStart && shifted <= paddedEnd;
    if (inRange) {
      best = shiftedStr;
      bestInRange = true;
      break;
    }
  }

  return bestInRange ? best : dateStr;
}

export function hasUsefulMeetingTimes(schedule: ExtractedClassSchedule | null): boolean {
  if (!schedule) return false;
  return schedule.meetings.some(
    (meeting) =>
      Boolean(meeting.startTime) &&
      Boolean(meeting.endTime) &&
      !(meeting.startTime === "00:00" && meeting.endTime === "00:00"),
  );
}

export function normalizeScheduleForTerm(
  schedule: ExtractedClassSchedule | null,
  termStartAt?: string | null,
  termEndAt?: string | null,
): ExtractedClassSchedule | null {
  if (!schedule) return null;

  const termStart = isoDateOnly(termStartAt);
  const termEnd = isoDateOnly(termEndAt);

  return {
    ...schedule,
    semesterStart: termStart ?? shiftDateIntoTerm(schedule.semesterStart, termStart, termEnd),
    semesterEnd: termEnd ?? shiftDateIntoTerm(schedule.semesterEnd, termStart, termEnd),
    finalExamDate: shiftDateIntoTerm(schedule.finalExamDate, termStart, termEnd),
  };
}
