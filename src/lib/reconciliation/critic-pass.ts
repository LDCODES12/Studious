/**
 * Critic pass — adversarial review of a reconciled timeline.
 *
 * A separate AI with a different system prompt from the reconciler.
 * Its job is to find problems, not to build timelines. The separation
 * prevents self-censoring (a model that builds and reviews in one pass
 * produces conservative output to avoid criticism).
 *
 * Model escalation: uses medium reasoning by default, escalates to high
 * when the reconciliation output has many ambiguities or weak evidence.
 */

import { generateObject } from "ai";
import { modelConfig, type ReasoningTier } from "../ai-models.ts";
import { criticResultSchema } from "./schemas.ts";
import type { ReconciliationResult, CriticResult } from "./types.ts";

const SYSTEM_PROMPT = `You are a course timeline critic. You will receive a completed timeline and the evidence bundle that produced it. Find errors, contradictions, and suspicious patterns.

For each finding, classify its severity:
- "error": factually wrong — date outside term, missing break that evidence supports, wrong week count, dates that don't match the class meeting pattern, content assigned to a break week, assignment due dates orphaned from any week. Errors trigger re-reconciliation.
- "warning": suspicious but possibly intentional — sparse content weeks, large gap without explicit break evidence, unusual week count for the term type
- "info": observation that might help the student — e.g. "no readings listed for weeks 8-12", "module 'Unit 5' not mapped to any week"

For "error" findings, provide a specific suggestedFix:
- Which field to change (startDate, isInstructional, weekLabel, etc.)
- What the current value is
- What the corrected value should be

WHAT TO CHECK:
1. Date/schedule alignment: do startDates match the stated meeting pattern? (MWF course should have meetings on Mon/Wed/Fri, not random days)
2. Break detection: 14+ week schedules should almost always have at least one break. Check if assignment due dates show a gap that suggests a break the reconciler missed.
3. Suspicious gaps: two consecutive instructional weeks >14 days apart with no break between them
4. Content anomalies: weeks with very different content density (8 topics in one, 0 in the next)
5. Assignment orphans: assignment due dates that fall in break weeks or outside any week's range
6. Module coverage: content modules that weren't mapped to any week despite having real content
7. Week count: is it reasonable for the term type? Semester = 14-17, quarter = 10-11, half = 7-8
8. Missing final weeks: does the schedule stop well before the term end date?

RULES:
- Do NOT suggest adding topics or readings that aren't in the evidence bundle
- You may only suggest structural fixes (dates, breaks, reordering, isInstructional flags)
- Be precise about which weekNumber each finding applies to
- If the timeline looks correct, say so — don't invent problems`;

/**
 * Determine the critic's reasoning tier based on reconciliation output complexity.
 */
function selectCriticTier(result: ReconciliationResult, evidenceBundleLength: number): ReasoningTier {
  // Escalate when the reconciliation was difficult
  if (result.ambiguities.length >= 3) return "high";
  if (evidenceBundleLength > 100_000) return "high"; // ~25k tokens
  if (result.scheduleMode === "inferred") return "high";
  return "medium";
}

export async function runCritic(
  reconciliationResult: ReconciliationResult,
  evidenceBundle: string,
): Promise<CriticResult> {
  const tier = selectCriticTier(reconciliationResult, evidenceBundle.length);

  const timelineSummary = reconciliationResult.weeks
    .map((w) => {
      const src = w.evidenceSources.map((s) => s.source).join(", ");
      const conf = `date:${w.dateConfidence} content:${w.contentConfidence}`;
      const modInfo = w.relatedModules.length > 0
        ? ` modules:[${w.relatedModules.map((m) => m.moduleName).join(", ")}]`
        : "";
      return `W${w.weekNumber} | ${w.startDate ?? "no-date"} | ${w.isInstructional ? "INSTR" : "BREAK"} | "${w.weekLabel}" | topics=${w.topics.length} readings=${w.readings.length} | ${conf} | src: ${src}${modInfo}${w.conflicts.length > 0 ? ` | CONFLICTS: ${w.conflicts.join("; ")}` : ""}`;
    })
    .join("\n");

  const ambiguitySummary = reconciliationResult.ambiguities.length > 0
    ? "\n\nAMBIGUITIES NOTED BY RECONCILER:\n" +
      reconciliationResult.ambiguities
        .map((a) => `- Week ${a.weekNumber}: ${a.description} (chose: ${a.chosenInterpretation}, alt: ${a.alternativeInterpretation}, conf: ${a.confidence})`)
        .join("\n")
    : "";

  const prompt = `=== RECONCILED TIMELINE ===
Course: ${reconciliationResult.courseName}
Schedule mode: ${reconciliationResult.scheduleMode}
Meeting pattern: ${reconciliationResult.meetingPattern ?? "unknown"}
Total weeks: ${reconciliationResult.weeks.length} (${reconciliationResult.weeks.filter((w) => w.isInstructional).length} instructional, ${reconciliationResult.weeks.filter((w) => !w.isInstructional).length} break)

Reconciler reasoning: ${reconciliationResult.reasoning}

${timelineSummary}${ambiguitySummary}

=== ORIGINAL EVIDENCE ===
${evidenceBundle}`;

  const { object } = await generateObject({
    ...modelConfig(tier),
    schema: criticResultSchema,
    system: SYSTEM_PROMPT,
    prompt,
  });

  return object as CriticResult;
}
