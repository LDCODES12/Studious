import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status"); // "pending" | "completed"
  const courseId = searchParams.get("courseId");

  const where: Record<string, unknown> = { userId: session.user.id };
  if (status === "pending") where.completed = false;
  if (status === "completed") where.completed = true;
  if (courseId) where.courseId = courseId;

  const tasks = await db.task.findMany({
    where,
    include: {
      course: { select: { id: true, name: true, shortName: true, color: true } },
    },
    orderBy: [{ completed: "asc" }, { dueDate: "asc" }, { priority: "desc" }],
  });

  return NextResponse.json({ tasks });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { title, description, courseId, dueDate, dueTime, priority } = body;

  if (!title || typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  // Validate courseId belongs to user if provided
  if (courseId) {
    const course = await db.course.findFirst({
      where: { id: courseId, userId: session.user.id },
      select: { id: true },
    });
    if (!course) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }
  }

  const task = await db.task.create({
    data: {
      userId: session.user.id,
      courseId: courseId || null,
      title: title.trim(),
      description: description || null,
      dueDate: dueDate || null,
      dueTime: dueTime || null,
      priority: priority || "medium",
      source: "manual",
    },
    include: {
      course: { select: { id: true, name: true, shortName: true, color: true } },
    },
  });

  return NextResponse.json({ task }, { status: 201 });
}
