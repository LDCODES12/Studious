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
  gradescopeFingerprint?: string | null;
  dueDate: string | null;
}

interface GradescopeCourse {
  gradescopeCourseId: string;
  assignments: GradescopeAssignment[];
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalDueDate(dueDate: string | null | undefined): string | null {
  if (!dueDate) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return dueDate;
  const parsed = new Date(dueDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function makeFingerprint(title: string, dueDate: string | null | undefined): string {
  return `${normalizeTitle(title)}|${canonicalDueDate(dueDate) ?? "no-date"}`;
}

function isConcreteGsId(gsId: string | null | undefined): boolean {
  return !!gsId && !gsId.startsWith("fp:") && !gsId.startsWith("synthetic:");
}

function sameDueDay(a: string | null | undefined, b: string | null | undefined): boolean {
  const aa = canonicalDueDate(a);
  const bb = canonicalDueDate(b);
  if (!aa || !bb) return true;
  return aa === bb;
}

function mapDbStatus(status: string | null | undefined): "graded" | "submitted" | "not_started" {
  const s = (status ?? "").toLowerCase().trim();
  if (s === "graded") return "graded";
  if (s === "submitted" || s === "pending_review" || s === "ungraded") return "submitted";
  return "not_started";
}

function isMissingAssignment(
  status: string | null | undefined,
  dbStatus: "graded" | "submitted" | "not_started",
  dueDate: string | null | undefined,
  now: Date,
): boolean {
  const s = (status ?? "").toLowerCase();
  if (s === "missing" || s.includes("late due date passed") || s.includes("due date passed")) return true;
  const due = canonicalDueDate(dueDate);
  if (!due) return false;
  return dbStatus === "not_started" && new Date(`${due}T23:59:59.999Z`) < now;
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

    const localAssignments = [...matchedCourse.assignments];
    const byGsId = new Map<string, (typeof localAssignments)[number]>();
    const byFingerprint = new Map<string, (typeof localAssignments)[number]>();
    for (const a of localAssignments) {
      if (a.gradescopeId) byGsId.set(a.gradescopeId, a);
      const fp = makeFingerprint(a.title, a.dueDate);
      if (!byFingerprint.has(fp)) byFingerprint.set(fp, a);
    }

    for (const gsAssignment of gsCourse.assignments) {
      const { title, score, maxScore, status, gradescopeAssignmentId, dueDate, gradescopeFingerprint } = gsAssignment;
      if (!title?.trim()) continue;

      const incomingGsId = gradescopeAssignmentId?.trim() || null;
      const fingerprint = gradescopeFingerprint?.trim() || makeFingerprint(title, dueDate);
      const syntheticGsId = `fp:${fingerprint}`;
      const dbStatus = mapDbStatus(status);
      const isMissing = isMissingAssignment(status, dbStatus, dueDate, now);

      const applyUpdate = async (target: (typeof localAssignments)[number], attachId: string | null) => {
        const data: Record<string, unknown> = {
          status: dbStatus,
          missing: isMissing,
        };
        if (score !== null && maxScore !== null) {
          data.gradescopeScore = score;
          data.gradescopeMaxScore = maxScore;
        }
        if (dueDate && (!target.dueDate || !sameDueDay(target.dueDate, dueDate))) {
          data.dueDate = canonicalDueDate(dueDate);
        }
        if (attachId && target.gradescopeId !== attachId) data.gradescopeId = attachId;

        await db.assignment.update({ where: { id: target.id }, data });
        if (data.dueDate) target.dueDate = String(data.dueDate);
        target.status = dbStatus;
        target.missing = isMissing;
        if (attachId) {
          target.gradescopeId = attachId;
          byGsId.set(attachId, target);
        }
        byFingerprint.set(makeFingerprint(target.title, target.dueDate), target);
      };

      // 1) Exact GS ID / synthetic fingerprint ID match
      let matched =
        (incomingGsId ? byGsId.get(incomingGsId) : null) ??
        byGsId.get(syntheticGsId);
      if (matched) {
        const attachId = incomingGsId || matched.gradescopeId || syntheticGsId;
        await applyUpdate(matched, attachId);
        updated++;
        courseUpdated++;
        continue;
      }

      // 2) Deterministic title (+ optional date) match inside already-confirmed course
      const gsNorm = normalizeTitle(title);
      matched = localAssignments.find((a) => {
        if (normalizeTitle(a.title) !== gsNorm) return false;
        if (!sameDueDay(a.dueDate, dueDate)) return false;
        if (!incomingGsId) return true;
        return !isConcreteGsId(a.gradescopeId) || a.gradescopeId === incomingGsId;
      });
      if (!matched) matched = byFingerprint.get(fingerprint);

      if (matched) {
        const attachId = incomingGsId || matched.gradescopeId || syntheticGsId;
        await applyUpdate(matched, attachId);
        updated++;
        courseUpdated++;
        continue;
      }

      // 3) Not in memory — verify DB to avoid duplicate creates
      const dbIdToCheck = incomingGsId || syntheticGsId;
      const existingById = await db.assignment.findFirst({
        where: { courseId, gradescopeId: dbIdToCheck },
        select: { id: true, title: true, dueDate: true, status: true, missing: true, score: true, gradescopeId: true },
      });
      if (existingById) {
        await db.assignment.update({
          where: { id: existingById.id },
          data: {
            status: dbStatus,
            missing: isMissing,
            dueDate: canonicalDueDate(dueDate) ?? existingById.dueDate,
            gradescopeId: incomingGsId || existingById.gradescopeId,
            ...(score !== null && maxScore !== null
              ? { gradescopeScore: score, gradescopeMaxScore: maxScore }
              : {}),
          },
        });
        updated++;
        courseUpdated++;
        continue;
      }

      const existingByTitleDue = await db.assignment.findFirst({
        where: { courseId, title, dueDate: canonicalDueDate(dueDate) },
        select: { id: true, title: true, dueDate: true, status: true, missing: true, score: true, gradescopeId: true },
      });
      if (existingByTitleDue) {
        await db.assignment.update({
          where: { id: existingByTitleDue.id },
          data: {
            status: dbStatus,
            missing: isMissing,
            gradescopeId: incomingGsId || existingByTitleDue.gradescopeId || syntheticGsId,
            ...(score !== null && maxScore !== null
              ? { gradescopeScore: score, gradescopeMaxScore: maxScore }
              : {}),
          },
        });
        updated++;
        courseUpdated++;
        continue;
      }

      // 4) Create Gradescope-only assignment (including rows with no concrete GS ID)
      const createdRow = await db.assignment.create({
        data: {
          courseId,
          title,
          type: inferType(title),
          dueDate: canonicalDueDate(dueDate) ?? null,
          status: dbStatus,
          gradescopeId: incomingGsId || syntheticGsId,
          gradescopeScore: score,
          gradescopeMaxScore: maxScore,
          pointsPossible: maxScore,
          missing: isMissing,
        },
        select: { id: true, title: true, score: true, gradescopeId: true, dueDate: true, status: true, missing: true },
      });
      localAssignments.push(createdRow);
      if (createdRow.gradescopeId) byGsId.set(createdRow.gradescopeId, createdRow);
      byFingerprint.set(makeFingerprint(createdRow.title, createdRow.dueDate), createdRow);
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
