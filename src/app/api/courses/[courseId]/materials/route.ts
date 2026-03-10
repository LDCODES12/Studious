import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { analyzeCourseMaterial, inferMaterialSourceRole } from "@/lib/analyze-material";

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

  // Text is extracted client-side by the uploader using pdfjs-dist —
  // the server receives plain text, no binary PDF processing needed.
  const body = await request.json();
  const { fileName, text } = body as { fileName?: string; text?: string };

  if (!fileName || typeof text !== "string") {
    return NextResponse.json(
      { error: "fileName and text are required" },
      { status: 400 }
    );
  }

  const topicLabels = course.topics.map((t) => t.weekLabel);
  const analysis = await analyzeCourseMaterial(text, topicLabels);

  const storedForAI = ["lecture_notes", "lecture_slides", "textbook"].includes(analysis.detectedType);

  const material = await db.courseMaterial.create({
    data: {
      courseId,
      fileName,
      detectedType: analysis.detectedType,
      sourceRole: inferMaterialSourceRole(analysis.detectedType, fileName),
      summary: analysis.summary,
      relatedTopics: analysis.relatedTopics,
      rawText: text.slice(0, 25000),
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
      sourceRole: material.sourceRole,
      storedForAI: material.storedForAI,
      uploadedAt: material.uploadedAt.toISOString(),
    },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { courseId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { materialId, storedForAI } = body as { materialId?: string; storedForAI?: boolean };

  if (!materialId || typeof storedForAI !== "boolean") {
    return NextResponse.json(
      { error: "materialId and storedForAI (boolean) are required" },
      { status: 400 }
    );
  }

  const material = await db.courseMaterial.findFirst({
    where: { id: materialId, courseId, course: { userId: session.user.id } },
  });

  if (!material) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await db.courseMaterial.update({
    where: { id: materialId },
    data: { storedForAI },
  });

  return NextResponse.json({
    id: updated.id,
    storedForAI: updated.storedForAI,
  });
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
      sourceRole: true,
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
