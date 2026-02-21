"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface AssignmentInGroup {
  id: string;
  title: string;
  score: number | null;
  pointsPossible: number | null;
  status: string;
  dueDate: string | null;
  excused: boolean;
  omitFromFinalGrade: boolean;
  canvasAssignmentId: string | null;
  missing?: boolean;
  late?: boolean;
  gradescopeScore?: number | null;
  gradescopeMaxScore?: number | null;
}

interface AssignmentGroupData {
  id: string;
  name: string;
  weight: number;
  position: number;
  dropLowest: number;
  dropHighest: number;
  neverDrop: string[];
  syllabusDropLowest: number;
  syllabusDropHighest: number;
  assignments: AssignmentInGroup[];
}

interface GradingSchemeEntry {
  name: string;
  value: number;
}

interface GradeBreakdownProps {
  assignmentGroups: AssignmentGroupData[];
  currentGrade: string | null;
  currentScore: number | null;
  gradingScheme: GradingSchemeEntry[] | null;
  applyGroupWeights: boolean;
}

interface GroupStats {
  earned: number;
  possible: number;
  percentage: number | null;
  gradedCount: number;
  totalCount: number;
  droppedIds: Set<string>;
}

function computeGroupStats(
  assignments: AssignmentInGroup[],
  dropLowest: number,
  dropHighest: number,
  neverDrop: string[],
  syllabusDropLowest = 0,
  syllabusDropHighest = 0,
): GroupStats {
  // Use Canvas rules first; fall back to syllabus-extracted rules
  const effectiveDropLowest = dropLowest > 0 ? dropLowest : syllabusDropLowest;
  const effectiveDropHighest = dropHighest > 0 ? dropHighest : syllabusDropHighest;
  dropLowest = effectiveDropLowest;
  dropHighest = effectiveDropHighest;
  // Exclude excused and omitFromFinalGrade assignments from ALL calculations
  const countable = assignments.filter((a) => !a.excused && !a.omitFromFinalGrade);

  const graded = countable
    .filter((a) => a.score != null && a.pointsPossible != null && a.pointsPossible > 0)
    .map((a) => ({
      id: a.id,
      canvasAssignmentId: a.canvasAssignmentId,
      score: a.score!,
      possible: a.pointsPossible!,
      pct: a.score! / a.pointsPossible!,
    }));

  // Separate into protected (never_drop) vs droppable
  const neverDropSet = new Set(neverDrop);
  const protectedAssignments = graded.filter(
    (g) => g.canvasAssignmentId && neverDropSet.has(g.canvasAssignmentId)
  );
  const droppable = graded.filter(
    (g) => !g.canvasAssignmentId || !neverDropSet.has(g.canvasAssignmentId)
  );

  // Sort droppable by percentage ascending for drop logic
  const sorted = [...droppable].sort((a, b) => a.pct - b.pct);

  const droppedIds = new Set<string>();

  // Drop lowest N (from droppable only)
  for (let i = 0; i < Math.min(dropLowest, sorted.length); i++) {
    droppedIds.add(sorted[i].id);
  }

  // Drop highest N from the end (from droppable only)
  for (let i = 0; i < Math.min(dropHighest, sorted.length); i++) {
    const idx = sorted.length - 1 - i;
    if (!droppedIds.has(sorted[idx].id)) {
      droppedIds.add(sorted[idx].id);
    }
  }

  // Protected assignments always count + non-dropped droppable assignments
  const kept = [
    ...protectedAssignments,
    ...droppable.filter((g) => !droppedIds.has(g.id)),
  ];
  const earned = kept.reduce((s, g) => s + g.score, 0);
  const possible = kept.reduce((s, g) => s + g.possible, 0);

  return {
    earned,
    possible,
    percentage: possible > 0 ? (earned / possible) * 100 : null,
    gradedCount: graded.length,
    totalCount: countable.length,
    droppedIds,
  };
}

const statusDot: Record<string, string> = {
  not_started: "bg-gray-300",
  in_progress: "bg-blue-500",
  submitted: "bg-blue-500",
  graded: "bg-green-500",
};

function CategorySection({
  group,
  stats,
  isWeighted,
}: {
  group: AssignmentGroupData;
  stats: GroupStats;
  isWeighted: boolean;
}) {
  const [open, setOpen] = useState(false);

  const canvasHasDrops = group.dropLowest > 0 || group.dropHighest > 0;
  const syllabusHasDrops = group.syllabusDropLowest > 0 || group.syllabusDropHighest > 0;
  const usingsyllabusDrops = !canvasHasDrops && syllabusHasDrops;
  const hasDropRules = canvasHasDrops || syllabusHasDrops;

  const effectiveDropLowest = canvasHasDrops ? group.dropLowest : group.syllabusDropLowest;
  const effectiveDropHighest = canvasHasDrops ? group.dropHighest : group.syllabusDropHighest;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/30"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 text-[13px] font-medium">{group.name}</span>
        {isWeighted && group.weight > 0 && (
          <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {group.weight}%
          </span>
        )}
        <span className="shrink-0 text-[13px] tabular-nums font-medium">
          {stats.percentage != null ? `${stats.percentage.toFixed(1)}%` : "—"}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {stats.gradedCount}/{stats.totalCount}
        </span>
      </button>

      {/* Progress bar */}
      <div className="px-4 pb-2">
        <div className="h-1 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-foreground/60 transition-all"
            style={{ width: `${stats.percentage ?? 0}%` }}
          />
        </div>
        {hasDropRules && (
          <div className="mt-1 flex items-center gap-2">
            <p className="text-[11px] text-muted-foreground/70">
              {effectiveDropLowest > 0 && `Lowest ${effectiveDropLowest} dropped`}
              {effectiveDropLowest > 0 && effectiveDropHighest > 0 && " · "}
              {effectiveDropHighest > 0 && `Highest ${effectiveDropHighest} dropped`}
            </p>
            {usingsyllabusDrops && (
              <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                from syllabus
              </span>
            )}
          </div>
        )}
      </div>

      {/* Expanded assignment list */}
      {open && group.assignments.length > 0 && (
        <div className="border-t border-border">
          {group.assignments.map((a) => {
            const isDropped = stats.droppedIds.has(a.id);
            const isExcused = a.excused;
            const isOmitted = a.omitFromFinalGrade;
            const isMissing = a.missing ?? false;
            const isLate = a.late ?? false;
            const pct =
              a.score != null && a.pointsPossible && a.pointsPossible > 0
                ? ((a.score / a.pointsPossible) * 100).toFixed(1)
                : null;

            return (
              <div
                key={a.id}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 text-[13px]",
                  (isDropped || isExcused || isOmitted) && "opacity-50"
                )}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    statusDot[a.status] ?? "bg-gray-300"
                  }`}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    isDropped && "line-through decoration-muted-foreground/40"
                  )}
                >
                  {a.title}
                </span>
                {isExcused && (
                  <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                    Excused
                  </span>
                )}
                {isOmitted && !isExcused && (
                  <span className="shrink-0 text-[10px] italic text-muted-foreground">
                    Not counted
                  </span>
                )}
                {isDropped && !isExcused && !isOmitted && (
                  <span className="shrink-0 text-[10px] italic text-muted-foreground">
                    dropped
                  </span>
                )}
                {isMissing && !isExcused && (
                  <span className="shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600">
                    Missing
                  </span>
                )}
                {isLate && !isMissing && !isExcused && (
                  <span className="shrink-0 rounded-full bg-yellow-50 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700">
                    Late
                  </span>
                )}
                {a.score != null && a.pointsPossible != null ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {a.score}/{a.pointsPossible}
                    {pct && (
                      <span className="ml-1 text-[11px]">({pct}%)</span>
                    )}
                  </span>
                ) : a.gradescopeScore != null && a.gradescopeMaxScore != null ? (
                  <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-muted-foreground">
                    {a.gradescopeScore}/{a.gradescopeMaxScore}
                    <span
                      className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                      title="Score from Gradescope — not yet in Canvas"
                    >
                      GS
                    </span>
                  </span>
                ) : (
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    {a.dueDate ? format(parseISO(a.dueDate), "MMM d") : "No due date"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function GradeBreakdown({
  assignmentGroups,
  currentGrade,
  currentScore,
  gradingScheme,
  applyGroupWeights,
}: GradeBreakdownProps) {
  const [showScheme, setShowScheme] = useState(false);

  if (assignmentGroups.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
        <p className="text-[13px] text-muted-foreground">
          No grading categories synced yet. Sync with Canvas to see your grade breakdown.
        </p>
      </div>
    );
  }

  const sorted = [...assignmentGroups].sort((a, b) => a.position - b.position);
  // Use Canvas's authoritative flag instead of heuristic detection
  const isWeighted = applyGroupWeights;

  // Compute stats for each group
  const groupStats = new Map<string, GroupStats>();
  for (const g of sorted) {
    groupStats.set(g.id, computeGroupStats(
      g.assignments, g.dropLowest, g.dropHighest, g.neverDrop,
      g.syllabusDropLowest, g.syllabusDropHighest
    ));
  }

  // Compute overall percentage (our own calculation for display alongside Canvas's)
  let computedOverall: number | null = null;
  if (isWeighted) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const g of sorted) {
      const stats = groupStats.get(g.id)!;
      if (stats.percentage != null && g.weight > 0) {
        weightedSum += (stats.percentage / 100) * g.weight;
        totalWeight += g.weight;
      }
    }
    if (totalWeight > 0) computedOverall = (weightedSum / totalWeight) * 100;
  } else {
    let totalEarned = 0;
    let totalPossible = 0;
    for (const g of sorted) {
      const stats = groupStats.get(g.id)!;
      totalEarned += stats.earned;
      totalPossible += stats.possible;
    }
    if (totalPossible > 0) computedOverall = (totalEarned / totalPossible) * 100;
  }

  return (
    <div className="space-y-4">
      {/* Overall grade header */}
      {(currentGrade || currentScore != null) && (
        <div className="rounded-lg border border-border bg-card px-4 py-4">
          <div className="flex items-baseline gap-3">
            {currentGrade && (
              <span className="text-3xl font-semibold">{currentGrade}</span>
            )}
            {currentScore != null && (
              <span className="text-lg tabular-nums text-muted-foreground">
                {currentScore.toFixed(1)}%
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {isWeighted ? "Weighted" : "Points-based"} grading
            {computedOverall != null && currentScore != null &&
              Math.abs(computedOverall - currentScore) > 0.5 && (
                <span className="ml-1">
                  · Calculated: {computedOverall.toFixed(1)}%
                </span>
              )}
          </p>
        </div>
      )}

      {/* Grading scheme (collapsible) */}
      {gradingScheme && gradingScheme.length > 0 && (
        <div>
          <button
            onClick={() => setShowScheme(!showScheme)}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
          >
            {showScheme ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Grading Scale
          </button>
          {showScheme && (
            <div className="mt-2 grid grid-cols-4 gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-4 py-3">
              {gradingScheme
                .sort((a, b) => b.value - a.value)
                .map((entry) => (
                  <div key={entry.name} className="flex justify-between text-[12px]">
                    <span className="font-medium">{entry.name}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {(entry.value * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Category sections */}
      <div className="space-y-2">
        {sorted.map((group) => (
          <CategorySection
            key={group.id}
            group={group}
            stats={groupStats.get(group.id)!}
            isWeighted={isWeighted}
          />
        ))}
      </div>
    </div>
  );
}
