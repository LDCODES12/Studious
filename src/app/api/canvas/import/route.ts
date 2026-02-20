import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseSyllabusTopics } from "@/lib/parse-syllabus";
import crypto from "crypto";

export const maxDuration = 120; // allow up to 2 min for parallel AI syllabus parsing

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

/**
 * Score a text blob for schedule-content density.
 * Higher = more likely to contain a real week-by-week schedule.
 * Used to pick the best source when multiple are available.
 */
function scheduleScore(text: string): number {
  if (!text || text.length < 50) return 0;
  const t = text.toLowerCase();
  // Strong indicators: explicit week/lecture markers with numbers
  const weekHits   = (t.match(/\b(week|lecture|class|session|module)\s*\d+/g) ?? []).length;
  // Medium: date patterns (Jan 13, 1/13, 01/13)
  const dateHits   = (t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\b\d{1,2}\/\d{1,2}\b/g) ?? []).length;
  // Medium: topic indicators
  const topicHits  = (t.match(/\b(introduction|overview|chapter|ch\.\s*\d|topic[s]?:|reading[s]?:)/g) ?? []).length;
  // Penalty: heavy policy language — indicates admin-only content
  const policyHits = (t.match(/\b(attendance|grading|plagiarism|academic\s+integrity|office\s+hours|late\s+(work|penalty)|point[s]?\s+possible)/g) ?? []).length;

  const raw = weekHits * 4 + dateHits * 2 + topicHits * 2 - policyHits * 1;
  // Normalise per 500 chars of text — measures schedule density, not absolute count.
  // Linear normalisation: a 10k-char policy page with the same hit count as a
  // 1k-char schedule table correctly scores 10x lower.
  return raw / (text.length / 500);
}

/** Strip HTML tags and decode common entities to plain text.
 *  Block-level elements (tr, li, p, headings, div) become newlines so
 *  table rows and list items survive as separate lines for the AI.
 */
function htmlToText(html: string): string {
  return html
    // Block elements → newline so table rows/list items stay as lines
    .replace(/<\/?(tr|li|p|br|h[1-6]|div|section|thead|tbody)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")     // remaining inline tags → space
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")      // collapse horizontal whitespace only
    .replace(/\n[ \t]+/g, "\n")   // trim leading spaces on each line
    .replace(/\n{3,}/g, "\n\n")   // max two blank lines
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

      // ── b+c) Pick best source by schedule-content density ─────────────────
      // Collect all candidate texts, score each, use the highest-scoring one.
      // "Longest text" is a poor proxy — a 10k-char policy page scores lower
      // than a 3k-char week-by-week schedule table.
      const syllabusTexts = c.syllabusTexts ?? [];

      type ScoredSource = { text: string; score: number; label: string };
      const candidates: ScoredSource[] = [];

      if (c.syllabusBody) {
        const bodyText = htmlToText(c.syllabusBody);
        if (bodyText.length >= 100) {
          candidates.push({ text: bodyText, score: scheduleScore(bodyText), label: "html-body" });
        }
      }

      for (const st of syllabusTexts) {
        const pdfText = st.text.trim();
        if (pdfText.length >= 100) {
          candidates.push({ text: pdfText, score: scheduleScore(pdfText), label: st.fileName });
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

      // Pick highest-scoring candidate; fall back to longest if all score 0
      candidates.sort((a, b) => b.score !== a.score ? b.score - a.score : b.text.length - a.text.length);
      const best = candidates[0];
      const syllabusText = best?.text ?? "";
      const bestLabel = best ? `${best.label}(score=${best.score.toFixed(3)},${best.text.length}c)` : "none";

      // ── d) AI topic extraction ─────────────────────────────────────────────
      const aiStatus = !shouldRunAI ? "skip:has-ai-topics"
        : syllabusText.length < 500 ? `skip:too-short(${syllabusText.length})`
        : `run(${syllabusText.length})`;

      if (!shouldRunAI || syllabusText.length < 500) {
        debugRows.push(`${c.name}: best=${bestLabel} → ${aiStatus}`);
        return;
      }

      try {
        // Truncate to ~12k chars — enough for a full semester syllabus
        const rawTopics = await parseSyllabusTopics(syllabusText.slice(0, 12_000));

        // Drop weeks that have nothing to show — empty topics, empty readings,
        // and no notes. These are placeholder rows the AI emits when it finds
        // date markers but no actual schedule content (e.g. Calc 3 policy pages).
        const topics = rawTopics.filter((t) => {
          const hasTopics = Array.isArray(t.topics) && t.topics.length > 0;
          const hasReadings = Array.isArray(t.readings) && t.readings.length > 0;
          const hasNotes = typeof t.notes === "string" && t.notes.trim().length > 0;
          return hasTopics || hasReadings || hasNotes;
        });

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
        debugRows.push(`${c.name}: best=${bestLabel} → ai-ran(${topics.length} weeks)`);
      } catch (err) {
        debugRows.push(`${c.name}: best=${bestLabel} → ai-error:${err}`);
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
