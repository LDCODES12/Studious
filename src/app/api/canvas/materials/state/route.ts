import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import crypto from "crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: NextResponse) {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => res.headers.set(key, value));
  return res;
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

function sha256(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization") ?? "";
  const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!rawToken) return withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

  const hash = sha256(rawToken);
  const user = await db.user.findUnique({ where: { apiTokenHash: hash }, select: { id: true } });
  if (!user) return withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

  const canvasCourseId = request.nextUrl.searchParams.get("canvasCourseId");
  if (!canvasCourseId) {
    return withCors(NextResponse.json({ knownCourse: false, materials: [], candidates: [] }));
  }

  const course = await db.course.findFirst({
    where: { userId: user.id, canvasCourseId },
    select: { id: true },
  });
  if (!course) return withCors(NextResponse.json({ knownCourse: false, materials: [], candidates: [] }));

  const [materials, evidenceRows, candidates] = await Promise.all([
    db.courseMaterial.findMany({
      where: {
        courseId: course.id,
        sourceKind: { in: ["canvas_syllabus", "canvas_module", "canvas_media"] },
        sourceKey: { not: null },
      },
      select: {
        sourceKind: true,
        sourceKey: true,
        rawText: true,
        sourceUpdatedAt: true,
        lastSyncedAt: true,
        syncStatus: true,
      },
    }),
    db.courseEvidence.findMany({
      where: { courseId: course.id },
      select: {
        sourceKey: true,
        bodyText: true,
        remoteUpdatedAt: true,
        provenance: true,
      },
    }),
    db.canvasMaterialCandidate.findMany({
      where: { courseId: course.id },
      select: {
        contentId: true,
        sourceKind: true,
        requested: true,
        status: true,
        remoteUpdatedAt: true,
        remoteSize: true,
        lastSeenAt: true,
      },
    }),
  ]);

  const syntheticMaterials = evidenceRows.flatMap((evidence) => {
    const provenance = Array.isArray(evidence.provenance) ? evidence.provenance : [];
    return provenance
      .map((entry) => {
        const record = entry && typeof entry === "object" && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : null;
        return {
          sourceKind: typeof record?.rawSourceKind === "string" ? record.rawSourceKind : null,
          sourceKey: typeof record?.sourceKey === "string" ? record.sourceKey : null,
        };
      })
      .filter((entry): entry is { sourceKind: string; sourceKey: string } =>
        typeof entry.sourceKind === "string" &&
        ["canvas_syllabus", "canvas_module", "canvas_media"].includes(entry.sourceKind) &&
        Boolean(entry.sourceKey),
      )
      .map((entry) => ({
        sourceKind: entry.sourceKind,
        sourceKey: entry.sourceKey,
        rawTextLength: evidence.bodyText?.length ?? 0,
        sourceUpdatedAt: evidence.remoteUpdatedAt?.toISOString() ?? null,
        lastSyncedAt: evidence.remoteUpdatedAt?.toISOString() ?? null,
        syncStatus: evidence.bodyText ? "ready" : "stale",
      }));
  });

  const mergedMaterials = new Map<string, {
    sourceKind: string;
    sourceKey: string;
    rawTextLength: number;
    sourceUpdatedAt: string | null;
    lastSyncedAt: string | null;
    syncStatus: string;
  }>();

  for (const material of materials) {
    if (!material.sourceKey) continue;
    mergedMaterials.set(`${material.sourceKind}:${material.sourceKey}`, {
      sourceKind: material.sourceKind,
      sourceKey: material.sourceKey,
      rawTextLength: material.rawText.length,
      sourceUpdatedAt: material.sourceUpdatedAt?.toISOString() ?? null,
      lastSyncedAt: material.lastSyncedAt?.toISOString() ?? null,
      syncStatus: material.syncStatus,
    });
  }

  for (const synthetic of syntheticMaterials) {
    const key = `${synthetic.sourceKind}:${synthetic.sourceKey}`;
    if (!mergedMaterials.has(key)) {
      mergedMaterials.set(key, synthetic);
    }
  }

  return withCors(
    NextResponse.json({
      knownCourse: true,
      materials: [...mergedMaterials.values()],
      candidates: candidates.map((candidate) => ({
        contentId: candidate.contentId,
        sourceKind: candidate.sourceKind,
        requested: candidate.requested,
        status: candidate.status,
        remoteUpdatedAt: candidate.remoteUpdatedAt ?? null,
        remoteSize: candidate.remoteSize ?? null,
        lastSeenAt: candidate.lastSeenAt.toISOString(),
      })),
    }),
  );
}
