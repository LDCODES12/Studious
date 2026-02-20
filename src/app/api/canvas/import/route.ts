import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseSyllabusTopics } from "@/lib/parse-syllabus";
import crypto from "crypto";

// ─── Types mirroring what the extension sends ────────────────────────────────

/**
 * The extension extracts PDF text client-side (via pdfjs-dist in an offscreen
 * document) and sends us plain text — no base64, no server-side PDF work.
 */
interface SyllabusText {
  fileName: string;
  text: string;
}

interface CanvasCourse {
  id: number;
  name: string;
  courseCode: string | null;
  term: string | null;
  instructor: string | null;
  /** HTML from Canvas's built-in syllabus page, or null */
  syllabusBody?: string | null;
  /** Pre-extracted syllabus text from PDFs (offscreen doc ran pdfjs-dist) */
  syllabusTexts?: SyllabusText[];
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

/** Strip HTML tags and decode common entities to plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function authedUser(request: NextRequest) {
  const authHeader = request.headers.get("Authorization") ?? "";
  const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!rawToken) return null;
  const hash = sha256(rawToken);
  return db.user.findUnique({ where: { apiTokenHash: hash }, select: { id: true } });
}

// ─── GET — live stats (called by extension on popup open) ────────────────────

export async function GET(request: NextRequest) {
  const user = await authedUser(request);
  if (!user) return NextResponse.json({ error: "Invalid or missing token" }, { status: 401 });

  const [courses, assignments, topics] = await Promise.all([
    db.course.count({ where: { userId: user.id } }),
    db.assignment.count({ where: { course: { userId: user.id } } }),
    db.courseTopic.count({ where: { course: { userId: user.id } } }),
  ]);

  return NextResponse.json({ courses, assignments, topics });
}

// ─── POST — full Canvas sync ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Authenticate via Bearer token
  const user = await authedUser(request);
  if (!user) return NextResponse.json({ error: "Invalid or missing token" }, { status: 401 });

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

    // Match by canvasCourseId (exact) or exact name (for courses synced before canvasCourseId was stored)
    let existing = existingCourses.find((e) => e.canvasCourseId === canvasId);
    if (!existing) {
      existing = existingCourses.find((e) => e.name.toLowerCase() === lc);
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

  // 6. Upsert modules as CourseTopic (fallback — may be replaced by AI below)
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

  // 7. AI syllabus processing — run all courses in parallel for speed
  //    For each course that provided syllabus content:
  //      a) Build best available syllabus text from HTML body + pre-extracted PDF texts
  //      b) Save PDF-sourced materials as CourseMaterial records
  //      c) Run parseSyllabusTopics() if we have substantial text
  //      d) If AI returns a schedule, replace module-based topics with it
  //
  //    Skip courses that already have AI-parsed topics (canvasModuleId = null)
  //    so subsequent syncs are fast and don't overwrite user-annotated progress.
  //
  //    PDF text extraction is done entirely by the extension (pdfjs-dist in an
  //    offscreen document) — we receive plain text, no binary data, no pdf-parse.

  let aiTopicsCreated = 0;
  let syllabusFilesImported = 0;

  // Collect per-course debug info for a single summary log
  const debugRows: string[] = [];

  await Promise.all(
    courses.map(async (c) => {
      const scCourseId = courseIdMap.get(c.id);
      if (!scCourseId) return;

      // ── a) Check whether AI topics already exist ─────────────────────────
      const existingAiTopics = await db.courseTopic.count({
        where: { courseId: scCourseId, canvasModuleId: null },
      });
      // If we already parsed this course's syllabus, don't overwrite
      const shouldRunAI = existingAiTopics === 0;

      // ── b) Build best available syllabus text ─────────────────────────────
      let syllabusText = c.syllabusBody ? htmlToText(c.syllabusBody) : "";

      // ── c) Process pre-extracted PDF texts ────────────────────────────────
      // The extension extracted this text client-side via pdfjs-dist —
      // no parsing needed here, just use the text directly.
      const syllabusTexts = c.syllabusTexts ?? [];
      for (const st of syllabusTexts) {
        const pdfText = st.text.trim();

        // Prefer the longest text source (PDF often has more detail than HTML body)
        if (pdfText.length > syllabusText.length) {
          syllabusText = pdfText;
        }

        // Save as CourseMaterial (visible in the Materials tab)
        const existing = await db.courseMaterial.findFirst({
          where: { courseId: scCourseId, fileName: st.fileName },
          select: { id: true },
        });
        if (!existing) {
          await db.courseMaterial.create({
            data: {
              courseId: scCourseId,
              fileName: st.fileName,
              detectedType: "syllabus",
              summary: "Syllabus automatically imported from Canvas.",
              relatedTopics: [],
              rawText: pdfText.slice(0, 10_000),
              storedForAI: false,
            },
          });
          syllabusFilesImported++;
        }
      }

      // ── d) AI topic extraction ─────────────────────────────────────────────
      const aiStatus = !shouldRunAI ? "skip:has-ai-topics"
        : syllabusText.length < 500 ? `skip:too-short(${syllabusText.length})`
        : `run(${syllabusText.length})`;

      if (!shouldRunAI || syllabusText.length < 500) {
        debugRows.push(`${c.name}: body=${c.syllabusBody?.length ?? 0} pdfs=[${syllabusTexts.map((f) => `${f.fileName}(${f.text.length}c)`).join(", ")}] → ${aiStatus}`);
        return;
      }

      try {
        // Truncate to ~12k chars — enough for a full semester syllabus
        const topics = await parseSyllabusTopics(syllabusText.slice(0, 12_000));
        if (topics.length === 0) return;

        // Delete module-based topics (those sourced from Canvas modules)
        // and replace with the AI-parsed weekly schedule.
        // Topics from manual syllabus upload (canvasModuleId = null) are
        // already excluded by the shouldRunAI check above.
        await db.courseTopic.deleteMany({
          where: { courseId: scCourseId, canvasModuleId: { not: null } },
        });

        await db.courseTopic.createMany({
          data: topics.map((t) => ({
            courseId: scCourseId,
            weekNumber: t.weekNumber,
            weekLabel: t.weekLabel,
            startDate: typeof t.startDate === "string" ? t.startDate : null,
            topics: Array.isArray(t.topics) ? t.topics.filter((x: unknown) => typeof x === "string") : [],
            readings: Array.isArray(t.readings) ? t.readings.filter((x: unknown) => typeof x === "string") : [],
            // Guard against AI returning [] instead of null/string for notes
            notes: typeof t.notes === "string" ? t.notes : null,
            canvasModuleId: null, // marks this as AI-sourced (not from a Canvas module)
          })),
        });

        aiTopicsCreated += topics.length;
        debugRows.push(`${c.name}: body=${c.syllabusBody?.length ?? 0} pdfs=[${syllabusTexts.map((f) => `${f.fileName}(${f.text.length}c)`).join(", ")}] → ai-ran(${topics.length} weeks)`);
      } catch (err) {
        debugRows.push(`${c.name}: body=${c.syllabusBody?.length ?? 0} pdfs=[${syllabusTexts.map((f) => `${f.fileName}(${f.text.length}c)`).join(", ")}] → ai-error:${err}`);
      }
    })
  );

  console.log("[canvas-import] syllabus summary:\n" + debugRows.join("\n"));

  return NextResponse.json({
    ok: true,
    summary: {
      courses: { new: newCourses, updated: updatedCourses },
      assignments: { new: newAssignments, updated: updatedAssignments },
      modules: { new: newModules, updated: updatedModules },
      syllabus: { aiWeeks: aiTopicsCreated, filesImported: syllabusFilesImported },
    },
  });
}
