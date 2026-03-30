/**
 * Types for the V2 AI-first reconciliation pipeline.
 *
 * These types define the data flow between pipeline stages:
 *   evidence bundle → reconciliation → critic → cross-course → validator → DB
 */

import type {
  PipelineInput,
  PipelineResult,
  ScoredSource,
  CanvasModuleInfo,
  ClassScheduleInfo,
  AssignmentDateInfo,
  SyllabusEventInfo,
  ConfidenceLevel,
  ScheduleMode,
} from "../topic-pipeline.ts";

// Re-export V1 types that V2 must be compatible with
export type {
  PipelineInput,
  PipelineResult,
  ScoredSource,
  CanvasModuleInfo,
  ClassScheduleInfo,
  AssignmentDateInfo,
  SyllabusEventInfo,
  ConfidenceLevel,
  ScheduleMode,
};

// ─── Evidence Bundle ─────────────────────────────────────────────────────────

export interface CalendarEventInfo {
  title: string;
  startAt: string;
  endAt: string;
}

export interface EvidenceBundleInput extends PipelineInput {
  announcements?: AnnouncementInfo[];
  calendarEvents?: CalendarEventInfo[];
  pdfGridText?: string;
  institutionalContext?: InstitutionalContext;
  criticFeedback?: CriticFinding[];
}

export interface AnnouncementInfo {
  title: string;
  body: string;
  postedAt: string;
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export type EvidenceSourceType =
  | "syllabus_a"
  | "syllabus_b"
  | "canvas_modules"
  | "assignments"
  | "class_schedule"
  | "calendar_events"
  | "syllabus_events"
  | "gradescope"
  | "pdf_grid"
  | "announcements"
  | "cross_course"
  | "institutional_context"
  | "critic_feedback"
  | "inferred";

export interface EvidenceSource {
  source: EvidenceSourceType;
  detail: string;
}

export interface RelatedModule {
  canvasModuleId: string;
  moduleName: string;
  matchConfidence: "high" | "medium" | "low";
}

export interface ReconciliationWeek {
  weekNumber: number;
  weekLabel: string;
  startDate: string | null;
  topics: string[];
  readings: string[];
  notes: string | null;
  isInstructional: boolean;
  dateConfidence: "high" | "medium" | "low";
  contentConfidence: "high" | "medium" | "low";
  evidenceSources: EvidenceSource[];
  relatedModules: RelatedModule[];
  conflicts: string[];
}

export interface Ambiguity {
  weekNumber: number;
  description: string;
  chosenInterpretation: string;
  alternativeInterpretation: string;
  confidence: "high" | "medium" | "low";
}

export interface ReconciliationResult {
  weeks: ReconciliationWeek[];
  scheduleMode: ScheduleMode;
  courseName: string;
  termWeekCount: number | null;
  meetingPattern: string | null;
  reasoning: string;
  ambiguities: Ambiguity[];
}

// ─── Critic ──────────────────────────────────────────────────────────────────

export interface CriticFinding {
  severity: "error" | "warning" | "info";
  weekNumber: number | null;
  description: string;
  suggestedFix: {
    field: string;
    oldValue: string | null;
    newValue: string;
  } | null;
}

export type CriticAssessment = "clean" | "minor_issues" | "needs_attention";

export interface CriticResult {
  findings: CriticFinding[];
  overallAssessment: CriticAssessment;
  summary: string;
}

// ─── Cross-Course ────────────────────────────────────────────────────────────

export interface InstitutionalBreak {
  startDate: string;
  label: string;
  detectedInCourses: string[];
  missingFromCourses: string[];
  confidence: "high" | "medium" | "low";
}

export interface TermBoundaryIssue {
  courseName: string;
  issue: string;
}

export interface CrossCourseResult {
  institutionalBreaks: InstitutionalBreak[];
  termBoundaryIssues: TermBoundaryIssue[];
  summary: string;
}

export interface InstitutionalContext {
  breaks: { startDate: string; label: string; confidence: "high" | "medium" | "low" }[];
  readingDays?: { startDate: string; endDate: string }[];
  holidays?: { date: string; label: string }[];
}

// ─── Validator ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  hardErrors: string[];
  softWarnings: string[];
}

// ─── Pipeline V2 Internal ────────────────────────────────────────────────────

export interface CourseReconciliationState {
  courseId: string;
  courseName: string;
  result: ReconciliationResult;
  criticResult: CriticResult;
  validation: ValidationResult;
  reconciledTwice: boolean;
}
