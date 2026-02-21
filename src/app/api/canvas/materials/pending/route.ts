import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import crypto from "crypto";

function sha256(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * GET /api/canvas/materials/pending?canvasCourseId=<id>
 *
 * Bearer token auth (same pattern as canvas/import).
 * Called by the extension at sync time to find out which candidates the
 * student has requested — so the extension can resolve their download URLs
 * and include them in the materialFileUrls for text extraction.
 *
 * Returns: { candidates: [{ contentId: string }] }
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization") ?? "";
  const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!rawToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hash = sha256(rawToken);
  const user = await db.user.findUnique({ where: { apiTokenHash: hash }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canvasCourseId = request.nextUrl.searchParams.get("canvasCourseId");
  if (!canvasCourseId) return NextResponse.json({ candidates: [] });

  // Find the Study Circle course matching this Canvas course ID
  const course = await db.course.findFirst({
    where: { userId: user.id, canvasCourseId },
    select: { id: true },
  });
  if (!course) return NextResponse.json({ candidates: [] });

  const candidates = await db.canvasMaterialCandidate.findMany({
    where: { courseId: course.id, requested: true },
    select: { contentId: true },
  });

  return NextResponse.json({ candidates });
}
