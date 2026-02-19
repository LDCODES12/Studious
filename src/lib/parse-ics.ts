export interface ICSAssignment {
  title: string;
  courseName: string;
  dueDate: string; // YYYY-MM-DD
  uid: string;
  canvasUrl: string | null;
}

/** Pull a field value from a VEVENT block, handling folded lines */
function getField(block: string, key: string): string | null {
  // Unfold continuation lines (RFC 5545: CRLF + space/tab)
  const unfolded = block.replace(/\r?\n[ \t]/g, "");
  const match = unfolded.match(new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

/** Convert ICS date/datetime to YYYY-MM-DD */
function icsDateToISO(raw: string): string {
  // Strip VALUE=DATE: prefix if present
  const s = raw.replace(/^VALUE=DATE:/, "").replace(/\r/g, "");
  // YYYYMMDDTHHMMSSZ or YYYYMMDD
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Try to split SUMMARY into { courseName, title }.
 * Canvas commonly formats as:
 *   "[Course Name] Assignment Title"       (brackets)
 *   "Course Name - Assignment Title"       (dash separator)
 *   "Assignment Title"                     (no course — use description fallback)
 */
function parseSummary(summary: string, description: string | null): { courseName: string; title: string } {
  // Pattern 1: [Course Name] Title
  const bracketMatch = summary.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (bracketMatch) {
    return { courseName: bracketMatch[1].trim(), title: bracketMatch[2].trim() };
  }

  // Pattern 2: Course Name - Title  (split on first " - ")
  const dashIdx = summary.indexOf(" - ");
  if (dashIdx > 0 && dashIdx < summary.length - 3) {
    return {
      courseName: summary.slice(0, dashIdx).trim(),
      title: summary.slice(dashIdx + 3).trim(),
    };
  }

  // Pattern 3: look in DESCRIPTION for "Course: X" or "for X\n"
  if (description) {
    const courseMatch = description.match(/(?:course|class):\s*(.+?)(?:\\n|$)/i);
    if (courseMatch) {
      return { courseName: courseMatch[1].trim(), title: summary.trim() };
    }
  }

  // Fallback: no course info found — use whole summary as title
  return { courseName: "Canvas Imports", title: summary.trim() };
}

/** Infer assignment type from title */
export function inferType(title: string): string {
  const t = title.toLowerCase();
  if (/\b(quiz)\b/.test(t)) return "quiz";
  if (/\b(exam|midterm|final|test)\b/.test(t)) return "exam";
  if (/\b(project)\b/.test(t)) return "project";
  if (/\b(lab)\b/.test(t)) return "lab";
  if (/\b(reading|discussion)\b/.test(t)) return "reading";
  return "assignment";
}

export function parseICS(text: string): ICSAssignment[] {
  const results: ICSAssignment[] = [];
  const blocks = text.split(/BEGIN:VEVENT/i);

  for (const block of blocks.slice(1)) {
    const summary = getField(block, "SUMMARY");
    const dtstart = getField(block, "DTSTART");
    const uid = getField(block, "UID") ?? crypto.randomUUID();
    const url = getField(block, "URL");
    const description = getField(block, "DESCRIPTION");

    // Skip events without a title or date
    if (!summary || !dtstart) continue;

    // Skip non-assignment events (e.g. course enrollments, office hours)
    const lcSummary = summary.toLowerCase();
    if (
      lcSummary.includes("office hours") ||
      lcSummary.includes("no class") ||
      lcSummary.includes("spring break") ||
      lcSummary.includes("fall break")
    ) continue;

    let dueDate: string;
    try {
      dueDate = icsDateToISO(dtstart);
      // Validate it looks like a real date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) continue;
    } catch {
      continue;
    }

    const { courseName, title } = parseSummary(summary, description);

    results.push({ title, courseName, dueDate, uid, canvasUrl: url });
  }

  return results;
}
