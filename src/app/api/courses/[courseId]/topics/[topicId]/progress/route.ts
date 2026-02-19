import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

interface RouteParams {
  params: Promise<{ courseId: string; topicId: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId, topicId } = await params;
  const { completedTopics } = (await request.json()) as { completedTopics: string[] };

  // Verify course ownership
  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await db.courseTopic.update({
    where: { id: topicId, courseId },
    data: { completedTopics },
  });

  return NextResponse.json({ ok: true, completedTopics: updated.completedTopics });
}
