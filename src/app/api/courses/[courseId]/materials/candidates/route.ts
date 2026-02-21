import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * GET /api/courses/[courseId]/materials/candidates
 *
 * Session auth. Returns all material candidates for this course grouped by
 * moduleName, so the UI can display a "From Canvas" section with module headers.
 *
 * Returns: { candidates: [{ id, fileName, moduleName, requested }] }
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId } = await params;

  const course = await db.course.findUnique({
    where: { id: courseId, userId: session.user.id },
    select: { id: true },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const candidates = await db.canvasMaterialCandidate.findMany({
    where: { courseId },
    select: { id: true, fileName: true, moduleName: true, requested: true },
    orderBy: [{ moduleName: "asc" }, { fileName: "asc" }],
  });

  return NextResponse.json({ candidates });
}
