import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { analyzeCourseMaterial } from "@/lib/analyze-material";
import pdfParse from "pdf-parse";

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { courseId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
    include: { topics: { select: { weekLabel: true } } },
  });

  if (!course) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let text = "";
  try {
    const pdfData = await pdfParse(buffer);
    text = pdfData.text;
  } catch {
    return NextResponse.json({ error: "Failed to extract PDF text" }, { status: 400 });
  }

  const topicLabels = course.topics.map((t) => t.weekLabel);
  const analysis = await analyzeCourseMaterial(text, topicLabels);

  const storedForAI = ["lecture_notes", "lecture_slides", "textbook"].includes(analysis.detectedType);

  const material = await db.courseMaterial.create({
    data: {
      courseId,
      fileName: file.name,
      detectedType: analysis.detectedType,
      summary: analysis.summary,
      relatedTopics: analysis.relatedTopics,
      rawText: text.slice(0, 10000),
      storedForAI,
    },
  });

  return NextResponse.json(
    {
      id: material.id,
      courseId: material.courseId,
      fileName: material.fileName,
      detectedType: material.detectedType,
      summary: material.summary,
      relatedTopics: material.relatedTopics,
      storedForAI: material.storedForAI,
      uploadedAt: material.uploadedAt.toISOString(),
    },
    { status: 201 }
  );
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { courseId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });

  if (!course) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const materials = await db.courseMaterial.findMany({
    where: { courseId },
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      courseId: true,
      fileName: true,
      detectedType: true,
      summary: true,
      relatedTopics: true,
      storedForAI: true,
      uploadedAt: true,
    },
  });

  return NextResponse.json({
    materials: materials.map((m) => ({
      ...m,
      uploadedAt: m.uploadedAt.toISOString(),
    })),
  });
}
