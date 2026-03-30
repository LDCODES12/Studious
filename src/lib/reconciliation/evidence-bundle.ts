/**
 * Assembles a complete evidence bundle for one course.
 *
 * The bundle is a hybrid document: raw text for syllabus content (where
 * formatting matters) + compact JSON blocks for structured data (assignments,
 * modules, schedule). This gives the reconciliation AI both human-readable
 * context and machine-precise data in a single prompt.
 */

import { bestWindow, scheduleScore } from "../parse-syllabus.ts";
import type { EvidenceBundleInput, CriticFinding, InstitutionalContext } from "./types.ts";

// ─── Token budget (approximate, 1 token ≈ 4 chars) ──────────────────────────

const MAX_SYLLABUS_CHARS = 60_000; // ~15k tokens for primary + secondary combined
const MAX_MODULE_CHARS = 16_000;   // ~4k tokens
const MAX_ASSIGNMENT_CHARS = 12_000; // ~3k tokens
const MAX_GRID_CHARS = 12_000;     // ~3k tokens
const MAX_ANNOUNCEMENT_CHARS = 6_000; // ~1.5k tokens

// ─── Snippet harvest patterns ────────────────────────────────────────────────

const SCHEDULE_CRITICAL_PATTERNS = [
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/gi,
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /spring\s+break|reading\s+day|no\s+class|holiday|recess|break\s+week|thanksgiving/gi,
  /\blecture\s*#?\s*\d+/gi,
  /\bweek\s*#?\s*\d+/gi,
  /\bexperiment\s*#?\s*\d+/gi,
  /\bmidterm|final\s+exam|final\s+project/gi,
];

/**
 * Extract lines from text that match schedule-critical patterns.
 * Used when the full text is too long and we need to supplement the
 * bestWindow with important snippets from outside it.
 */
function harvestScheduleCriticalSnippets(
  fullText: string,
  windowText: string,
  maxChars: number,
): string {
  const windowLower = windowText.toLowerCase();
  const lines = fullText.split("\n");
  const harvested: string[] = [];
  let totalChars = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;

    // Skip lines already in the window
    if (windowLower.includes(trimmed.toLowerCase().slice(0, 60))) continue;

    // Check if line matches any critical pattern
    const matchesCritical = SCHEDULE_CRITICAL_PATTERNS.some((rx) => {
      rx.lastIndex = 0;
      return rx.test(trimmed);
    });

    if (matchesCritical) {
      if (totalChars + trimmed.length > maxChars) break;
      harvested.push(trimmed);
      totalChars += trimmed.length;
    }
  }

  return harvested.join("\n");
}

/**
 * Format Canvas modules as compact JSON for the evidence bundle.
 */
function formatModules(
  modules: EvidenceBundleInput["modules"],
  maxChars: number,
): string {
  if (modules.length === 0) return "";

  const compact = modules.map((m) => ({
    pos: m.weekNumber,
    id: m.canvasModuleId,
    name: m.weekLabel,
    topics: m.topics.slice(0, 15), // cap per module
    readings: m.readings.slice(0, 10),
  }));

  let json = JSON.stringify(compact, null, 1);
  if (json.length > maxChars) {
    // Truncate topics/readings per module
    const shorter = modules.map((m) => ({
      pos: m.weekNumber,
      id: m.canvasModuleId,
      name: m.weekLabel,
      topics: m.topics.slice(0, 5),
      readings: m.readings.slice(0, 3),
    }));
    json = JSON.stringify(shorter, null, 1);
  }

  return json.slice(0, maxChars);
}

/**
 * Format assignments as compact JSON sorted by due date.
 */
function formatAssignments(
  assignments: EvidenceBundleInput["assignments"],
  maxChars: number,
): string {
  if (assignments.length === 0) return "";

  const sorted = [...assignments]
    .filter((a) => a.dueDate)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));

  const compact = sorted.map((a) => ({
    title: a.title,
    due: a.dueDate?.slice(0, 10) ?? null,
  }));

  let json = JSON.stringify(compact, null, 1);
  if (json.length > maxChars) {
    json = json.slice(0, maxChars - 3) + "...]";
  }
  return json;
}

/**
 * Format class schedule as compact JSON.
 */
function formatClassSchedule(schedule: EvidenceBundleInput["classSchedule"]): string {
  if (!schedule) return "No class schedule available.";

  return JSON.stringify(
    {
      meetings: schedule.meetings.map((m) => ({
        label: m.label || "(unlabeled)",
        days: m.days,
        time: `${m.startTime}-${m.endTime}`,
      })),
      semesterStart: schedule.semesterStart ?? null,
      semesterEnd: schedule.semesterEnd ?? null,
    },
    null,
    1,
  );
}

/**
 * Format syllabus events as compact JSON.
 */
function formatSyllabusEvents(events: EvidenceBundleInput["syllabusEvents"]): string {
  if (!events || events.length === 0) return "";

  const compact = events
    .filter((e) => e.dueDate)
    .map((e) => ({
      title: e.title,
      date: e.dueDate?.slice(0, 10) ?? null,
      type: e.type,
    }));

  return JSON.stringify(compact, null, 1);
}

/**
 * Format institutional context from cross-course pass.
 */
function formatInstitutionalContext(ctx: InstitutionalContext): string {
  return JSON.stringify(ctx, null, 1);
}

/**
 * Format critic feedback for re-reconciliation.
 */
function formatCriticFeedback(findings: CriticFinding[]): string {
  return findings
    .filter((f) => f.severity === "error")
    .map(
      (f) =>
        `- [${f.severity.toUpperCase()}] Week ${f.weekNumber ?? "N/A"}: ${f.description}` +
        (f.suggestedFix ? ` → Suggested: ${f.suggestedFix.field} = "${f.suggestedFix.newValue}"` : ""),
    )
    .join("\n");
}

// ─── Main assembler ──────────────────────────────────────────────────────────

export function assembleEvidenceBundle(input: EvidenceBundleInput): string {
  const sections: string[] = [];

  // Header
  sections.push(`=== EVIDENCE BUNDLE: ${input.courseName} ===`);
  sections.push(`Term: ${input.termStartDate ?? "unknown"} – ${input.termEndDate ?? "unknown"}`);
  sections.push("");

  // Source A: Primary syllabus text
  const rankedCandidates = [...input.candidates].sort((a, b) => b.score - a.score);
  if (rankedCandidates.length > 0) {
    const primary = rankedCandidates[0];
    let primaryText: string;
    let snippets = "";

    if (primary.text.length <= MAX_SYLLABUS_CHARS) {
      // Full text fits — send it all
      primaryText = primary.text;
    } else {
      // Too long — use bestWindow + snippet harvest
      const windowSize = Math.floor(MAX_SYLLABUS_CHARS * 0.75);
      primaryText = bestWindow(primary.text, windowSize);
      const snippetBudget = Math.floor(MAX_SYLLABUS_CHARS * 0.2);
      snippets = harvestScheduleCriticalSnippets(primary.text, primaryText, snippetBudget);
    }

    sections.push(`=== SOURCE A: SYLLABUS [PRIMARY_SCHEDULE_SOURCE] ===`);
    sections.push(`Label: ${primary.label} | ${primary.text.length} chars | schedule score: ${scheduleScore(primary.text).toFixed(1)}`);
    sections.push(primaryText);
    sections.push("");

    if (snippets) {
      sections.push(`=== SCHEDULE-CRITICAL SNIPPETS (from outside main window) ===`);
      sections.push(snippets);
      sections.push("");
    }

    // Source B: Secondary syllabus (if meaningfully different)
    if (rankedCandidates.length > 1) {
      const secondary = rankedCandidates[1];
      if (secondary.score > 0 && secondary.label !== primary.label) {
        const secondaryBudget = Math.floor(MAX_SYLLABUS_CHARS * 0.3);
        const secondaryText =
          secondary.text.length <= secondaryBudget
            ? secondary.text
            : bestWindow(secondary.text, secondaryBudget);

        sections.push(`=== SOURCE B: SYLLABUS [SUPPLEMENTARY] ===`);
        sections.push(`Label: ${secondary.label} | ${secondary.text.length} chars | schedule score: ${scheduleScore(secondary.text).toFixed(1)}`);
        sections.push(secondaryText);
        sections.push("");
      }
    }
  }

  // Source C: Canvas modules (JSON)
  if (input.modules.length > 0) {
    sections.push(`=== SOURCE C: CANVAS MODULES [STRUCTURE_ONLY] (${input.modules.length} modules) ===`);
    sections.push(formatModules(input.modules, MAX_MODULE_CHARS));
    sections.push("");
  }

  // Source D: Assignments (JSON)
  const datedAssignments = input.assignments.filter((a) => a.dueDate);
  if (datedAssignments.length > 0) {
    sections.push(`=== SOURCE D: ASSIGNMENTS [GROUND_TRUTH_DATES] (${datedAssignments.length} with due dates) ===`);
    sections.push(formatAssignments(input.assignments, MAX_ASSIGNMENT_CHARS));
    sections.push("");
  }

  // Source E: Class schedule (JSON)
  sections.push(`=== SOURCE E: CLASS SCHEDULE [GROUND_TRUTH_SCHEDULE] ===`);
  sections.push(formatClassSchedule(input.classSchedule));
  sections.push(`Term dates: ${input.termStartDate ?? "unknown"} – ${input.termEndDate ?? "unknown"}`);
  sections.push("");

  // Source F: Calendar events (JSON)
  if (input.calendarEvents && input.calendarEvents.length > 0) {
    const calEvents = input.calendarEvents.map((e) => ({
      title: e.title,
      start: e.startAt?.slice(0, 16) ?? null,
      end: e.endAt?.slice(0, 16) ?? null,
    }));
    sections.push(`=== SOURCE F: CALENDAR EVENTS (${calEvents.length} events) ===`);
    sections.push(JSON.stringify(calEvents, null, 1).slice(0, 8_000));
    sections.push("");
  }

  // Source G: Syllabus events (JSON)
  if (input.syllabusEvents && input.syllabusEvents.length > 0) {
    sections.push(`=== SOURCE G: SYLLABUS EVENTS (${input.syllabusEvents.length} dated assessments) ===`);
    sections.push(formatSyllabusEvents(input.syllabusEvents));
    sections.push("");
  }

  // Source I: PDF calendar grid (TSV)
  if (input.pdfGridText) {
    const gridText =
      input.pdfGridText.length <= MAX_GRID_CHARS
        ? input.pdfGridText
        : input.pdfGridText.slice(0, MAX_GRID_CHARS);
    sections.push(`=== SOURCE I: PDF CALENDAR GRID ===`);
    sections.push(gridText);
    sections.push("");
  }

  // Source J: Announcements
  if (input.announcements && input.announcements.length > 0) {
    sections.push(`=== SOURCE J: ANNOUNCEMENTS [SUPPLEMENTARY] (${input.announcements.length}) ===`);
    let announcementChars = 0;
    for (const ann of input.announcements) {
      const snippet = `- ${ann.postedAt.slice(0, 10)}: "${ann.title}" — ${ann.body.slice(0, 200)}`;
      if (announcementChars + snippet.length > MAX_ANNOUNCEMENT_CHARS) break;
      sections.push(snippet);
      announcementChars += snippet.length;
    }
    sections.push("");
  }

  // Source K: Institutional context (from cross-course pass)
  if (input.institutionalContext) {
    sections.push(`=== SOURCE K: INSTITUTIONAL CONTEXT [CROSS_COURSE] ===`);
    sections.push("The following institutional calendar patterns were detected from the student's other courses:");
    sections.push(formatInstitutionalContext(input.institutionalContext));
    sections.push("");
  }

  // Critic feedback (for re-reconciliation)
  if (input.criticFeedback && input.criticFeedback.length > 0) {
    sections.push(`=== CRITIC FEEDBACK [CRITIC_FEEDBACK] ===`);
    sections.push("A review of your previous timeline found these errors. Please correct them:");
    sections.push(formatCriticFeedback(input.criticFeedback));
    sections.push("");
  }

  return sections.join("\n");
}
