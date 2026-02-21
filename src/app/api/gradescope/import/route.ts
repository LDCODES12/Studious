import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import crypto from "crypto";

function sha256(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function authedUser(request: NextRequest) {
  const authHeader = request.headers.get("Authorization") ?? "";
  const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!rawToken) return null;
  const hash = sha256(rawToken);
  return db.user.findUnique({ where: { apiTokenHash: hash }, select: { id: true } });
}

/** Normalize a string: lowercase, strip punctuation, collapse spaces. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Word-overlap ratio between two normalized strings (0–1). */
function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.split(" ").filter(Boolean));
  const wb = new Set(b.split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

/**
 * Extract a course code like "CHEM1752" or "CHEM 1752" from a string.
 * Gradescope names often look like "Spring 2026.CHEM.1752.A".
 * Canvas shortName is usually "CHEM 1752".
 */
function extractCourseCode(s: string): string | null {
  const m = s.match(/\b([A-Z]{2,6})\s*[.\-]?\s*(\d{3,4})\b/);
  if (!m) return null;
  return `${m[1]}${m[2]}`; // e.g. "CHEM1752"
}

/**
 * Infer assignment type from title keywords.
 * Used when creating Gradescope-only assignments that have no Canvas equivalent.
 */
function inferType(title: string): string {
  const t = title.toLowerCase();
  if (/(exam|midterm|final)/.test(t)) return "exam";
  if (/quiz/.test(t)) return "quiz";
  if (/(lab|report|prescan|data)/.test(t)) return "lab";
  if (/project/.test(t)) return "project";
  if (/reading/.test(t)) return "reading";
  return "assignment";
}

interface GradescopeAssignment {
  title: string;
  score: number | null;
  maxScore: number | null;
  status: string;
  gradescopeAssignmentId: string | null;
}

interface GradescopeCourse {
  name: string;
  gradescopeCourseId?: string;
  assignments: GradescopeAssignment[];
}

export async function POST(request: NextRequest) {
  const user = await authedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { courses: GradescopeCourse[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { courses } = body;
  if (!Array.isArray(courses) || courses.length === 0) {
    return NextResponse.json({ updated: 0, created: 0 });
  }

  // Fetch all user courses with assignments
  const userCourses = await db.course.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      shortName: true,
      assignments: {
        select: {
          id: true,
          title: true,
          score: true,
          gradescopeId: true,
        },
      },
    },
  });

  let updated = 0;
  let created = 0;

  for (const gsCourse of courses) {
    // ── Match Gradescope course → Canvas course ──────────────────────────────
    // Strategy 1: extract "SUBJ####" from both names and compare
    const gsCode = extractCourseCode(gsCourse.name.toUpperCase());

    let matchedCourse = gsCode
      ? userCourses.find((uc) => {
          const ucCode =
            extractCourseCode((uc.shortName ?? "").toUpperCase()) ||
            extractCourseCode(uc.name.toUpperCase());
          return ucCode !== null && ucCode === gsCode;
        })
      : undefined;

    // Strategy 2: word-overlap fallback
    if (!matchedCourse) {
      const gsNorm = normalize(gsCourse.name);
      matchedCourse = userCourses.find(
        (uc) =>
          wordOverlap(normalize(uc.name), gsNorm) >= 0.4 ||
          (uc.shortName && wordOverlap(normalize(uc.shortName), gsNorm) >= 0.4)
      );
    }

    if (!matchedCourse) continue;

    const courseId = matchedCourse.id;

    for (const gsAssignment of gsCourse.assignments) {
      const { title, score, maxScore, status, gradescopeAssignmentId } = gsAssignment;

      // ── 1. Exact GS ID match (best case — already created on a prior run) ──
      if (gradescopeAssignmentId) {
        const existing = matchedCourse.assignments.find(
          (a) => a.gradescopeId === gradescopeAssignmentId
        );
        if (existing) {
          // Update score if we now have one
          if (score !== null && maxScore !== null) {
            await db.assignment.update({
              where: { id: existing.id },
              data: { gradescopeScore: score, gradescopeMaxScore: maxScore },
            });
            updated++;
          }
          continue;
        }
      }

      // ── 2. Canvas title fuzzy match ──────────────────────────────────────────
      const gsNormTitle = normalize(title);
      const canvasMatch = matchedCourse.assignments.find(
        (a) =>
          !a.gradescopeId && // skip GS-only assignments we already created
          wordOverlap(normalize(a.title), gsNormTitle) >= 0.6
      );

      if (canvasMatch) {
        // Link the GS ID so future runs use Strategy 1
        if (score !== null && maxScore !== null && canvasMatch.score === null) {
          await db.assignment.update({
            where: { id: canvasMatch.id },
            data: {
              gradescopeScore: score,
              gradescopeMaxScore: maxScore,
              ...(gradescopeAssignmentId ? { gradescopeId: gradescopeAssignmentId } : {}),
            },
          });
          updated++;
        } else if (gradescopeAssignmentId && !canvasMatch.gradescopeId) {
          // At least save the GS ID even if we have no new score
          await db.assignment.update({
            where: { id: canvasMatch.id },
            data: { gradescopeId: gradescopeAssignmentId },
          });
        }
        continue;
      }

      // ── 3. No match → CREATE a new Gradescope-only assignment ───────────────
      // Only create if we have a GS assignment ID (to avoid duplicates on retry)
      if (!gradescopeAssignmentId) continue;

      // Check if we already created this one (race condition guard)
      const alreadyCreated = await db.assignment.findFirst({
        where: { courseId, gradescopeId: gradescopeAssignmentId },
        select: { id: true },
      });
      if (alreadyCreated) continue;

      await db.assignment.create({
        data: {
          courseId,
          title,
          type: inferType(title),
          status: status === "graded" ? "graded" : status === "submitted" ? "submitted" : "not_started",
          gradescopeId: gradescopeAssignmentId,
          gradescopeScore: score,
          gradescopeMaxScore: maxScore,
          pointsPossible: maxScore,
          missing: false,
        },
      });
      created++;
    }
  }

  return NextResponse.json({ ok: true, updated, created });
}
