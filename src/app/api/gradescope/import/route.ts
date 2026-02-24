import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import crypto from "crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: NextResponse) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

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
  dueDate: string | null;
}

interface GradescopeCourse {
  gradescopeCourseId: string;
  assignments: GradescopeAssignment[];
}

export async function POST(request: NextRequest) {
  const user = await authedUser(request);
  if (!user) {
    return withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }

  const log = apiLogger("POST /api/gradescope/import", user.id);

  let body: { courses: GradescopeCourse[] };
  try {
    body = await request.json();
  } catch {
    return log.respond(withCors(NextResponse.json({ error: "Invalid JSON" }, { status: 400 })));
  }

  const { courses } = body;
  if (!Array.isArray(courses) || courses.length === 0) {
    return log.respond(withCors(NextResponse.json({ updated: 0, created: 0 })), { gsCourses: 0 });
  }

  log.info("import started", { gsCourses: courses.length });

  // Look up all user courses that have a Gradescope ID — direct, deterministic matching
  const userCourses = await db.course.findMany({
    where: { userId: user.id, gradescopeCourseId: { not: null } },
    select: {
      id: true,
      name: true,
      gradescopeCourseId: true,
      assignments: {
        select: { id: true, title: true, score: true, gradescopeId: true, dueDate: true, status: true, missing: true },
      },
    },
  });

  const courseByGsId = new Map(
    userCourses.map((c) => [c.gradescopeCourseId!, c]),
  );

  const now = new Date();
  let updated = 0;
  let created = 0;
  const debugCourses: { gsId: string; matched: string | null; updated: number; created: number }[] = [];

  for (const gsCourse of courses) {
    const { gradescopeCourseId } = gsCourse;
    if (!gradescopeCourseId) continue;

    const matchedCourse = courseByGsId.get(gradescopeCourseId);
    if (!matchedCourse) {
      log.warn("no match for GS course", { gsId: gradescopeCourseId });
      debugCourses.push({ gsId: gradescopeCourseId, matched: null, updated: 0, created: 0 });
      continue;
    }

    const courseId = matchedCourse.id;
    let courseUpdated = 0;
    let courseCreated = 0;

    // Normalize title for fuzzy assignment matching within a course
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

    for (const gsAssignment of gsCourse.assignments) {
      const { title, score, maxScore, status, gradescopeAssignmentId, dueDate } = gsAssignment;

      const dbStatus = status === "graded" ? "graded" : status === "submitted" ? "submitted" : "not_started";
      const isMissing = dbStatus === "not_started" && !!dueDate && new Date(dueDate) < now;

      // 1. Exact GS assignment ID match (best — already linked from a prior sync)
      if (gradescopeAssignmentId) {
        const existing = matchedCourse.assignments.find(
          (a) => a.gradescopeId === gradescopeAssignmentId,
        );
        if (existing) {
          const data: Record<string, unknown> = {};
          if (score !== null && maxScore !== null) {
            data.gradescopeScore = score;
            data.gradescopeMaxScore = maxScore;
          }
          if (dueDate && !existing.dueDate) data.dueDate = dueDate;
          data.status = dbStatus;
          data.missing = isMissing;

          await db.assignment.update({ where: { id: existing.id }, data });
          updated++;
          courseUpdated++;
          continue;
        }
      }

      // 2. Title match within the same course (safe — course is already confirmed)
      const gsNorm = normalize(title);
      const canvasMatch = matchedCourse.assignments.find(
        (a) => !a.gradescopeId && normalize(a.title) === gsNorm,
      );

      if (canvasMatch) {
        const data: Record<string, unknown> = {};
        if (score !== null && maxScore !== null) {
          data.gradescopeScore = score;
          data.gradescopeMaxScore = maxScore;
        }
        if (gradescopeAssignmentId) data.gradescopeId = gradescopeAssignmentId;
        if (dueDate && !canvasMatch.dueDate) data.dueDate = dueDate;
        data.status = dbStatus;
        data.missing = isMissing;

        await db.assignment.update({ where: { id: canvasMatch.id }, data });
        updated++;
        courseUpdated++;
        continue;
      }

      // 3. No match → create a Gradescope-only assignment
      if (!gradescopeAssignmentId) {
        log.info("gs skip: no assignment ID", { title, course: matchedCourse.name });
        continue;
      }

      const alreadyCreated = await db.assignment.findFirst({
        where: { courseId, gradescopeId: gradescopeAssignmentId },
        select: { id: true },
      });
      if (alreadyCreated) {
        log.info("gs skip: already exists", { title, gsId: gradescopeAssignmentId, course: matchedCourse.name });
        continue;
      }

      await db.assignment.create({
        data: {
          courseId,
          title,
          type: inferType(title),
          dueDate: dueDate ?? null,
          status: dbStatus,
          gradescopeId: gradescopeAssignmentId,
          gradescopeScore: score,
          gradescopeMaxScore: maxScore,
          pointsPossible: maxScore,
          missing: isMissing,
        },
      });
      created++;
      courseCreated++;
    }

    // ── Post-processing: fill dates from syllabus events ─────────────────
    // Cross-source reconciliation: if an assignment has no due date, check
    // the AI-extracted syllabus events for a matching title.
    const undated = await db.assignment.findMany({
      where: { courseId, dueDate: null },
      select: { id: true, title: true },
    });

    if (undated.length > 0) {
      const course = await db.course.findUnique({
        where: { id: courseId },
        select: { syllabusEvents: true },
      });

      const events = Array.isArray(course?.syllabusEvents)
        ? (course.syllabusEvents as { title: string; dueDate: string; type: string }[])
        : [];

      if (events.length > 0) {
        const normalizeTitle = (s: string) =>
          s.toLowerCase().replace(/[^a-z0-9]/g, "");

        const eventsByNorm = new Map(
          events.filter((e) => e.dueDate).map((e) => [normalizeTitle(e.title), e.dueDate]),
        );

        for (const a of undated) {
          const match = eventsByNorm.get(normalizeTitle(a.title));
          if (match) {
            await db.assignment.update({
              where: { id: a.id },
              data: { dueDate: match },
            });
            courseUpdated++;
            log.info("filled date from syllabus", { title: a.title, dueDate: match });
          }
        }
      }
    }

    log.info("course matched", {
      gsId: gradescopeCourseId,
      matched: matchedCourse.name,
      updated: courseUpdated,
      created: courseCreated,
    });
    debugCourses.push({ gsId: gradescopeCourseId, matched: matchedCourse.name, updated: courseUpdated, created: courseCreated });
  }

  return log.respond(
    withCors(NextResponse.json({ ok: true, updated, created, debug: { courses: debugCourses } })),
    { gsUpdated: updated, gsCreated: created },
  );
}
