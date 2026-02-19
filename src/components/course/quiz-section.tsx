"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Trash2 } from "lucide-react";
import { format, parseISO } from "date-fns";

interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string | null;
}

interface QuizSummary {
  id: string;
  title: string;
  createdAt: string;
  questionCount: number;
}

interface ActiveQuiz {
  id: string;
  title: string;
  questions: QuizQuestion[];
}

interface QuizSectionProps {
  courseId: string;
  hasStudyMaterials: boolean;
}

export function QuizSection({ courseId, hasStudyMaterials }: QuizSectionProps) {
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [activeQuiz, setActiveQuiz] = useState<ActiveQuiz | null>(null);

  // Quiz-taking state
  const [currentQ, setCurrentQ] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [answered, setAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    fetch(`/api/courses/${courseId}/quiz`)
      .then((r) => r.json())
      .then((d) => setQuizzes(d.quizzes ?? []))
      .catch(() => {})
      .finally(() => setLoadingList(false));
  }, [courseId]);

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch(`/api/courses/${courseId}/quiz`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setGenerateError(data.error ?? "Failed to generate quiz.");
        return;
      }
      // Add to list and start immediately
      setQuizzes((prev) => [
        { id: data.quiz.id, title: data.quiz.title, createdAt: data.quiz.createdAt, questionCount: data.quiz.questions.length },
        ...prev,
      ]);
      startQuiz(data.quiz);
    } catch {
      setGenerateError("Failed to generate quiz. Please try again.");
    } finally {
      setGenerating(false);
    }
  };

  const handleLoadQuiz = async (quizId: string) => {
    const res = await fetch(`/api/courses/${courseId}/quiz/${quizId}`);
    const data = await res.json();
    if (res.ok) startQuiz(data.quiz);
  };

  const handleDeleteQuiz = async (quizId: string) => {
    await fetch(`/api/courses/${courseId}/quiz/${quizId}`, { method: "DELETE" });
    setQuizzes((prev) => prev.filter((q) => q.id !== quizId));
  };

  const startQuiz = (quiz: ActiveQuiz) => {
    setActiveQuiz(quiz);
    setCurrentQ(0);
    setSelectedIndex(null);
    setAnswered(false);
    setScore(0);
    setFinished(false);
  };

  const handleAnswer = (index: number) => {
    if (answered) return;
    setSelectedIndex(index);
    setAnswered(true);
    if (activeQuiz && index === activeQuiz.questions[currentQ].correctIndex) {
      setScore((s) => s + 1);
    }
  };

  const handleNext = () => {
    if (!activeQuiz) return;
    if (currentQ + 1 >= activeQuiz.questions.length) {
      setFinished(true);
    } else {
      setCurrentQ((q) => q + 1);
      setSelectedIndex(null);
      setAnswered(false);
    }
  };

  const exitQuiz = () => {
    setActiveQuiz(null);
    setFinished(false);
  };

  // ── Active quiz mode ──
  if (activeQuiz) {
    const q = activeQuiz.questions[currentQ];

    if (finished) {
      const pct = Math.round((score / activeQuiz.questions.length) * 100);
      return (
        <div className="rounded-lg border border-border bg-card p-6 text-center space-y-4">
          <p className="text-2xl font-semibold">{score} / {activeQuiz.questions.length}</p>
          <p className="text-[13px] text-muted-foreground">
            {pct >= 80 ? "Great work! 🎉" : pct >= 60 ? "Good effort — keep studying!" : "Keep reviewing the material and try again."}
          </p>
          <div className="flex justify-center gap-3 pt-2">
            <button
              onClick={() => startQuiz(activeQuiz)}
              className="rounded-md border border-border px-4 py-2 text-[13px] font-medium hover:bg-accent"
            >
              Try Again
            </button>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {generating ? "Generating..." : "New Quiz"}
            </button>
            <button
              onClick={exitQuiz}
              className="rounded-md border border-border px-4 py-2 text-[13px] font-medium hover:bg-accent"
            >
              Back to List
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-[12px] text-muted-foreground">
            Question {currentQ + 1} / {activeQuiz.questions.length}
          </p>
          <button onClick={exitQuiz} className="text-[12px] text-muted-foreground hover:text-foreground">
            Exit quiz
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 w-full rounded-full bg-border">
          <div
            className="h-1 rounded-full bg-foreground transition-all"
            style={{ width: `${((currentQ + (answered ? 1 : 0)) / activeQuiz.questions.length) * 100}%` }}
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <p className="text-[14px] font-medium leading-snug">{q.question}</p>

          <div className="space-y-2">
            {q.options.map((opt, i) => {
              const isCorrect = i === q.correctIndex;
              const isSelected = i === selectedIndex;
              return (
                <button
                  key={i}
                  onClick={() => handleAnswer(i)}
                  disabled={answered}
                  className={cn(
                    "w-full rounded-md border px-4 py-2.5 text-left text-[13px] transition-colors",
                    !answered && "hover:bg-accent border-border",
                    answered && isCorrect && "border-green-400 bg-green-50 text-green-800",
                    answered && isSelected && !isCorrect && "border-red-400 bg-red-50 text-red-800",
                    answered && !isSelected && !isCorrect && "border-border text-muted-foreground opacity-60"
                  )}
                >
                  <span className="mr-2 font-medium">{["A", "B", "C", "D"][i]}.</span>
                  {opt}
                </button>
              );
            })}
          </div>

          {answered && q.explanation && (
            <div className="rounded-md bg-accent/50 px-3 py-2">
              <p className="text-[12px] text-muted-foreground">{q.explanation}</p>
            </div>
          )}

          {answered && (
            <div className="flex justify-end">
              <button
                onClick={handleNext}
                className="rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background hover:opacity-90"
              >
                {currentQ + 1 >= activeQuiz.questions.length ? "See Results" : "Next →"}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Quiz list / generate view ──
  return (
    <div className="space-y-4">
      {!hasStudyMaterials && (
        <div className="rounded-lg border border-border bg-accent/20 px-4 py-3">
          <p className="text-[13px] text-muted-foreground">
            Upload lecture notes or slides in the Materials tab to enable quiz generation.
          </p>
        </div>
      )}

      {generateError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {generateError}
        </div>
      )}

      <button
        onClick={handleGenerate}
        disabled={generating || !hasStudyMaterials}
        className="rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {generating ? "Generating quiz..." : "Generate Quiz from Materials"}
      </button>

      {loadingList ? (
        <p className="text-[13px] text-muted-foreground">Loading...</p>
      ) : quizzes.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
          <p className="text-[13px] text-muted-foreground">No quizzes yet. Generate one to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {quizzes.map((q) => (
            <div
              key={q.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{q.title}</p>
                <p className="text-[12px] text-muted-foreground">
                  {q.questionCount} questions · {format(parseISO(q.createdAt), "MMM d, yyyy")}
                </p>
              </div>
              <button
                onClick={() => handleLoadQuiz(q.id)}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-accent"
              >
                Take Quiz
              </button>
              <button
                onClick={() => handleDeleteQuiz(q.id)}
                className="shrink-0 text-muted-foreground hover:text-red-500"
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
