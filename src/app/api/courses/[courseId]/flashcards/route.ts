import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateObject } from "ai";
import { modelConfig } from "@/lib/ai-models";
import { z } from "zod";
import { formatGenerationEvidenceForPrompt, resolveStudyEvidence } from "@/lib/source-aware-evidence";

const flashcardSchema = z.object({
  cards: z.array(z.object({ front: z.string(), back: z.string() })),
});

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

  const decks = await db.flashcardDeck.findMany({
    where: { courseId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { cards: true } },
      cards: {
        where: { nextReview: { lte: new Date() } },
        select: { id: true },
      },
    },
  });

  return NextResponse.json({
    decks: decks.map((d) => ({
      id: d.id,
      title: d.title,
      createdAt: d.createdAt.toISOString(),
      cardCount: d._count.cards,
      dueCount: d.cards.length,
    })),
  });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId } = await params;
  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const { materialIds, title } = body as { materialIds?: string[]; title?: string };

  const evidence = await resolveStudyEvidence({
    courseId,
    courseName: course.name,
    materialIds,
    storedForAIOnly: true,
  });

  if (evidence.canonicalMaterials.length === 0 && evidence.transcriptMaterials.length === 0) {
    return NextResponse.json(
      { error: "No study materials available. Upload lecture notes or slides first." },
      { status: 400 }
    );
  }

  const materialPrompt = formatGenerationEvidenceForPrompt(evidence, "flashcards");

  let cards: { front: string; back: string }[];
  try {
    const { object } = await generateObject({
      ...modelConfig("medium"),
      schema: flashcardSchema,
      system: `You are a flashcard generator for university students. Create flashcards from the provided course material that test understanding of key concepts, definitions, formulas, and relationships.

Rules:
- Generate 15-20 flashcards
- Front: a clear, specific question or prompt (one concept per card)
- Back: a concise, accurate answer (1-3 sentences)
- Mix difficulty: definitions, conceptual understanding, application
- Include key formulas/equations where relevant (use plain text notation)
- Avoid trivial facts like page numbers or dates
- Make the front side specific enough to have ONE clear answer
- Use canonical course content as the main conceptual backbone when it exists
- Use lecture transcript evidence to sharpen emphasis, examples, clarifications, and likely confusions
- If transcripts are the only strong source, use them fully rather than withholding value`,
      prompt: `Course: ${course.name}\n\n${materialPrompt}`,
      abortSignal: AbortSignal.timeout(45_000),
    });
    cards = object.cards;
  } catch {
    return NextResponse.json({ error: "Failed to generate flashcards" }, { status: 500 });
  }

  const deckTitle = title || `${course.name} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  const deck = await db.flashcardDeck.create({
    data: {
      courseId,
      title: deckTitle,
      cards: {
        create: cards.map((c) => ({
          front: c.front,
          back: c.back,
        })),
      },
    },
    include: { cards: true },
  });

  return NextResponse.json({
    deck: {
      id: deck.id,
      title: deck.title,
      createdAt: deck.createdAt.toISOString(),
      cardCount: deck.cards.length,
      dueCount: deck.cards.length,
      cards: deck.cards.map((c) => ({
        id: c.id,
        front: c.front,
        back: c.back,
        confidence: c.confidence,
      })),
    },
  });
}
