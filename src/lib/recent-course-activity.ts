import { format } from "date-fns";
import { db } from "@/lib/db";

export type RecentCourseActivityStatus = "new" | "updated" | "available" | "queued";

export interface RecentCourseActivityItem {
  id: string;
  courseId: string;
  title: string;
  label: string;
  detail: string | null;
  freshnessAt: string;
  freshnessLabel: string;
  sourceKind: "canvas_media" | "canvas_module";
  status: RecentCourseActivityStatus;
}

const HIGH_SIGNAL_TYPES = new Set(["lecture_notes", "lecture_slides", "textbook", "problem_set"]);
const RECENT_ACTIVITY_MAX_PER_COURSE = 4;
const RECENT_ACTIVITY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function formatFreshnessLabel(value: Date): string {
  return format(value, "MMM d");
}

function parseFreshness(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isRecentFreshness(value: string | Date | null | undefined, cutoff: number): boolean {
  const parsed = parseFreshness(value);
  return Boolean(parsed && parsed.getTime() >= cutoff);
}

function isUpdatedMaterial(material: {
  uploadedAt: Date;
  lastSyncedAt: Date | null;
}): boolean {
  return Boolean(
    material.lastSyncedAt &&
    material.lastSyncedAt.getTime() > material.uploadedAt.getTime() + 5 * 60 * 1000,
  );
}

function classifyModuleLabel(detectedType: string, updated: boolean): string {
  if (detectedType === "lecture_notes" || detectedType === "lecture_slides" || detectedType === "textbook") {
    return updated ? "Updated lecture notes" : "New lecture notes";
  }
  if (detectedType === "problem_set") {
    return updated ? "Updated practice file" : "New practice file";
  }
  return updated ? "Updated file" : "New file";
}

function buildMaterialActivity(material: {
  id: string;
  courseId: string;
  fileName: string;
  sourceKind: string;
  detectedType: string;
  sourceUpdatedAt: Date | null;
  lastSyncedAt: Date | null;
  uploadedAt: Date;
}): RecentCourseActivityItem | null {
  if (material.sourceKind !== "canvas_media" && material.sourceKind !== "canvas_module") {
    return null;
  }

  const freshness = material.sourceUpdatedAt ?? material.lastSyncedAt ?? material.uploadedAt;
  const updated = isUpdatedMaterial(material);
  const label =
    material.sourceKind === "canvas_media"
      ? updated
        ? "Updated transcript"
        : "New transcript"
      : classifyModuleLabel(material.detectedType, updated);

  return {
    id: `material:${material.id}`,
    courseId: material.courseId,
    title: material.fileName,
    label,
    detail: material.sourceKind === "canvas_media" ? "Imported from Media Gallery" : null,
    freshnessAt: freshness.toISOString(),
    freshnessLabel: formatFreshnessLabel(freshness),
    sourceKind: material.sourceKind,
    status: updated ? "updated" : "new",
  };
}

function buildCandidateActivity(candidate: {
  id: string;
  courseId: string;
  fileName: string;
  moduleName: string;
  sourceKind: string;
  status: string;
  requested: boolean;
  remoteUpdatedAt: string | null;
  lastSeenAt: Date;
}): RecentCourseActivityItem | null {
  if (candidate.sourceKind !== "canvas_media" && candidate.sourceKind !== "canvas_module") {
    return null;
  }
  if (candidate.status === "imported") return null;

  const freshness = candidate.remoteUpdatedAt ? new Date(candidate.remoteUpdatedAt) : candidate.lastSeenAt;
  const isValidFreshness = Number.isFinite(freshness.getTime()) ? freshness : candidate.lastSeenAt;
  const transcript = candidate.sourceKind === "canvas_media";

  let label: string;
  let status: RecentCourseActivityStatus;
  if (candidate.requested || candidate.status === "requested") {
    label = transcript ? "Transcript queued" : "File queued";
    status = "queued";
  } else if (candidate.status === "stale") {
    label = transcript ? "Updated transcript available" : "Updated file available";
    status = "updated";
  } else {
    label = transcript ? "New transcript available" : "New file available";
    status = "available";
  }

  return {
    id: `candidate:${candidate.id}`,
    courseId: candidate.courseId,
    title: candidate.fileName,
    label,
    detail: candidate.moduleName,
    freshnessAt: isValidFreshness.toISOString(),
    freshnessLabel: formatFreshnessLabel(isValidFreshness),
    sourceKind: candidate.sourceKind,
    status,
  };
}

function activityPriority(item: RecentCourseActivityItem): number {
  if (item.sourceKind === "canvas_media" && item.status === "new") return 500;
  if (item.sourceKind === "canvas_media" && item.status === "updated") return 450;
  if (item.sourceKind === "canvas_media" && item.status === "available") return 425;
  if (item.sourceKind === "canvas_media" && item.status === "queued") return 400;
  if (item.status === "new") return 300;
  if (item.status === "updated") return 260;
  if (item.status === "available") return 220;
  return 200;
}

export async function getRecentCourseActivity(courseIds: string[]): Promise<Record<string, RecentCourseActivityItem[]>> {
  if (courseIds.length === 0) return {};
  const cutoff = Date.now() - RECENT_ACTIVITY_LOOKBACK_MS;

  const [materials, candidates] = await Promise.all([
    db.courseMaterial.findMany({
      where: {
        courseId: { in: courseIds },
        sourceKind: { in: ["canvas_media", "canvas_module"] },
      },
      select: {
        id: true,
        courseId: true,
        fileName: true,
        sourceKind: true,
        detectedType: true,
        sourceUpdatedAt: true,
        lastSyncedAt: true,
        uploadedAt: true,
      },
      orderBy: [{ lastSyncedAt: "desc" }, { uploadedAt: "desc" }],
    }),
    db.canvasMaterialCandidate.findMany({
      where: {
        courseId: { in: courseIds },
        sourceKind: { in: ["canvas_media", "canvas_module"] },
        status: { in: ["discovered", "requested", "stale"] },
      },
      select: {
        id: true,
        courseId: true,
        fileName: true,
        moduleName: true,
        sourceKind: true,
        status: true,
        requested: true,
        remoteUpdatedAt: true,
        lastSeenAt: true,
      },
      orderBy: [{ lastSeenAt: "desc" }],
    }),
  ]);

  const grouped = new Map<string, RecentCourseActivityItem[]>();

  for (const material of materials) {
    if (material.sourceKind === "canvas_module" && !HIGH_SIGNAL_TYPES.has(material.detectedType)) {
      continue;
    }
    const item = buildMaterialActivity(material);
    if (!item) continue;
    if (!isRecentFreshness(item.freshnessAt, cutoff)) continue;
    const bucket = grouped.get(item.courseId) ?? [];
    bucket.push(item);
    grouped.set(item.courseId, bucket);
  }

  for (const candidate of candidates) {
    const item = buildCandidateActivity(candidate);
    if (!item) continue;
    if (!isRecentFreshness(item.freshnessAt, cutoff)) continue;
    const bucket = grouped.get(item.courseId) ?? [];
    bucket.push(item);
    grouped.set(item.courseId, bucket);
  }

  return Object.fromEntries(
    courseIds.map((courseId) => {
      const items = (grouped.get(courseId) ?? [])
        .sort((a, b) => {
          const priorityDelta = activityPriority(b) - activityPriority(a);
          if (priorityDelta !== 0) return priorityDelta;
          return Date.parse(b.freshnessAt) - Date.parse(a.freshnessAt);
        })
        .slice(0, RECENT_ACTIVITY_MAX_PER_COURSE);
      return [courseId, items];
    }),
  );
}
