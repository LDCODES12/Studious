import { generateObject } from "ai";
import { z } from "zod";
import { modelConfig } from "@/lib/ai-models";
import type { CorpusWeekBucket, StructuralAuthority } from "@/lib/course-corpus/types";

export interface CourseTimelineContextEvidence {
  evidenceId: string;
  title: string;
  sourceKind: string;
  structuralAuthority: StructuralAuthority;
  roles: string[];
  isoDates: string[];
  weekNumbers: number[];
  lectureNumbers: number[];
  breakSignals: string[];
  provenance: string[];
  excerpt: string | null;
}

export interface CourseTimelineContextChunk {
  chunkId: string;
  evidenceId: string;
  title: string;
  sourceKind: string;
  structuralAuthority: StructuralAuthority;
  chunkIndex: number;
  text: string;
  evidenceType: string;
  signals: string[];
  keywords: string[];
}

export interface CourseTimelineWeekContext {
  weekNumber: number;
  startDate: string | null;
  query: string;
  evidenceIds: string[];
  chunkIds: string[];
}

export interface CourseTimelineContextBundle {
  queries: string[];
  evidence: CourseTimelineContextEvidence[];
  chunks: CourseTimelineContextChunk[];
  weekContexts?: CourseTimelineWeekContext[];
}

export interface TimelineSynthesisWeek {
  startDate: string;
  weekLabel: string;
  placementKind: "instructional_week" | "explicit_break";
  topics: string[];
  readings: string[];
  notes: string[];
  sourceEvidenceIds: string[];
  eventEvidenceIds: string[];
  confidence: "high" | "medium" | "low";
  rationale: string;
}

export interface TimelineSynthesisDecision {
  weeks: TimelineSynthesisWeek[];
  citedEvidenceIds: string[];
  confidence: "high" | "medium" | "low";
  concerns: string[];
}

const confidenceEnum = z.enum(["high", "medium", "low"]);

const timelineSynthesisSchema = z.object({
  weeks: z.array(z.object({
    startDate: z.string(),
    weekLabel: z.string(),
    placementKind: z.enum(["instructional_week", "explicit_break"]),
    topics: z.array(z.string()),
    readings: z.array(z.string()),
    notes: z.array(z.string()),
    sourceEvidenceIds: z.array(z.string()),
    eventEvidenceIds: z.array(z.string()),
    confidence: confidenceEnum,
    rationale: z.string(),
  })),
  citedEvidenceIds: z.array(z.string()),
  confidence: confidenceEnum,
  concerns: z.array(z.string()),
});

function compactSkeleton(buckets: CorpusWeekBucket[]) {
  return buckets.map((bucket) => ({
    weekNumber: bucket.weekNumber,
    startDate: bucket.startDate,
    currentLabel: bucket.weekLabel,
    placementKind: bucket.placementKind,
    topics: bucket.topics.slice(0, 8),
    readings: bucket.readings.slice(0, 8),
    notes: bucket.notes.slice(0, 8),
    sourceEvidenceIds: bucket.sourceEvidenceIds,
    eventEvidenceIds: bucket.eventEvidenceIds,
  }));
}

export async function synthesizeTimelineFromCourseContext(args: {
  courseName: string;
  termRange: { startDate: string; endDate: string };
  skeleton: CorpusWeekBucket[];
  fallbackDraft: CorpusWeekBucket[];
  context: CourseTimelineContextBundle;
}): Promise<TimelineSynthesisDecision | null> {
  if (args.skeleton.length === 0 || args.context.evidence.length === 0) return null;

  try {
    const { object } = await generateObject({
      ...modelConfig("max"),
      schema: timelineSynthesisSchema,
      system: `You synthesize a student-facing course timeline from a course-local evidence bundle.

This is retrieval-augmented derivation, not archival ingest. The course corpus has already been ingested.

Rules:
- Use only the provided evidence IDs and retrieved chunks.
- The skeleton weeks already exist. Do not invent dates or create weeks outside the skeleton startDate values.
- The fallback draft is non-authoritative scaffolding. Use it only as a hint when the cited evidence supports it.
- The weekContexts list is course-local RAG context for each skeleton week. Prefer it over broad guesses.
- schedule_authority evidence may anchor labels, breaks, readings, topics, and course structure.
- schedule_support evidence may add or validate events, deadlines, review sessions, and breaks.
- content_only evidence may enrich an already plausible week, but must not define the semester spine by itself.
- A content_only file can label or enrich a week only when its own date/week/lecture hints or nearby schedule authority support that placement.
- Announcements, assignments, calendar events, and Gradescope items are usually eventEvidenceIds unless they explicitly describe schedule structure.
- Mark explicit_break only when cited evidence explicitly says spring break, no class, reading days, holiday, or equivalent.
- Leave uncertain or empty skeleton weeks out of the returned weeks. A later deterministic prune pass will remove truly empty weeks.
- Keep labels concise and student-facing. Prefer actual course topic names over "Assignment", "Review Session", or raw filenames.
- Cite evidence IDs in sourceEvidenceIds/eventEvidenceIds. Do not cite IDs that were not provided.`,
      prompt: JSON.stringify({
        courseName: args.courseName,
        termRange: args.termRange,
        allowedStartDates: args.skeleton.map((bucket) => bucket.startDate).filter(Boolean),
        skeleton: compactSkeleton(args.skeleton),
        fallbackDraft: compactSkeleton(args.fallbackDraft),
        retrievalQueries: args.context.queries,
        evidence: args.context.evidence,
        retrievedChunks: args.context.chunks,
        weekContexts: args.context.weekContexts ?? [],
      }),
      abortSignal: AbortSignal.timeout(55_000),
      maxRetries: 1,
    });

    return object as TimelineSynthesisDecision;
  } catch {
    return null;
  }
}
