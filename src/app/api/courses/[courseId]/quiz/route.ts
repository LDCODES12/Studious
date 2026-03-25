import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generateObject } from "ai";
import { modelConfig } from "@/lib/ai-models";
import { z } from "zod";

const quizSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()).length(4),
      correctIndex: z.number().int().min(0).max(3),
      explanation: z.string().nullable(),
    })
  ),
});

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const log = apiLogger("GET /api/courses/quiz", session.user.id);
  const { courseId } = await params;

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return log.respond(NextResponse.json({ error: "Not found" }, { status: 404 }));

  const quizzes = await db.quiz.findMany({
    where: { courseId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { questions: true } } },
  });

  return log.respond(
    NextResponse.json({
      quizzes: quizzes.map((q) => ({
        id: q.id,
        title: q.title,
        createdAt: q.createdAt.toISOString(),
        questionCount: q._count.questions,
      })),
    }),
    { courseId, quizCount: quizzes.length },
  );
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const log = apiLogger("POST /api/courses/quiz", session.user.id);
  const { courseId } = await params;
  const { title, materialIds } = ((await request.json().catch(() => ({}))) as {
    title?: string;
    materialIds?: string[];
  }) ?? {};

  log.info("quiz generation started", { courseId, materialIds: materialIds?.length ?? 0 });

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return log.respond(NextResponse.json({ error: "Not found" }, { status: 404 }));

  // Fetch study materials — optionally filtered to specific file IDs
  const materials = await db.courseMaterial.findMany({
    where: {
      courseId,
      storedForAI: true,
      ...(materialIds && materialIds.length > 0 ? { id: { in: materialIds } } : {}),
    },
    select: { rawText: true, fileName: true, detectedType: true },
  });

  if (materials.length === 0) {
    return log.respond(NextResponse.json(
      { error: "No study materials uploaded yet. Upload lecture notes or slides first." },
      { status: 400 }
    ));
  }

  // Concatenate rawText up to 60k chars
  let combinedText = "";
  for (const m of materials) {
    if (combinedText.length >= 60000) break;
    combinedText += `\n\n--- ${m.fileName} ---\n${m.rawText}`;
  }
  combinedText = combinedText.slice(0, 60000);

  let questions: { question: string; options: string[]; correctIndex: number; explanation: string | null }[];
  try {
    const { object } = await generateObject({
      ...modelConfig("medium"),
      schema: quizSchema,
      system: `You are a quiz generator for university students. Based on the provided course material, generate exactly 8 multiple choice questions that test conceptual understanding.

Rules:
- Questions should test understanding, not just memorization
- Each question has exactly 4 answer options
- Only one option is correct
- Include a brief explanation of why the answer is correct
- Vary difficulty (2 easy, 4 medium, 2 hard)
- Do NOT ask about page numbers, dates, or administrative details`,
      prompt: `Course: ${course.name}\n\nMaterial:\n${combinedText}`,
      abortSignal: AbortSignal.timeout(45_000),
    });
    questions = object.questions;
  } catch {
    return log.respond(NextResponse.json({ error: "Failed to generate quiz" }, { status: 500 }));
  }

  const quizTitle = title || `${course.name} Quiz — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  const quiz = await db.quiz.create({
    data: {
      courseId,
      title: quizTitle,
      questions: {
        create: questions.map((q) => ({
          question: q.question,
          options: q.options,
          correctIndex: q.correctIndex,
          explanation: q.explanation ?? null,
        })),
      },
    },
    include: { questions: true },
  });

  return log.respond(
    NextResponse.json({
      quiz: {
        id: quiz.id,
        title: quiz.title,
        createdAt: quiz.createdAt.toISOString(),
        questions: quiz.questions,
      },
    }),
    { courseId, questionCount: quiz.questions.length },
  );
}
