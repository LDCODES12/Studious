import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId } = await params;

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const quizzes = await db.quiz.findMany({
    where: { courseId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { questions: true } } },
  });

  return NextResponse.json({
    quizzes: quizzes.map((q) => ({
      id: q.id,
      title: q.title,
      createdAt: q.createdAt.toISOString(),
      questionCount: q._count.questions,
    })),
  });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId } = await params;
  const { title, materialIds } = ((await request.json().catch(() => ({}))) as {
    title?: string;
    materialIds?: string[];
  }) ?? {};

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
    return NextResponse.json(
      { error: "No study materials uploaded yet. Upload lecture notes or slides first." },
      { status: 400 }
    );
  }

  // Concatenate rawText up to 24k chars
  let combinedText = "";
  for (const m of materials) {
    if (combinedText.length >= 24000) break;
    combinedText += `\n\n--- ${m.fileName} ---\n${m.rawText}`;
  }
  combinedText = combinedText.slice(0, 24000);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a quiz generator for university students. Based on the provided course material, generate exactly 8 multiple choice questions that test conceptual understanding.

Rules:
- Questions should test understanding, not just memorization
- Each question has exactly 4 answer options
- Only one option is correct
- Include a brief explanation of why the answer is correct
- Vary difficulty (2 easy, 4 medium, 2 hard)
- Do NOT ask about page numbers, dates, or administrative details

Return JSON with a "questions" array. Each item must have:
- question: the question text
- options: array of exactly 4 strings
- correctIndex: 0-3 (index of the correct option)
- explanation: 1-2 sentence explanation of the correct answer`,
      },
      {
        role: "user",
        content: `Course: ${course.name}\n\nMaterial:\n${combinedText}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return NextResponse.json({ error: "Failed to generate quiz" }, { status: 500 });
  }

  let questions: { question: string; options: string[]; correctIndex: number; explanation?: string }[];
  try {
    const parsed = JSON.parse(content);
    questions = parsed.questions ?? [];
  } catch {
    return NextResponse.json({ error: "Failed to parse quiz" }, { status: 500 });
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

  return NextResponse.json({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      createdAt: quiz.createdAt.toISOString(),
      questions: quiz.questions,
    },
  });
}
