"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

interface CourseMaterial {
  id: string;
  fileName: string;
  detectedType: string;
  summary: string;
  relatedTopics: string[];
  storedForAI?: boolean;
  uploadedAt: string;
}

const typeLabels: Record<string, string> = {
  problem_set: "Problem Set",
  lecture_notes: "Lecture Notes",
  lecture_slides: "Lecture Slides",
  textbook: "Textbook",
  syllabus: "Syllabus",
  other: "Other",
};

const typeBadgeColor: Record<string, string> = {
  problem_set: "bg-orange-100 text-orange-700",
  lecture_notes: "bg-blue-100 text-blue-700",
  lecture_slides: "bg-purple-100 text-purple-700",
  syllabus: "bg-green-100 text-green-700",
  other: "bg-gray-100 text-gray-600",
};

export function MaterialCard({
  material,
  onToggleStoredForAI,
}: {
  material: CourseMaterial;
  onToggleStoredForAI?: (materialId: string, storedForAI: boolean) => Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);

  const handleToggle = async () => {
    if (!onToggleStoredForAI || toggling) return;
    setToggling(true);
    try {
      await onToggleStoredForAI(material.id, !material.storedForAI);
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{material.fileName}</p>
          {material.summary && (
            <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">
              {material.summary}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium",
              typeBadgeColor[material.detectedType] ?? typeBadgeColor.other
            )}
          >
            {typeLabels[material.detectedType] ?? "Other"}
          </span>
          <button
            onClick={handleToggle}
            disabled={toggling}
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
              material.storedForAI
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200",
              toggling && "opacity-50 cursor-wait"
            )}
          >
            {material.storedForAI ? "Quiz-ready" : "Not in quizzes"}
          </button>
        </div>
      </div>

      {material.relatedTopics.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {material.relatedTopics.map((t, i) => (
            <span
              key={i}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">
        {format(parseISO(material.uploadedAt), "MMM d, yyyy")}
      </p>
    </div>
  );
}
