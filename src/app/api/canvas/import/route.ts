import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import crypto from "crypto";

// ─── Types mirroring what the extension sends ────────────────────────────────

interface CanvasCourse {
  id: number;
  name: string;
  courseCode: string | null;
  term: string | null;
  instructor: string | null;
}

interface CanvasAssignment {
  id: number;
  courseId: number;
  title: string;
  dueDate: string; // ISO datetime
  description: string | null;
  submissionType: string;
  htmlUrl: string | null;
  pointsPossible: number | null;
}

interface CanvasModule {
  courseId: number;
  moduleId: number;
  position: number;
  name: string;
  topics: string[];   // content item titles (Pages, Files, ExternalUrls)
  readings: string[]; // file/url item titles
}

interface ImportPayload {
  courses: CanvasCourse[];
  assignments: CanvasAssignment[];
  modules: CanvasModule[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const COLORS = ["blue", "green", "purple", "orange", "rose"];

function inferType(title: string, submissionType: string): string {
  if (submissionType === "online_quiz") return "quiz";
  const t = title.toLowerCase();
  if (/\b(quiz)\b/.test(t)) return "quiz";
  if (/\b(exam|midterm|final|test)\b/.test(t)) return "exam";
  if (/\b(project)\b/.test(t)) return "project";
  if (/\b(lab)\b/.test(t)) return "lab";
  if (/\b(reading|discussion)\b/.test(t)) return "reading";
  return "assignment";
}

/** Canvas returns ISO datetime; we store YYYY-MM-DD */
function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Authenticate via Bearer token
  const authHeader = request.headers.get("Authorization") ?? "";
  const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (!rawToken) {
    return NextResponse.json({ error: "Missing authorization token" }, { status: 401 });
  }

  const hash = sha256(rawToken);
  const user = await db.user.findUnique({
    where: { apiTokenHash: hash },
    select: { id: true },
  });

  if (!user) {
    return NextResponse.json({ error: "Invalid or revoked token" }, { status: 401 });
  }

  // 2. Parse payload
  const payload: ImportPayload = await request.json();
  const { courses = [], assignments = [], modules = [] } = payload;

  // 3. Load existing courses for color + fuzzy matching
  const existingCourses = await db.course.findMany({
    where: { userId: user.id },
    select: { id: true, name: true, color: true, canvasCourseId: true },
  });

  const usedColors = new Set(existingCourses.map((c) => c.color));
  const nextColor = () =>
    COLORS.find((c) => !usedColors.has(c)) ?? COLORS[existingCourses.length % COLORS.length];

  // courseId mapping: Canvas course ID → Study Circle course ID
  const courseIdMap = new Map<number, string>();

  let newCourses = 0;
  let updatedCourses = 0;

  // 4. Upsert courses
  for (const c of courses) {
    const canvasId = String(c.id);
    const lc = c.name.toLowerCase();

    // First try exact match by canvasCourseId, then fuzzy by name
    let existing = existingCourses.find((e) => e.canvasCourseId === canvasId);
    if (!existing) {
      existing = existingCourses.find(
        (e) =>
          e.name.toLowerCase() === lc ||
          e.name.toLowerCase().includes(lc) ||
          lc.includes(e.name.toLowerCase())
      );
    }

    if (existing) {
      await db.course.update({
        where: { id: existing.id },
        data: {
          canvasCourseId: canvasId,
          instructor: c.instructor ?? undefined,
          term: c.term ?? undefined,
          shortName: c.courseCode ?? undefined,
        },
      });
      courseIdMap.set(c.id, existing.id);
      updatedCourses++;
    } else {
      const color = nextColor();
      usedColors.add(color);
      const created = await db.course.create({
        data: {
          userId: user.id,
          canvasCourseId: canvasId,
          name: c.name,
          shortName: c.courseCode ?? null,
          instructor: c.instructor ?? null,
          term: c.term ?? null,
          color,
        },
      });
      existingCourses.push({ id: created.id, name: created.name, color, canvasCourseId: canvasId });
      courseIdMap.set(c.id, created.id);
      newCourses++;
    }
  }

  // 5. Upsert assignments
  let newAssignments = 0;
  let updatedAssignments = 0;

  for (const a of assignments) {
    const scCourseId = courseIdMap.get(a.courseId);
    if (!scCourseId || !a.dueDate) continue;

    const canvasAssId = String(a.id);
    const dueDate = toDateOnly(a.dueDate);
    const type = inferType(a.title, a.submissionType);

    // Clean HTML from description
    const description = a.description
      ? a.description.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 1000) || null
      : null;

    const existing = await db.assignment.findFirst({
      where: { courseId: scCourseId, canvasAssignmentId: canvasAssId },
      select: { id: true },
    });

    if (existing) {
      await db.assignment.update({
        where: { id: existing.id },
        data: { title: a.title, dueDate, description, canvasUrl: a.htmlUrl, pointsPossible: a.pointsPossible },
      });
      updatedAssignments++;
    } else {
      await db.assignment.create({
        data: {
          courseId: scCourseId,
          canvasAssignmentId: canvasAssId,
          title: a.title,
          type,
          dueDate,
          description,
          canvasUrl: a.htmlUrl ?? null,
          pointsPossible: a.pointsPossible ?? null,
        },
      });
      newAssignments++;
    }
  }

  // 6. Upsert modules as CourseTopics
  let newModules = 0;
  let updatedModules = 0;

  for (const mod of modules) {
    const scCourseId = courseIdMap.get(mod.courseId);
    if (!scCourseId) continue;

    const canvasModId = String(mod.moduleId);

    const existing = await db.courseTopic.findFirst({
      where: { courseId: scCourseId, canvasModuleId: canvasModId },
      select: { id: true, completedTopics: true },
    });

    if (existing) {
      await db.courseTopic.update({
        where: { id: existing.id },
        data: {
          weekNumber: mod.position,
          weekLabel: mod.name,
          topics: mod.topics,
          readings: mod.readings,
          // Preserve completedTopics — never overwrite user progress
        },
      });
      updatedModules++;
    } else {
      await db.courseTopic.create({
        data: {
          courseId: scCourseId,
          canvasModuleId: canvasModId,
          weekNumber: mod.position,
          weekLabel: mod.name,
          topics: mod.topics,
          readings: mod.readings,
        },
      });
      newModules++;
    }
  }

  return NextResponse.json({
    ok: true,
    summary: {
      courses: { new: newCourses, updated: updatedCourses },
      assignments: { new: newAssignments, updated: updatedAssignments },
      modules: { new: newModules, updated: updatedModules },
    },
  });
}
