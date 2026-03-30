/**
 * V2 Pipeline Orchestrator — wires all reconciliation stages together.
 *
 * Returns a V2PipelineResult that extends PipelineResult with:
 *   - reconciliationResult: the full ReconciliationResult (for cross-course)
 *   - v2Failed: true if validation had hard errors (route should fall back to V1)
 *
 * Flow per course:
 *   1. assembleEvidenceBundle()
 *   2. runReconciliation() (max tier)
 *   3. runCritic() (adversarial review)
 *   4. If critic finds errors → re-reconcile with feedback (max 1 retry)
 *   5. validateOutput() (deterministic invariants)
 *   6. Convert to PipelineResult
 *
 * Cross-course (called separately after all courses):
 *   runCrossCourseConsistencyCheck() → re-reconcile affected courses
 */

import { assembleEvidenceBundle } from "./evidence-bundle.ts";
import { runReconciliation } from "./reconciliation-pass.ts";
import { runCritic } from "./critic-pass.ts";
import { runCrossCourseCheck, buildInstitutionalContext } from "./cross-course-pass.ts";
import { validateOutput } from "./deterministic-validator.ts";
import type {
  PipelineInput,
  PipelineResult,
  EvidenceBundleInput,
  ReconciliationResult,
  CriticResult,
  CrossCourseResult,
  InstitutionalContext,
} from "./types.ts";
import type { SynthesizedTopic, TimelineAnchorRecord, PipelineDebug } from "../topic-pipeline.ts";
import type { TimelineAnchorType, ConfidenceLevel } from "../topic-pipeline.ts";

// ─── Result type ────────────────────────────────────────────────────────────

export interface V2PipelineResult extends PipelineResult {
  /** Full reconciliation result — used by cross-course pass */
  reconciliationResult: ReconciliationResult;
  /** True if deterministic validation had hard errors — route should fall back to V1 */
  v2Failed: boolean;
}

// ─── Per-Course Pipeline ────────────────────────────────────────────────────

export async function runTopicPipelineV2(
  input: PipelineInput,
  extras?: {
    announcements?: EvidenceBundleInput["announcements"];
    calendarEvents?: EvidenceBundleInput["calendarEvents"];
    pdfGridText?: string;
    institutionalContext?: InstitutionalContext;
  },
): Promise<V2PipelineResult> {
  const bundleInput: EvidenceBundleInput = {
    ...input,
    announcements: extras?.announcements,
    calendarEvents: extras?.calendarEvents,
    pdfGridText: extras?.pdfGridText,
    institutionalContext: extras?.institutionalContext,
  };

  // Step 1: Assemble evidence
  const evidenceBundle = assembleEvidenceBundle(bundleInput);

  // Step 2: Reconciliation (max tier)
  let result = await runReconciliation(evidenceBundle, input.courseName);

  // Step 3: Critic review
  let criticResult = await runCritic(result, evidenceBundle);

  // Step 4: Re-reconcile if critic found errors (max 1 retry)
  let reconciledTwice = false;
  const hasErrors = criticResult.findings.some((f) => f.severity === "error");

  if (hasErrors) {
    reconciledTwice = true;
    const retryBundleInput: EvidenceBundleInput = {
      ...bundleInput,
      criticFeedback: criticResult.findings,
    };
    const retryBundle = assembleEvidenceBundle(retryBundleInput);
    result = await runReconciliation(retryBundle, input.courseName);

    // Re-critic the corrected timeline
    criticResult = await runCritic(result, retryBundle);
  }

  // Step 5: Deterministic validation
  const validation = validateOutput(result, input.termStartDate, input.termEndDate);

  if (!validation.valid) {
    // Hard validation failure — signal the route to fall back to V1
    return {
      ...buildEmptyPipelineResult(input.courseName, validation.hardErrors, criticResult),
      reconciliationResult: result,
      v2Failed: true,
    };
  }

  // Step 6: Convert to PipelineResult
  return {
    ...convertToPipelineResult(result, input.candidates, criticResult, validation, reconciledTwice),
    reconciliationResult: result,
    v2Failed: false,
  };
}

// ─── Cross-Course Consistency ───────────────────────────────────────────────

export async function runCrossCourseConsistencyCheck(
  courseResults: { courseId: string; courseName: string; result: ReconciliationResult }[],
): Promise<CrossCourseResult> {
  return runCrossCourseCheck(courseResults);
}

/**
 * Re-reconcile a single course with institutional context from the cross-course pass.
 * Called for each course that is missing a high-confidence institutional break.
 */
export async function reReconcileWithInstitutionalContext(
  input: PipelineInput,
  institutionalContext: InstitutionalContext,
  extras?: {
    announcements?: EvidenceBundleInput["announcements"];
    calendarEvents?: EvidenceBundleInput["calendarEvents"];
    pdfGridText?: string;
  },
): Promise<V2PipelineResult> {
  return runTopicPipelineV2(input, {
    ...extras,
    institutionalContext,
  });
}

// ─── Conversion Helpers ─────────────────────────────────────────────────────

function convertToPipelineResult(
  result: ReconciliationResult,
  candidates: PipelineInput["candidates"],
  criticResult: CriticResult,
  validation: { softWarnings: string[] },
  reconciledTwice: boolean,
): PipelineResult {
  const topics: SynthesizedTopic[] = result.weeks
    .filter((w) => w.isInstructional)
    .map((w) => ({
      weekNumber: w.weekNumber,
      weekLabel: w.weekLabel,
      startDate: w.startDate,
      topics: w.topics,
      readings: w.readings,
      notes: w.notes,
      courseName: result.courseName,
      dateConfidence: w.dateConfidence as ConfidenceLevel,
      contentConfidence: w.contentConfidence as ConfidenceLevel,
      scheduleMode: result.scheduleMode,
      provenance: {
        v2: true,
        evidenceSources: w.evidenceSources,
        relatedModules: w.relatedModules,
        conflicts: w.conflicts,
      },
    }));

  const anchors: TimelineAnchorRecord[] = result.weeks.map((w) => ({
    sequenceNumber: w.weekNumber,
    anchorDate: w.startDate,
    anchorType: mapAnchorType(w, result.scheduleMode),
    isInstructional: w.isInstructional,
    calendarConfidence: w.dateConfidence as ConfidenceLevel,
    sourceRefs: w.evidenceSources.map((s) => ({
      label: s.source,
      role: "mixed" as const,
    })),
    notes: w.notes,
  }));

  // Map material source roles back to the actual candidate labels (stored:fileName)
  // so the route can match them to CourseMaterial rows
  const rankedCandidates = [...candidates].sort((a, b) => b.score - a.score);
  const materialSourceRoles: { label: string; role: "timeline" | "content" | "mixed" }[] = [];
  if (rankedCandidates.length > 0) {
    materialSourceRoles.push({ label: rankedCandidates[0].label, role: "timeline" });
  }
  if (rankedCandidates.length > 1 && rankedCandidates[1].score > 0) {
    materialSourceRoles.push({ label: rankedCandidates[1].label, role: "content" });
  }

  const debug: PipelineDebug = {
    stage2Classifications: [],
    stage3Sources: result.weeks.length,
    stage3Weeks: result.weeks.length,
    moduleNormalizerDeltas: 0,
    singlePassExtraction: true,
    lectureCalendarDates: result.weeks.filter((w) => w.startDate).length,
    stage4OutputWeeks: topics.length,
    stage5Warnings: validation.softWarnings,
    fallbackUsed: false,
    timelineSource: "v2-reconciliation",
  };

  const timelineDiagnostics: Record<string, unknown> = {
    pipelineVersion: "v2",
    scheduleMode: result.scheduleMode,
    meetingPattern: result.meetingPattern,
    termWeekCount: result.termWeekCount,
    reasoning: result.reasoning,
    ambiguities: result.ambiguities,
    criticAssessment: criticResult.overallAssessment,
    criticSummary: criticResult.summary,
    criticFindings: criticResult.findings,
    reconciledTwice,
    validationWarnings: validation.softWarnings,
  };

  return {
    topics,
    anchors,
    timelineMode: result.scheduleMode,
    materialSourceRoles,
    timelineDiagnostics,
    moduleIdsToDelete: [],
    debug,
  };
}

function mapAnchorType(
  week: ReconciliationResult["weeks"][number],
  scheduleMode: string,
): TimelineAnchorType {
  if (!week.isInstructional) return "break";
  if (!week.startDate) return "module_scaffold";
  if (scheduleMode === "sparse") return "sparse_meeting";
  if (week.dateConfidence === "high") return "explicit_date";
  return "inferred_week";
}

function buildEmptyPipelineResult(
  courseName: string,
  hardErrors: string[],
  criticResult: CriticResult,
): PipelineResult {
  return {
    topics: [],
    anchors: [],
    timelineMode: "unknown",
    materialSourceRoles: [],
    timelineDiagnostics: {
      pipelineVersion: "v2",
      validationFailed: true,
      hardErrors,
      criticAssessment: criticResult.overallAssessment,
      criticSummary: criticResult.summary,
    },
    moduleIdsToDelete: [],
    debug: {
      stage2Classifications: [],
      stage3Sources: 0,
      stage3Weeks: 0,
      moduleNormalizerDeltas: 0,
      singlePassExtraction: true,
      lectureCalendarDates: 0,
      stage4OutputWeeks: 0,
      stage5Warnings: [],
      fallbackUsed: false,
      timelineSource: "v2-validation-failed",
    },
  };
}
