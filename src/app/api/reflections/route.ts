import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const VALID_TYPES = ["task_completion", "post_assignment", "pre_class"];

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  if (!body.type || !VALID_TYPES.includes(body.type)) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  const reflection = await db.reflection.create({
    data: {
      userId: session.user.id,
      courseId: body.courseId ?? null,
      taskId: body.taskId ?? null,
      assignmentId: body.assignmentId ?? null,
      type: body.type,
      confidence: typeof body.confidence === "number" ? body.confidence : null,
      blocker: body.blocker ?? null,
      priorKnowledge: body.priorKnowledge ?? null,
      topics: body.topics ?? [],
      note: body.note ?? null,
    },
  });

  return NextResponse.json({ reflection }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const courseId = searchParams.get("courseId");
  const assignmentId = searchParams.get("assignmentId");
  const type = searchParams.get("type");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 50);

  const where: Record<string, unknown> = { userId: session.user.id };
  if (courseId) where.courseId = courseId;
  if (assignmentId) where.assignmentId = assignmentId;
  if (type) where.type = type;

  const reflections = await db.reflection.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ reflections });
}
