import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

interface RouteParams {
  params: Promise<{ courseId: string; deckId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId, deckId } = await params;
  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const deck = await db.flashcardDeck.findFirst({
    where: { id: deckId, courseId },
    include: {
      cards: { orderBy: { nextReview: "asc" } },
    },
  });
  if (!deck) return NextResponse.json({ error: "Deck not found" }, { status: 404 });

  return NextResponse.json({
    deck: {
      id: deck.id,
      title: deck.title,
      createdAt: deck.createdAt.toISOString(),
      cards: deck.cards.map((c) => ({
        id: c.id,
        front: c.front,
        back: c.back,
        confidence: c.confidence,
        nextReview: c.nextReview.toISOString(),
        reviewCount: c.reviewCount,
      })),
    },
  });
}

/** PATCH — update card confidence after review */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId, deckId } = await params;
  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const { cardId, confidence } = body as { cardId?: string; confidence?: number };

  if (!cardId || typeof confidence !== "number" || confidence < 0 || confidence > 3) {
    return NextResponse.json(
      { error: "cardId and confidence (0-3) are required" },
      { status: 400 }
    );
  }

  const card = await db.flashcard.findFirst({
    where: { id: cardId, deckId, deck: { courseId } },
  });
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });

  // Spaced repetition intervals (in hours)
  // 0=again (10min), 1=hard (1h), 2=okay (1 day), 3=easy (3 days, scaling with review count)
  const intervals: Record<number, number> = {
    0: 1 / 6,
    1: 1,
    2: 24,
    3: Math.min(24 * 3 * Math.max(card.reviewCount, 1), 24 * 30),
  };

  const hoursUntilNext = intervals[confidence] ?? 24;
  const nextReview = new Date(Date.now() + hoursUntilNext * 60 * 60 * 1000);

  const updated = await db.flashcard.update({
    where: { id: cardId },
    data: {
      confidence,
      nextReview,
      reviewCount: card.reviewCount + 1,
    },
  });

  return NextResponse.json({
    id: updated.id,
    confidence: updated.confidence,
    nextReview: updated.nextReview.toISOString(),
    reviewCount: updated.reviewCount,
  });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId, deckId } = await params;
  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.flashcardDeck.deleteMany({
    where: { id: deckId, courseId },
  });

  return NextResponse.json({ ok: true });
}
