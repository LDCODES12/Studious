import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * PATCH /api/courses/[courseId]/materials/candidates/[candidateId]
 *
 * Session auth. Toggles `requested` on a candidate — called when student
 * clicks "Add" or "Cancel" on a file in the Materials tab.
 *
 * Body: { requested: boolean }
 * Returns: { id, requested }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string; candidateId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, candidateId } = await params;

  // Verify ownership
  const candidate = await db.canvasMaterialCandidate.findUnique({
    where: { id: candidateId },
    select: { id: true, courseId: true },
  });
  if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const course = await db.course.findUnique({
    where: { id: candidate.courseId, userId: session.user.id },
    select: { id: true },
  });
  if (!course || course.id !== courseId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { requested } = await request.json() as { requested: boolean };

  const updated = await db.canvasMaterialCandidate.update({
    where: { id: candidateId },
    data: { requested },
    select: { id: true, requested: true },
  });

  return NextResponse.json(updated);
}
