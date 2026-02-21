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

/** Normalize a string for fuzzy title matching: lowercase, strip punctuation, collapse spaces. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Word-overlap ratio between two normalized strings (0-1). */
function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.split(" ").filter(Boolean));
  const wb = new Set(b.split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

interface GradescopeAssignment {
  title: string;
  score: number | null;
  maxScore: number | null;
  status: string;
}

interface GradescopeCourse {
  name: string;
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
    return NextResponse.json({ updated: 0 });
  }

  // Fetch all user courses with their assignments
  const userCourses = await db.course.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      assignments: {
        select: {
          id: true,
          title: true,
          score: true,
          submissionTypes: true,
        },
      },
    },
  });

  let updated = 0;

  for (const gsCourse of courses) {
    const gsNorm = normalize(gsCourse.name);

    // Match Gradescope course to Canvas course by name
    const matchedCourse = userCourses.find((uc) => wordOverlap(normalize(uc.name), gsNorm) >= 0.5);
    if (!matchedCourse) continue;

    for (const gsAssignment of gsCourse.assignments) {
      // Only process graded assignments with actual scores
      if (gsAssignment.score === null || gsAssignment.maxScore === null) continue;

      const gsNormTitle = normalize(gsAssignment.title);

      // Match to Canvas assignment by title overlap
      const matchedAssignment = matchedCourse.assignments.find(
        (a) => wordOverlap(normalize(a.title), gsNormTitle) >= 0.6
      );
      if (!matchedAssignment) continue;

      // Only update if Canvas doesn't already have the score
      if (matchedAssignment.score !== null) continue;

      await db.assignment.update({
        where: { id: matchedAssignment.id },
        data: {
          gradescopeScore: gsAssignment.score,
          gradescopeMaxScore: gsAssignment.maxScore,
        },
      });
      updated++;
    }
  }

  return NextResponse.json({ ok: true, updated });
}
