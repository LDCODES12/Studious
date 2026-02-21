import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

interface RouteParams {
  params: Promise<{ taskId: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { taskId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const task = await db.task.findFirst({
    where: { id: taskId, userId: session.user.id },
    select: { id: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const data: Record<string, unknown> = {};

  if (body.title !== undefined) data.title = body.title;
  if (body.description !== undefined) data.description = body.description;
  if (body.dueDate !== undefined) data.dueDate = body.dueDate;
  if (body.dueTime !== undefined) data.dueTime = body.dueTime;
  if (body.priority !== undefined) data.priority = body.priority;

  if (body.completed !== undefined) {
    data.completed = body.completed;
    data.completedAt = body.completed ? new Date() : null;
  }

  const updated = await db.task.update({
    where: { id: taskId },
    data,
    include: {
      course: { select: { id: true, name: true, shortName: true, color: true } },
    },
  });

  return NextResponse.json({ task: updated });
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { taskId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const task = await db.task.findFirst({
    where: { id: taskId, userId: session.user.id },
    select: { id: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.task.delete({ where: { id: taskId } });

  return NextResponse.json({ ok: true });
}
