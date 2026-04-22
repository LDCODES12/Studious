import type { MaterialAnalysis } from "@/lib/analyze-material";

export type CourseEvidenceSourceKind =
  | "canvas_syllabus_pdf"
  | "canvas_syllabus_page"
  | "canvas_page"
  | "canvas_linked_file"
  | "canvas_announcement"
  | "canvas_module_item"
  | "canvas_media_transcript"
  | "canvas_assignment"
  | "canvas_calendar_event"
  | "manual_upload"
  | "auto_route";

export type EvidencePlacementKind =
  | "instructional_week"
  | "explicit_break"
  | "event_only"
  | "global"
  | "unplaced";

export type EvidenceRoleSignal =
  | "schedule_like"
  | "content_like"
  | "admin_like"
  | "event_like"
  | "break_like";

export interface EvidenceDateHint {
  raw: string;
  isoDate: string | null;
}

export interface CourseEvidenceHints {
  roles: EvidenceRoleSignal[];
  dateMentions: EvidenceDateHint[];
  weekNumbers: number[];
  lectureNumbers: number[];
  unitNumbers: number[];
  breakSignals: string[];
  noClassSignals: string[];
  sourceRoleSignals: string[];
}

export interface EvidenceProvenanceEntry {
  discoveredVia: string;
  rawSourceKind: string;
  sourceKey?: string | null;
  remoteId?: string | null;
  sourceUrl?: string | null;
  moduleName?: string | null;
  pageName?: string | null;
  fileName?: string | null;
  label?: string | null;
  capturedAt: string;
}

export interface EvidenceIngestInput {
  courseId: string;
  sourceKind: CourseEvidenceSourceKind;
  sourceKey: string;
  title: string;
  bodyText: string | null;
  structuredPayload?: Record<string, unknown> | null;
  provenanceEntry: EvidenceProvenanceEntry;
  remoteUpdatedAt?: string | Date | null;
  contentHash?: string | null;
  derivedHints: CourseEvidenceHints;
}

export interface CorpusWeekBucket {
  weekNumber: number;
  weekLabel: string;
  startDate: string | null;
  placementKind: Extract<EvidencePlacementKind, "instructional_week" | "explicit_break">;
  sourceEvidenceIds: string[];
  eventEvidenceIds: string[];
  topics: string[];
  readings: string[];
  notes: string[];
}

export interface PlacementDecision {
  evidenceId: string;
  placementKind: EvidencePlacementKind;
  weekNumber?: number | null;
  weekLabel?: string | null;
  startDate?: string | null;
  confidence: "high" | "medium" | "low" | "unknown";
  rationale: string;
  signals: string[];
  isPrimary: boolean;
}

export interface ProjectedMaterialRecord {
  courseId: string;
  fileName: string;
  detectedType: MaterialAnalysis["detectedType"];
  sourceRole: "timeline" | "content" | "mixed" | "unknown";
  sourceKind: string;
  sourceKey: string | null;
  summary: string;
  relatedTopics: string[];
  rawText: string;
  storedForAI: boolean;
  autoStoredForAI: boolean;
  contentHash: string | null;
  sourceUpdatedAt: Date | null;
  syncStatus: "ready" | "stale" | "failed";
}
