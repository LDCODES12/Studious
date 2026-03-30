/**
 * Cross-course consistency pass — detects institutional calendar patterns.
 *
 * Runs ONCE after all courses are individually reconciled. Compares
 * timelines across courses to find shared breaks, reading days, and
 * holidays that individual courses may have missed.
 *
 * Term-scoped and duration-aware: only compares courses in the same
 * term with similar durations. A half-semester course is not penalized
 * by break patterns from 15-week lecture courses.
 */

import { generateObject } from "ai";
import { modelConfig } from "../ai-models.ts";
import { crossCourseResultSchema } from "./schemas.ts";
import type { ReconciliationResult, CrossCourseResult, InstitutionalContext } from "./types.ts";

interface CourseEntry {
  courseId: string;
  courseName: string;
  result: ReconciliationResult;
}

/**
 * Build a compact cross-course summary for the AI.
 */
function buildCrossCourseSummary(courses: CourseEntry[]): string {
  const lines: string[] = [];
  lines.push(`=== CROSS-COURSE TIMELINE SUMMARY ===`);
  lines.push(`Student has ${courses.length} courses this term.\n`);

  for (const c of courses) {
    const r = c.result;
    const instrWeeks = r.weeks.filter((w) => w.isInstructional).length;
    const breakWeeks = r.weeks.filter((w) => !w.isInstructional);
    const datedWeeks = r.weeks.filter((w) => w.startDate);
    const firstDate = datedWeeks[0]?.startDate ?? "unknown";
    const lastDate = datedWeeks[datedWeeks.length - 1]?.startDate ?? "unknown";

    lines.push(`Course: "${c.courseName}"`);
    lines.push(`  Schedule mode: ${r.scheduleMode} | Meeting pattern: ${r.meetingPattern ?? "unknown"}`);
    lines.push(`  Total weeks: ${r.weeks.length} (${instrWeeks} instructional, ${breakWeeks.length} break)`);
    lines.push(`  Date range: ${firstDate} – ${lastDate}`);

    if (breakWeeks.length > 0) {
      lines.push(`  Breaks:`);
      for (const bw of breakWeeks) {
        lines.push(`    - Week ${bw.weekNumber} (${bw.startDate ?? "no date"}): "${bw.weekLabel}"`);
      }
    } else {
      lines.push(`  Breaks: NONE`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are an institutional calendar analyst. You receive timeline summaries from ALL of a student's courses in the same term.

Your job: detect institutional calendar patterns — breaks, reading days, holidays — that are shared across courses but may be missing from some.

RULES:
- Only flag a break as "missing" if a MAJORITY of comparable courses have it. A single course with a break is not evidence.
- "Comparable courses" = same term, similar duration (within 3 weeks), regular schedule (weekly or lecture-based). Do NOT compare:
  - Half-semester courses (7-8 weeks) with full-semester courses (14-17 weeks)
  - Sparse/irregular meeting courses with weekly courses
  - Courses from different terms
- Confidence levels:
  - high: 3+ comparable courses agree on the same break date
  - medium: 2 comparable courses agree
  - low: inferred from gaps only
- Include the course names in detectedInCourses and missingFromCourses
- Check for common institutional patterns: Spring Break (usually 1 week in March), Thanksgiving (late November), Reading Days (before finals), MLK Day, Presidents' Day
- Flag term boundary issues if a course's date range doesn't align with peers (e.g., starts 2 weeks late or ends 3 weeks early)`;

export async function runCrossCourseCheck(
  courses: CourseEntry[],
): Promise<CrossCourseResult> {
  // Skip if fewer than 2 courses — no cross-course signal
  if (courses.length < 2) {
    return {
      institutionalBreaks: [],
      termBoundaryIssues: [],
      summary: "Fewer than 2 courses — no cross-course analysis possible.",
    };
  }

  const summary = buildCrossCourseSummary(courses);

  const { object } = await generateObject({
    ...modelConfig("medium"),
    schema: crossCourseResultSchema,
    system: SYSTEM_PROMPT,
    prompt: summary,
  });

  return object as CrossCourseResult;
}

/**
 * Convert cross-course findings into an InstitutionalContext
 * that can be injected into a course's evidence bundle for re-reconciliation.
 */
export function buildInstitutionalContext(
  crossCourseResult: CrossCourseResult,
): InstitutionalContext {
  return {
    breaks: crossCourseResult.institutionalBreaks
      .filter((b) => b.confidence === "high" || b.confidence === "medium")
      .map((b) => ({
        startDate: b.startDate,
        label: b.label,
        confidence: b.confidence,
      })),
  };
}
