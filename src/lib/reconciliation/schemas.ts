/**
 * Zod schemas for the V2 reconciliation pipeline.
 *
 * These schemas are used with generateObject() to force structured AI output.
 * Each schema corresponds to a pipeline stage's output format.
 */

import { z } from "zod";

// ─── Reconciliation Output Schema ────────────────────────────────────────────

export const reconciliationWeekSchema = z.object({
  weekNumber: z.number().int().min(1),
  weekLabel: z.string().min(1),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe("YYYY-MM-DD. Monday for weekly schedules, actual meeting date for sparse."),
  topics: z.array(z.string()).describe("Instructional topics covered this week. Do NOT include slides, handouts, or resources — only actual topics."),
  readings: z.array(z.string()).describe("Assigned readings only (papers, chapters, textbook sections). NOT slides, problem sets, or handouts."),
  notes: z.string().nullable().describe("Brief notes about this week (e.g. exam dates, guest speakers, no-class days). Keep concise."),
  isInstructional: z.boolean().describe("false for break weeks, reading days, holidays. true for all others."),
  dateConfidence: z.enum(["high", "medium", "low"]).describe("high = explicit date in syllabus. medium = inferred from schedule pattern. low = estimated/guessed."),
  contentConfidence: z.enum(["high", "medium", "low"]).describe("high = topics from syllabus schedule. medium = matched from modules. low = sparse or inferred."),
  evidenceSources: z
    .array(
      z.object({
        source: z.enum([
          "syllabus_a",
          "syllabus_b",
          "canvas_modules",
          "assignments",
          "class_schedule",
          "calendar_events",
          "syllabus_events",
          "gradescope",
          "pdf_grid",
          "announcements",
          "cross_course",
          "institutional_context",
          "critic_feedback",
          "inferred",
        ]),
        detail: z.string().describe("Specific evidence reference, e.g. 'Week 3 table row' or 'Module: Unit 2'"),
      }),
    )
    .describe("Which evidence sources informed this week. At least one required."),
  relatedModules: z
    .array(
      z.object({
        canvasModuleId: z.string(),
        moduleName: z.string(),
        matchConfidence: z.enum(["high", "medium", "low"]),
      }),
    )
    .describe("Canvas modules that map to this week. A week can have 0, 1, or many."),
  conflicts: z.array(z.string()).describe("Any conflicts between evidence sources for this week. Empty if none."),
});

export const reconciliationResultSchema = z.object({
  weeks: z.array(reconciliationWeekSchema),
  scheduleMode: z.enum(["weekly", "sparse", "inferred", "unknown"]).describe(
    "weekly = regular meetings with consistent week structure. " +
      "sparse = irregular meetings (e.g. monthly seminars). " +
      "inferred = dates estimated from indirect evidence. " +
      "unknown = insufficient evidence for any schedule.",
  ),
  courseName: z.string(),
  termWeekCount: z.number().int().nullable().describe("Total weeks in the term, including breaks. null if unknown."),
  meetingPattern: z.string().nullable().describe("e.g. 'MWF', 'TR', 'W' — null if unknown or irregular."),
  reasoning: z.string().describe("2-3 sentence summary of how the timeline was assembled and which evidence was most useful."),
  ambiguities: z
    .array(
      z.object({
        weekNumber: z.number().int(),
        description: z.string(),
        chosenInterpretation: z.string(),
        alternativeInterpretation: z.string(),
        confidence: z.enum(["high", "medium", "low"]),
      }),
    )
    .describe("Document any ambiguous decisions. This helps the critic pass and diagnostics."),
});

// ─── Critic Output Schema ────────────────────────────────────────────────────

export const criticFindingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]).describe(
    "error = factually wrong, needs re-reconciliation. " +
      "warning = suspicious but possibly intentional. " +
      "info = observation that might help the student.",
  ),
  weekNumber: z.number().int().nullable().describe("Which week this finding applies to. null for timeline-wide issues."),
  description: z.string().describe("Clear description of the issue found."),
  suggestedFix: z
    .object({
      field: z.string().describe("Which field to change (e.g. 'startDate', 'isInstructional', 'weekLabel')"),
      oldValue: z.string().nullable(),
      newValue: z.string(),
    })
    .nullable()
    .describe("Specific fix suggestion for error findings. null for warnings/info."),
});

export const criticResultSchema = z.object({
  findings: z.array(criticFindingSchema),
  overallAssessment: z.enum(["clean", "minor_issues", "needs_attention"]).describe(
    "clean = no issues found. " +
      "minor_issues = warnings only, timeline is usable. " +
      "needs_attention = errors found, re-reconciliation recommended.",
  ),
  summary: z.string().describe("1-2 sentence summary of the review."),
});

// ─── Cross-Course Output Schema ──────────────────────────────────────────────

export const crossCourseResultSchema = z.object({
  institutionalBreaks: z
    .array(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        label: z.string(),
        detectedInCourses: z.array(z.string()),
        missingFromCourses: z.array(z.string()),
        confidence: z.enum(["high", "medium", "low"]).describe(
          "high = majority of comparable full-term courses agree. " +
            "medium = some courses agree. " +
            "low = only inferred from gaps.",
        ),
      }),
    )
    .describe("Institutional breaks detected from cross-course patterns."),
  termBoundaryIssues: z.array(
    z.object({
      courseName: z.string(),
      issue: z.string(),
    }),
  ),
  summary: z.string(),
});
