"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Trash2, RotateCcw, ChevronRight, Layers, Sparkles, ArrowLeft } from "lucide-react";
import { format, parseISO } from "date-fns";

// ── Types ────────────────────────────────────────────────────────────────────

interface FlashcardData {
  id: string;
  front: string;
  back: string;
  confidence: number;
  nextReview?: string;
  reviewCount?: number;
}

interface DeckSummary {
  id: string;
  title: string;
  createdAt: string;
  cardCount: number;
  dueCount: number;
}

interface DeckDetail {
  id: string;
  title: string;
  cards: FlashcardData[];
}

interface CourseMaterial {
  id: string;
  fileName: string;
  detectedType: string;
  relatedTopics: string[];
  storedForAI: boolean;
}

interface FlashcardSectionProps {
  courseId: string;
  hasStudyMaterials: boolean;
  materials: CourseMaterial[];
}

const CONFIDENCE_LABELS = ["Again", "Hard", "Good", "Easy"] as const;
const CONFIDENCE_COLORS = [
  "border-red-400 bg-red-50 text-red-700 hover:bg-red-100",
  "border-orange-400 bg-orange-50 text-orange-700 hover:bg-orange-100",
  "border-blue-400 bg-blue-50 text-blue-700 hover:bg-blue-100",
  "border-green-400 bg-green-50 text-green-700 hover:bg-green-100",
] as const;

const CONFIDENCE_KEYS = ["1", "2", "3", "4"];

// ── Flashcard flip component ─────────────────────────────────────────────────

function FlashcardFlip({
  card,
  flipped,
  onFlip,
}: {
  card: FlashcardData;
  flipped: boolean;
  onFlip: () => void;
}) {
  return (
    <div
      className="perspective-[1000px] cursor-pointer select-none"
      style={{ minHeight: 280 }}
      onClick={onFlip}
    >
      <div
        className={cn(
          "relative h-full w-full transition-transform duration-500",
          "[transform-style:preserve-3d]",
          flipped && "[transform:rotateY(180deg)]"
        )}
        style={{ minHeight: 280 }}
      >
        {/* Front */}
        <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl border-2 border-border bg-card p-8 text-center shadow-sm [backface-visibility:hidden]">
          <div className="mb-4 rounded-full bg-muted px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Question
          </div>
          <p className="text-lg font-medium leading-relaxed">{card.front}</p>
          <p className="mt-6 text-[11px] text-muted-foreground">
            Click or press Space to reveal
          </p>
        </div>

        {/* Back */}
        <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl border-2 border-primary/20 bg-card p-8 text-center shadow-sm [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <div className="mb-4 rounded-full bg-primary/10 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-primary">
            Answer
          </div>
          <p className="text-base leading-relaxed">{card.back}</p>
        </div>
      </div>
    </div>
  );
}

// ── Study session ────────────────────────────────────────────────────────────

function StudySession({
  courseId,
  deck,
  onExit,
  onUpdateCard,
}: {
  courseId: string;
  deck: DeckDetail;
  onExit: () => void;
  onUpdateCard: (cardId: string, confidence: number) => void;
}) {
  const dueCards = deck.cards.filter(
    (c) => !c.nextReview || new Date(c.nextReview) <= new Date()
  );
  const studyQueue = dueCards.length > 0 ? dueCards : deck.cards;

  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [sessionScores, setSessionScores] = useState<number[]>([]);
  const [finished, setFinished] = useState(false);

  const card = studyQueue[currentIndex];

  const handleConfidence = useCallback(
    async (confidence: number) => {
      if (!card) return;

      setSessionScores((s) => [...s, confidence]);
      setReviewed((r) => r + 1);

      try {
        await fetch(`/api/courses/${courseId}/flashcards/${deck.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardId: card.id, confidence }),
        });
        onUpdateCard(card.id, confidence);
      } catch { /* non-fatal */ }

      if (currentIndex + 1 >= studyQueue.length) {
        setFinished(true);
      } else {
        setCurrentIndex((i) => i + 1);
        setFlipped(false);
      }
    },
    [card, courseId, deck.id, currentIndex, studyQueue.length, onUpdateCard]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!flipped) {
          setFlipped(true);
        }
      }
      if (flipped && CONFIDENCE_KEYS.includes(e.key)) {
        handleConfidence(parseInt(e.key) - 1);
      }
      if (e.key === "Escape") {
        onExit();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [flipped, handleConfidence, onExit]);

  if (finished) {
    const avg = sessionScores.length > 0
      ? sessionScores.reduce((a, b) => a + b, 0) / sessionScores.length
      : 0;
    const mastered = sessionScores.filter((s) => s >= 2).length;

    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <Sparkles className="h-8 w-8 text-green-600" />
          </div>
          <h3 className="text-xl font-semibold">Session Complete</h3>
          <p className="mt-2 text-muted-foreground">
            You reviewed {reviewed} card{reviewed !== 1 ? "s" : ""}
          </p>

          <div className="mx-auto mt-6 grid max-w-xs grid-cols-3 gap-4">
            <div className="rounded-lg bg-muted p-3">
              <p className="text-2xl font-bold">{reviewed}</p>
              <p className="text-[11px] text-muted-foreground">Reviewed</p>
            </div>
            <div className="rounded-lg bg-muted p-3">
              <p className="text-2xl font-bold">{mastered}</p>
              <p className="text-[11px] text-muted-foreground">Good+</p>
            </div>
            <div className="rounded-lg bg-muted p-3">
              <p className="text-2xl font-bold">{avg.toFixed(1)}</p>
              <p className="text-[11px] text-muted-foreground">Avg Score</p>
            </div>
          </div>

          <div className="mt-6 flex justify-center gap-3">
            <button
              onClick={() => {
                setCurrentIndex(0);
                setFlipped(false);
                setReviewed(0);
                setSessionScores([]);
                setFinished(false);
              }}
              className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium hover:bg-accent"
            >
              <RotateCcw className="mr-1.5 inline h-3.5 w-3.5" />
              Study Again
            </button>
            <button
              onClick={onExit}
              className="rounded-lg bg-foreground px-4 py-2 text-[13px] font-medium text-background hover:opacity-90"
            >
              Back to Decks
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!card) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          onClick={onExit}
          className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Exit
        </button>
        <span className="text-[12px] text-muted-foreground">
          {currentIndex + 1} / {studyQueue.length}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full rounded-full bg-border">
        <div
          className="h-1.5 rounded-full bg-foreground transition-all duration-300"
          style={{ width: `${((currentIndex + (flipped ? 0.5 : 0)) / studyQueue.length) * 100}%` }}
        />
      </div>

      {/* Card */}
      <FlashcardFlip card={card} flipped={flipped} onFlip={() => setFlipped((f) => !f)} />

      {/* Confidence buttons (visible when flipped) */}
      {flipped && (
        <div className="space-y-2">
          <p className="text-center text-[11px] text-muted-foreground">
            How well did you know this? (keys 1-4)
          </p>
          <div className="grid grid-cols-4 gap-2">
            {CONFIDENCE_LABELS.map((label, i) => (
              <button
                key={i}
                onClick={() => handleConfidence(i)}
                className={cn(
                  "rounded-lg border-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
                  CONFIDENCE_COLORS[i]
                )}
              >
                <span className="mr-1 text-[10px] opacity-60">{i + 1}</span> {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function FlashcardSection({ courseId, hasStudyMaterials, materials }: FlashcardSectionProps) {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [activeDeck, setActiveDeck] = useState<DeckDetail | null>(null);

  useEffect(() => {
    fetch(`/api/courses/${courseId}/flashcards`)
      .then((r) => r.json())
      .then((d) => setDecks(d.decks ?? []))
      .catch(() => {})
      .finally(() => setLoadingList(false));
  }, [courseId]);

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch(`/api/courses/${courseId}/flashcards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setGenerateError(data.error ?? "Failed to generate flashcards.");
        return;
      }
      setDecks((prev) => [
        {
          id: data.deck.id,
          title: data.deck.title,
          createdAt: data.deck.createdAt,
          cardCount: data.deck.cardCount,
          dueCount: data.deck.dueCount,
        },
        ...prev,
      ]);
      setActiveDeck({
        id: data.deck.id,
        title: data.deck.title,
        cards: data.deck.cards,
      });
    } catch {
      setGenerateError("Failed to generate flashcards. Please try again.");
    } finally {
      setGenerating(false);
    }
  };

  const handleLoadDeck = async (deckId: string) => {
    try {
      const res = await fetch(`/api/courses/${courseId}/flashcards/${deckId}`);
      const data = await res.json();
      if (res.ok) setActiveDeck(data.deck);
    } catch { /* ignore */ }
  };

  const handleDeleteDeck = async (deckId: string) => {
    await fetch(`/api/courses/${courseId}/flashcards/${deckId}`, { method: "DELETE" });
    setDecks((prev) => prev.filter((d) => d.id !== deckId));
  };

  const handleUpdateCard = (cardId: string, confidence: number) => {
    if (!activeDeck) return;
    setActiveDeck((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        cards: prev.cards.map((c) =>
          c.id === cardId ? { ...c, confidence } : c
        ),
      };
    });
  };

  // ── Active study session ──
  if (activeDeck) {
    return (
      <StudySession
        courseId={courseId}
        deck={activeDeck}
        onExit={() => setActiveDeck(null)}
        onUpdateCard={handleUpdateCard}
      />
    );
  }

  // ── Deck list ──
  return (
    <div className="space-y-4">
      {!hasStudyMaterials && (
        <div className="rounded-lg border border-border bg-accent/20 px-4 py-3">
          <p className="text-[13px] text-muted-foreground">
            Upload lecture notes or slides in the Materials tab to generate flashcards.
          </p>
        </div>
      )}

      {generateError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {generateError}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleGenerate}
          disabled={generating || !hasStudyMaterials}
          className="rounded-lg bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {generating ? (
            <>
              <Sparkles className="mr-1.5 inline h-3.5 w-3.5 animate-pulse" />
              Generating flashcards...
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 inline h-3.5 w-3.5" />
              Generate Flashcards
            </>
          )}
        </button>
      </div>

      {loadingList ? (
        <p className="text-[13px] text-muted-foreground">Loading...</p>
      ) : decks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center">
          <Layers className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
          <p className="text-[14px] font-medium text-muted-foreground">No flashcard decks yet</p>
          <p className="mt-1 text-[12px] text-muted-foreground/70">
            Generate a deck from your course materials to start studying
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {decks.map((d) => (
            <div
              key={d.id}
              className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/30"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Layers className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{d.title}</p>
                <p className="text-[11px] text-muted-foreground">
                  {d.cardCount} cards
                  {d.dueCount > 0 && (
                    <span className="ml-1.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                      {d.dueCount} due
                    </span>
                  )}
                  <span className="mx-1.5">·</span>
                  {format(parseISO(d.createdAt), "MMM d, yyyy")}
                </p>
              </div>
              <button
                onClick={() => handleLoadDeck(d.id)}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-accent"
              >
                Study
                <ChevronRight className="h-3 w-3" />
              </button>
              <button
                onClick={() => handleDeleteDeck(d.id)}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
