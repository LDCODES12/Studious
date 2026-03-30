/**
 * One-pass AI reconciliation: full evidence bundle → complete timeline.
 *
 * This is the truth-making pass — it uses the strongest model (max tier)
 * because it's the single call that determines the entire timeline.
 * It replaces the old pipeline's 5-stage chain (classify modules →
 * build lecture calendar → extract topics → group lectures → normalize modules).
 */

import { generateObject } from "ai";
import { modelConfig } from "../ai-models.ts";
import { reconciliationResultSchema } from "./schemas.ts";
import type { ReconciliationResult } from "./types.ts";

const SYSTEM_PROMPT = `You are a university course timeline reconciler. You receive an EVIDENCE BUNDLE containing ALL available data about a single course — syllabus texts, Canvas modules, assignments, class schedule, and calendar events.

Your job: produce a complete week-by-week timeline for the course, with per-week confidence scores and evidence citations.

DECISIONS YOU MUST MAKE:
1. How many instructional weeks does this course have?
2. What are the start dates for each week?
   - For WEEKLY schedules: use the Monday of each week as the startDate.
   - For SPARSE schedules (e.g., monthly seminars that meet irregularly): use the actual meeting date, not a Monday.
3. What topics and readings belong to each week?
4. Where are academic breaks? (Spring Break, Reading Days, holidays — infer from gaps in the schedule, explicit break mentions, or gaps in assignment due dates.)
5. Which Canvas modules map to which weeks?
6. Is this a weekly, sparse (irregular meetings), or inferred (no dates) schedule?

EVIDENCE PRIORITY (highest to lowest):
1. Explicit dates in syllabus schedule tables — highest authority
2. Assignment/exam due dates — ground truth dates (these are objectively correct)
3. Class schedule + term dates — for computing meeting dates when syllabus gives week numbers without dates
4. Canvas module position and naming — reliable for topic ordering
5. Institutional context from cross-course analysis — for break detection when syllabus is silent
6. Announcement mentions of schedule changes — supplementary

RULES:
- Every week MUST cite which evidence source(s) it comes from in evidenceSources
- If two sources conflict, prefer the higher-priority source and note the conflict
- Break weeks: isInstructional=false, empty topics/readings, descriptive weekLabel (e.g. "Spring Break — No Class")
- Do NOT invent topics not present in any evidence source
- Do NOT include administrative/policy content as topics (grading policies, office hours, attendance rules)
- readings[] = assigned readings ONLY (papers, chapters, textbook sections). NOT slides, problem sets, handouts, or lecture notes — those are topics.
- topics[] = instructional content (lecture topics, lab experiments, discussion topics, assignments due)
- The courseName field must match the course name from the bundle header exactly
- weekNumbers must be sequential 1..N with no gaps
- startDates must be chronologically ordered where present
- If you cannot determine any schedule at all, return weeks: [] with scheduleMode: "unknown"
- If the syllabus uses lecture numbers (Lecture 1, 2, 3...) rather than week numbers, group lectures into calendar weeks using the class schedule meeting pattern
- Document any ambiguous decisions in the ambiguities array — this is important for the critic pass

QUALITY SIGNALS:
- A well-constructed timeline has consistent week density (similar number of topics per week)
- Break weeks should align with institutional calendar (if provided in Source K)
- Assignment due dates should fall within or near the week they cover
- If a gap of 7+ days exists between instructional weeks with no break, something is probably wrong`;

export async function runReconciliation(
  evidenceBundle: string,
  courseName: string,
): Promise<ReconciliationResult> {
  const { object } = await generateObject({
    ...modelConfig("max"),
    schema: reconciliationResultSchema,
    system: SYSTEM_PROMPT,
    prompt: evidenceBundle,
  });

  return object as ReconciliationResult;
}
