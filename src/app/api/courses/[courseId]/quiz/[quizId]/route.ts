import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

interface RouteParams {
  params: Promise<{ courseId: string; quizId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId, quizId } = await params;

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const quiz = await db.quiz.findFirst({
    where: { id: quizId, courseId },
    include: { questions: true },
  });
  if (!quiz) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      createdAt: quiz.createdAt.toISOString(),
      questions: quiz.questions,
    },
  });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId, quizId } = await params;

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.quiz.deleteMany({ where: { id: quizId, courseId } });

  return NextResponse.json({ ok: true });
}
