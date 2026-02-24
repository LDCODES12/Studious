import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  parseSyllabusTopics,
    sanitizeSchedule,
    renumberSequentialWeeks,
    auditSchedule,
  needsAudit,
  extractDropRules,
  extractClassSchedule,
  extractScheduleFromCalendarEvents,
  parseSyllabusText,
  type ParsedTopic,
} from "@/lib/parse-syllabus";
import crypto from "crypto";
import { generateTasksForUser } from "@/lib/tasks";
import { analyzeCourseMaterial } from "@/lib/analyze-material";
import { generateEmbedding } from "@/lib/embeddings";

export const maxDuration = 300; // allow up to 5 min for parallel AI syllabus parsing

// ─── Types mirroring what the extension sends ────────────────────────────────

/**
 * The extension extracts PDF text client-side (via pdfjs-dist in an offscreen
 * document) and sends us plain text — no base64, no server-side PDF work.
 */
interface SyllabusText {
  fileName: string;
  text: string;
}

interface MaterialCandidate {
  fileName: string;
  moduleName: string;
  contentId: string;
}

interface CanvasCourse {
  id: number;
  name: string;
  courseCode: string | null;
  term: string | null;
  instructor: string | null;
  /** Canvas's authoritative flag for weighted grading */
  applyGroupWeights?: boolean;
  /** Letter grade from Canvas enrollment (e.g. "A-") */
  currentGrade?: string | null;
  /** Numeric score from Canvas enrollment (e.g. 91.4) */
  currentScore?: number | null;
  /** Grading standard cutoffs: [{ name: "A", value: 0.94 }, ...] */
  gradingScheme?: { name: string; value: number }[] | null;
  /** HTML from Canvas's built-in syllabus page, or null */
  syllabusBody?: string | null;
  /** Pre-extracted syllabus text from PDFs (offscreen doc ran pdfjs-dist) */
  syllabusTexts?: SyllabusText[];
  /** Pre-extracted text from non-syllabus course materials (problem sets, lecture notes, etc.) */
  materialTexts?: SyllabusText[];
  /** All PDF file metadata from non-orientation modules — stored as candidates for student selection */
  materialCandidates?: MaterialCandidate[];
  /** ISO start date of the course term (e.g. "2026-01-13T00:00:00Z") */
  termStartAt?: string | null;
  /** ISO end date of the course term */
  termEndAt?: string | null;
  /** 3-week window of Canvas calendar events — used as fallback for class schedule when syllabus lacks times */
  calendarEvents?: { title: string; startAt: string; endAt: string; location: string | null }[];
  /** Gradescope course ID extracted from the Canvas LTI tab link */
  gradescopeCourseId?: string | null;
}

interface CanvasAssignment {
  id: number;
  courseId: number;
  title: string;
  dueDate: string | null; // ISO datetime — nullable for participation/attendance items
  description: string | null;
  submissionType: string;
  submissionTypes?: string[];
  gradingType?: string | null;
  omitFromFinalGrade?: boolean;
  htmlUrl: string | null;
  pointsPossible: number | null;
  /** Canvas submission status: "not_started" | "submitted" | "graded" */
  submissionStatus?: string | null;
  /** Student's score from Canvas submission */
  score?: number | null;
  /** ISO datetime when student submitted */
  submittedAt?: string | null;
  /** Canvas submission flags */
  excused?: boolean;
  late?: boolean;
  missing?: boolean;
  /** Canvas assignment_group_id */
  assignmentGroupId?: number | null;
}

interface CanvasModule {
  courseId: number;
  moduleId: number;
  position: number;
  name: string;
  topics: string[];   // content item titles (Pages, Files, ExternalUrls)
  readings: string[]; // file/url item titles
}

interface CanvasAnnouncement {
  courseId: number;
  canvasId: string;
  title: string;
  body: string | null;
  postedAt: string | null;
}

interface CanvasAssignmentGroup {
  courseId: number;
  canvasGroupId: string;
  name: string;
  weight: number;
  position: number;
  dropLowest: number;
  dropHighest: number;
  neverDrop?: string[];
}

interface ImportPayload {
  courses: CanvasCourse[];
  assignments: CanvasAssignment[];
  modules: CanvasModule[];
  announcements?: CanvasAnnouncement[];
  assignmentGroups?: CanvasAssignmentGroup[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const COLORS = ["blue", "green", "purple", "orange", "rose"];

function inferType(
  title: string,
  submissionTypes: string[],
  gradingType: string | null,
): string {
  // Canvas-authoritative signals first
  if (submissionTypes.includes("online_quiz")) return "quiz";
  if (gradingType === "not_graded") return "reading";
  if (submissionTypes.includes("discussion_topic")) return "reading";
  // Title-based fallback for ambiguous items
  const t = title.toLowerCase();
  if (/\b(quiz)\b/.test(t)) return "quiz";
  if (/\b(exam|midterm|final|test)\b/.test(t)) return "exam";
  if (/\b(project)\b/.test(t)) return "project";
  if (/\b(lab)\b/.test(t)) return "lab";
  if (/\b(reading|discussion)\b/.test(t)) return "reading";
  return "assignment";
}

/** Canvas returns ISO datetime; we store YYYY-MM-DD. Returns null if input is null. */
function toDateOnly(iso: string | null): string | null {
  if (!iso) return null;
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
  // Strong indicators: explicit week/lecture/experiment/lab markers with numbers
  const weekHits   = (t.match(/\b(week|lecture|class|session|module|experiment|lab|unit)\s*\d+/g) ?? []).length;
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

/**
 * Detect the structural format of a text blob so the AI knows how to parse it.
 * Returns a short description that is prepended to the AI prompt as [Source: ...].
 */
function detectSourceFormat(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return "short text";

  // Detect Sun-Mon-Tue-Wed-Thu-Fri-Sat calendar grid (common in lab/science syllabi)
  // These appear as color-coded weekly grids with day-names as column headers.
  // Match both full day names (Sunday) and common abbreviations (Sun, Su, Mo, Tu...).
  // The PDF extractor preserves rows as tab-separated lines; the AI uses tabs to parse.
  // REQUIRE both day-name hits AND actual tab characters: day names alone appear in any
  // syllabus that says "Monday/Wednesday lectures" or lists office hours by day. Tabs
  // confirm that assembleLines() actually preserved a physical grid's column structure.
  const dayNameHits = (text.match(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/gi
  ) ?? []).length;
  const tabLines = lines.filter((l) => l.includes("\t")).length;
  const hasTabStructure = lines.length > 0 && tabLines / lines.length > 0.15;
  if (dayNameHits >= 5 && hasTabStructure) return "weekly calendar grid (7-column Sun-Sat; each row = one week; cells contain date + optional event text)";

  if (tabLines / lines.length > 0.25) return "tab-separated table";
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  const shortLineRatio = lines.filter((l) => l.length < 120).length / lines.length;
  if (avgLen < 90 && shortLineRatio > 0.65 && lines.length > 4)
    return "structured schedule (one entry per line)";
  const bulletRatio =
    lines.filter((l) => /^[-•*·]\s/.test(l.trim())).length / lines.length;
  if (bulletRatio > 0.25) return "bulleted list";
  return "paragraph text";
}

/** Returns true if an AI-returned topic has at least one piece of content.
 *  Also accepts date-only entries (seminar meeting dates) that have a valid
 *  ISO startDate even when topics/readings/notes are empty — those are real
 *  calendar markers worth keeping. */
function isContentfulTopic(t: ParsedTopic): boolean {
  if (Array.isArray(t.topics) && t.topics.length > 0) return true;
  if (Array.isArray(t.readings) && t.readings.length > 0) return true;
  if (typeof t.notes === "string" && t.notes.trim().length > 0) return true;
  // Accept date-only sessions (e.g. seminars that only list meeting dates)
  return typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate);
}

/**
 * For long texts, pick the 12k-char window most likely to contain the
 * weekly schedule rather than always slicing from the front.
 *
 * Many syllabi open with a multi-page policy preamble (grading, attendance,
 * late work, academic integrity) before the actual week-by-week table — a
 * 40k-char PDF can have its schedule starting at char 15k or later.
 *
 * We evaluate 4 evenly-spaced windows (0%, 33%, 66%, 100% from the end)
 * and return the one with the highest scheduleScore. If the text fits in
 * maxLen already, the full text is returned unchanged.
 */
function bestWindow(text: string, maxLen = 12_000): string {
  if (text.length <= maxLen) return text;
  const end = text.length - maxLen;
  const offsets = [0, Math.floor(end / 3), Math.floor(end * 2 / 3), end];
  let best = "";
  let bestScore = -Infinity;
  for (const offset of offsets) {
    const slice = text.slice(offset, offset + maxLen);
    const s = scheduleScore(slice);
    if (s > bestScore) { bestScore = s; best = slice; }
  }
  return best;
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
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "-")
    .replace(/&#8211;|&#x2013;/gi, "-")
    .replace(/&#8212;|&#x2014;/gi, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")      // collapse horizontal whitespace only
    .replace(/\n[ \t]+/g, "\n")   // trim leading spaces on each line
    .replace(/\n{3,}/g, "\n\n")   // max two blank lines
    .trim();
}

function classScheduleProbe(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  return {
    chars: text.length,
    hasMeetingHeading: /\b(meeting times?|class times?|course schedule)\b/i.test(text),
    hasDayNames: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|wednesdays|fridays)\b/i.test(text),
    hasCompactDays: /\b(MWF|TR|TTH|MON\/WED\/FRI)\b/i.test(text),
    hasTimeRange:
      /\d{1,2}(?::\d{2})?\s*[AP]M\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*[AP]M/i.test(text) ||
      /\d{1,2}(?::\d{2})?\s*[AP]M\s+to\s+\d{1,2}(?::\d{2})?\s*[AP]M/i.test(text),
    snippet: compact.slice(0, 500),
  };
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

  const log = apiLogger("GET /api/canvas/import", user.id);

  const [courses, assignments, topics] = await Promise.all([
    db.course.count({ where: { userId: user.id } }),
    db.assignment.count({ where: { course: { userId: user.id } } }),
    db.courseTopic.count({ where: { course: { userId: user.id } } }),
  ]);

  return log.respond(NextResponse.json({ courses, assignments, topics }), { courses, assignments, topics });
}

// ─── POST — full Canvas sync ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Authenticate via Bearer token
  const user = await authedUser(request);
  if (!user) return NextResponse.json({ error: "Invalid or missing token" }, { status: 401 });

  const log = apiLogger("POST /api/canvas/import", user.id);

  // 2. Parse payload
  const payload: ImportPayload = await request.json();
  const { courses = [], assignments = [], modules = [], announcements = [], assignmentGroups: rawGroups = [] } = payload;

  log.info("sync started", {
    courses: courses.length,
    assignments: assignments.length,
    modules: modules.length,
    announcements: announcements.length,
    assignmentGroups: rawGroups.length,
    gradescopeLinks: courses
      .filter((c) => c.gradescopeCourseId)
      .map((c) => ({ name: c.name, gsId: c.gradescopeCourseId })),
  });

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
          gradescopeCourseId: c.gradescopeCourseId ?? undefined,
          instructor: c.instructor ?? undefined,
          term: c.term ?? undefined,
          shortName: c.courseCode ?? undefined,
          currentGrade: c.currentGrade ?? undefined,
          currentScore: c.currentScore ?? undefined,
          gradingScheme: c.gradingScheme ?? undefined,
          applyGroupWeights: c.applyGroupWeights ?? false,
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
          gradescopeCourseId: c.gradescopeCourseId ?? null,
          name: c.name,
          shortName: c.courseCode ?? null,
          instructor: c.instructor ?? null,
          term: c.term ?? null,
          color,
          currentGrade: c.currentGrade ?? null,
          currentScore: c.currentScore ?? null,
          gradingScheme: c.gradingScheme ?? undefined,
          applyGroupWeights: c.applyGroupWeights ?? false,
        },
      });
      existingCourses.push({ id: created.id, name: created.name, color, canvasCourseId: canvasId });
      courseIdMap.set(c.id, created.id);
      newCourses++;
    }
  }

  // 5. Upsert assignment groups — parallel upserts (@@unique on courseId+canvasGroupId)
  let newGroups = 0;
  let updatedGroups = 0;
  // Maps "scCourseId:canvasGroupId" → SC AssignmentGroup ID
  const groupIdMap = new Map<string, string>();
  const allScCourseIds = [...courseIdMap.values()];

  {
    // Fetch existing to distinguish new vs updated for counters
    const existingGroupsDb = await db.assignmentGroup.findMany({
      where: { courseId: { in: allScCourseIds } },
      select: { courseId: true, canvasGroupId: true },
    });
    const existingGroupSet = new Set(existingGroupsDb.map(g => `${g.courseId}:${g.canvasGroupId}`));

    // All upserts run in parallel — AssignmentGroup has @@unique([courseId, canvasGroupId])
    const upserted = await Promise.all(
      rawGroups
        .filter(g => courseIdMap.has(g.courseId))
        .map(async (g) => {
          const scCourseId = courseIdMap.get(g.courseId)!;
          const fields = { name: g.name, weight: g.weight, position: g.position, dropLowest: g.dropLowest, dropHighest: g.dropHighest, neverDrop: g.neverDrop ?? [] };
          const result = await db.assignmentGroup.upsert({
            where: { courseId_canvasGroupId: { courseId: scCourseId, canvasGroupId: g.canvasGroupId } },
            update: fields,
            create: { courseId: scCourseId, canvasGroupId: g.canvasGroupId, ...fields },
            select: { id: true, courseId: true, canvasGroupId: true },
          });
          const key = `${scCourseId}:${g.canvasGroupId}`;
          if (existingGroupSet.has(key)) updatedGroups++; else newGroups++;
          return result;
        })
    );
    for (const g of upserted) {
      groupIdMap.set(`${g.courseId}:${g.canvasGroupId}`, g.id);
    }
  }

  // 6. Upsert assignments — bulk fetch then createMany + parallel updates
  let newAssignments = 0;
  let updatedAssignments = 0;

  {
    // One query to find all existing Canvas assignments for this user's courses
    const existingAssDb = await db.assignment.findMany({
      where: { courseId: { in: allScCourseIds }, canvasAssignmentId: { not: null } },
      select: { id: true, courseId: true, canvasAssignmentId: true },
    });
    const existingAssMap = new Map(
      existingAssDb.map(a => [`${a.courseId}:${a.canvasAssignmentId}`, a.id])
    );

    type AssCreate = Prisma.AssignmentCreateManyInput;
    type AssUpdate = { id: string; data: Prisma.AssignmentUncheckedUpdateInput };
    const assCreates: AssCreate[] = [];
    const assUpdates: AssUpdate[] = [];

    for (const a of assignments) {
      const scCourseId = courseIdMap.get(a.courseId);
      if (!scCourseId) continue;

      const canvasAssId = String(a.id);
      const dueDate = toDateOnly(a.dueDate);
      const type = inferType(a.title, a.submissionTypes ?? [a.submissionType], a.gradingType ?? null);
      const description = a.description
        ? a.description.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 1000) || null
        : null;
      const status = a.submissionStatus ?? "not_started";
      const scGroupId = a.assignmentGroupId
        ? groupIdMap.get(`${scCourseId}:${String(a.assignmentGroupId)}`)
        : undefined;
      const extraFields = {
        gradingType: a.gradingType ?? null,
        submissionTypes: a.submissionTypes ?? [],
        omitFromFinalGrade: a.omitFromFinalGrade ?? false,
        excused: a.excused ?? false,
        late: a.late ?? false,
        missing: a.missing ?? false,
      };

      const existingId = existingAssMap.get(`${scCourseId}:${canvasAssId}`);
      if (existingId) {
        assUpdates.push({
          id: existingId,
          data: { title: a.title, dueDate, description, canvasUrl: a.htmlUrl, pointsPossible: a.pointsPossible, status, score: a.score ?? null, submittedAt: a.submittedAt ?? null, assignmentGroupId: scGroupId ?? null, ...extraFields },
        });
        updatedAssignments++;
      } else {
        assCreates.push({
          courseId: scCourseId, canvasAssignmentId: canvasAssId, title: a.title, type, dueDate, description, canvasUrl: a.htmlUrl ?? null, pointsPossible: a.pointsPossible ?? null, status, score: a.score ?? null, submittedAt: a.submittedAt ?? null, assignmentGroupId: scGroupId ?? null, ...extraFields,
        });
        newAssignments++;
      }
    }

    if (assCreates.length > 0) await db.assignment.createMany({ data: assCreates });
    await Promise.all(assUpdates.map(({ id, data }) => db.assignment.update({ where: { id }, data })));
  }

  // 7. Upsert modules as CourseTopic — bulk fetch then createMany + parallel updates
  //
  // ALL modules are imported regardless of their naming convention. Canvas module
  // data is real course data the student has access to and serves as a meaningful
  // fallback when AI syllabus extraction hasn't run yet or didn't find a schedule.
  // When AI extraction succeeds it will delete these and replace with parsed weeks.
  let newModules = 0;
  let updatedModules = 0;

  {
    const existingModDb = await db.courseTopic.findMany({
      where: { courseId: { in: allScCourseIds }, canvasModuleId: { not: null } },
      select: { id: true, courseId: true, canvasModuleId: true },
    });
    const existingModMap = new Map(
      existingModDb.map(m => [`${m.courseId}:${m.canvasModuleId}`, m.id])
    );

    type ModCreate = Prisma.CourseTopicCreateManyInput;
    type ModUpdate = { id: string; data: Prisma.CourseTopicUpdateInput };
    const modCreates: ModCreate[] = [];
    const modUpdates: ModUpdate[] = [];

    for (const mod of modules) {
      const scCourseId = courseIdMap.get(mod.courseId);
      if (!scCourseId) continue;
      const canvasModId = String(mod.moduleId);
      const existingId = existingModMap.get(`${scCourseId}:${canvasModId}`);
      if (existingId) {
        modUpdates.push({
          id: existingId,
          data: { weekNumber: mod.position, weekLabel: mod.name, topics: mod.topics, readings: mod.readings },
        });
        updatedModules++;
      } else {
        modCreates.push({ courseId: scCourseId, canvasModuleId: canvasModId, weekNumber: mod.position, weekLabel: mod.name, topics: mod.topics, readings: mod.readings });
        newModules++;
      }
    }

    if (modCreates.length > 0) await db.courseTopic.createMany({ data: modCreates });
    await Promise.all(modUpdates.map(({ id, data }) => db.courseTopic.update({ where: { id }, data })));
  }

  // 8. Upsert announcements
  let newAnnouncements = 0;

  function decodeAnnouncementBody(body: string | null): string {
    return (body ?? "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#\d+;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Bulk fetch existing announcements, then createMany + parallel updates
  {
    const validAnns = announcements.filter(ann => courseIdMap.has(ann.courseId) && !!ann.postedAt);
    const existingAnnDb = await db.announcement.findMany({
      where: { courseId: { in: allScCourseIds } },
      select: { id: true, courseId: true, canvasId: true },
    });
    const existingAnnMap = new Map(existingAnnDb.map(a => [`${a.courseId}:${a.canvasId}`, a.id]));

    type AnnCreate = Prisma.AnnouncementCreateManyInput;
    type AnnUpdate = { id: string; data: Prisma.AnnouncementUpdateInput };
    const annCreates: AnnCreate[] = [];
    const annUpdates: AnnUpdate[] = [];

    for (const ann of validAnns) {
      const scCourseId = courseIdMap.get(ann.courseId)!;
      const body = decodeAnnouncementBody(ann.body);
      const existingId = existingAnnMap.get(`${scCourseId}:${ann.canvasId}`);
      if (existingId) {
        annUpdates.push({ id: existingId, data: { title: ann.title, body, postedAt: ann.postedAt! } });
      } else {
        annCreates.push({ courseId: scCourseId, canvasId: ann.canvasId, title: ann.title, body, postedAt: ann.postedAt! });
        newAnnouncements++;
      }
    }

    if (annCreates.length > 0) await db.announcement.createMany({ data: annCreates });
    await Promise.all(annUpdates.map(({ id, data }) => db.announcement.update({ where: { id }, data })));
  }

  // 9. AI syllabus processing — run all courses in parallel for speed
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

  // ── Per-course structured debug info ──────────────────────────────────────
  // Built during processing, logged immediately per course (not batched at
  // end so a timeout can't silently kill the log), and returned in the
  // response body so the extension can persist it to chrome.storage.local.
  type CandidateDebug = { label: string; chars: number; windowChars: number; score: number };
  type AttemptDebug   = { source: string; format: string; weeksTotal: number; weeksRich: number; accepted: boolean };
  type MaterialDebug  = { fileName: string; detectedType: string; chars: number };
  type CourseDebug = {
    name: string;
    existingAiTopics: number;
    shouldRunAI: boolean;
    syllabusBody: { chars: number; score: number } | null;
    syllabusTexts: { fileName: string; chars: number; windowChars: number; score: number }[];
    candidates: CandidateDebug[];
    selectedSource: string;
    materials: MaterialDebug[];
    aiAttempts: AttemptDebug[];
    auditFired: boolean;
    auditDelta: string;
    weeksWritten: number;
    classScheduleSource: string;
    status: string;
    error?: string;
    coverageWarning?: string;
  };
  const allCourseDebug: CourseDebug[] = [];
  const scheduleRows: string[] = [];

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

      const dbg: CourseDebug = {
        name: c.name,
        existingAiTopics,
        shouldRunAI,
        syllabusBody: null,
        syllabusTexts: [],
        candidates: [],
        selectedSource: "none",
        materials: [],
        aiAttempts: [],
        auditFired: false,
        auditDelta: "",
        weeksWritten: 0,
        classScheduleSource: "",
        status: "pending",
      };

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
          const win = bestWindow(bodyText);
          const score = scheduleScore(win);
          // Score the best window — short HTML bodies are scored whole; large ones find densest slice
          candidates.push({ text: bodyText, score, label: "html-body" });
          dbg.syllabusBody = { chars: bodyText.length, score };
        }
      }

      for (const st of syllabusTexts) {
        const pdfText = st.text.trim();
        if (pdfText.length >= 100) {
          // Score using bestWindow so large PDFs with a dense schedule section aren't penalized by dilution
          const win = bestWindow(pdfText);
          const score = scheduleScore(win);
          candidates.push({ text: pdfText, score, label: st.fileName });
          dbg.syllabusTexts.push({ fileName: st.fileName, chars: pdfText.length, windowChars: win.length, score });
        } else {
          dbg.syllabusTexts.push({ fileName: st.fileName, chars: pdfText.length, windowChars: 0, score: 0 });
        }

        // Save as CourseMaterial (visible in the Materials tab)
        const existing = await db.courseMaterial.findFirst({
          where: { courseId: scCourseId, fileName: st.fileName },
          select: { id: true },
        });
        if (!existing) {
          const material = await db.courseMaterial.create({
            data: {
              courseId: scCourseId,
              fileName: st.fileName,
              detectedType: "syllabus",
              summary: "Syllabus automatically imported from Canvas.",
              relatedTopics: [],
              rawText: pdfText.slice(0, 25_000),
              storedForAI: false,
            },
          });
          syllabusFilesImported++;
          try {
            const vector = await generateEmbedding(pdfText);
            await db.$executeRaw`
              UPDATE "CourseMaterial"
              SET embedding = ${JSON.stringify(vector)}::vector
              WHERE id = ${material.id}
            `;
          } catch { /* embedding failure never blocks import */ }
        }
      }

      // ── b2) Course materials (problem sets, lecture notes, etc.) ─────────────
      // materialTexts are non-syllabus PDFs collected from all Canvas modules.
      // Run AI classification on each and upsert into CourseMaterial.
      // These are NOT used for syllabus topic extraction — only for the
      // Materials tab display and quiz generation.
      const materialTexts = c.materialTexts ?? [];
      const importedFileNames = new Set<string>();

      if (materialTexts.length > 0) {
        const courseTopicLabels = await db.courseTopic.findMany({
          where: { courseId: scCourseId },
          select: { weekLabel: true },
        });
        const topicLabels = courseTopicLabels.map((t) => t.weekLabel);

        // Check which files are already imported
        const existingMats = await db.courseMaterial.findMany({
          where: { courseId: scCourseId },
          select: { fileName: true },
        });
        const existingFileNames = new Set(existingMats.map((m) => m.fileName));

        // Mark already-imported files
        for (const mt of materialTexts) {
          if (existingFileNames.has(mt.fileName)) importedFileNames.add(mt.fileName);
        }

        // Analyze all new materials in parallel
        const newMaterials = materialTexts.filter(
          (mt) => mt.text.trim().length >= 50 && !existingFileNames.has(mt.fileName)
        );

        await Promise.all(
          newMaterials.map(async (mt) => {
            const pdfText = mt.text.trim();
            try {
              const analysis = await analyzeCourseMaterial(pdfText, topicLabels);
              const storedForAI = ["lecture_notes", "lecture_slides", "textbook"].includes(analysis.detectedType);
              const material = await db.courseMaterial.create({
                data: {
                  courseId: scCourseId,
                  fileName: mt.fileName,
                  detectedType: analysis.detectedType,
                  summary: analysis.summary,
                  relatedTopics: analysis.relatedTopics,
                  rawText: pdfText.slice(0, 25_000),
                  storedForAI,
                },
              });
              importedFileNames.add(mt.fileName);
              try {
                const vector = await generateEmbedding(pdfText);
                await db.$executeRaw`
                  UPDATE "CourseMaterial"
                  SET embedding = ${JSON.stringify(vector)}::vector
                  WHERE id = ${material.id}
                `;
              } catch { /* embedding failure never blocks import */ }
              dbg.materials.push({ fileName: mt.fileName, detectedType: analysis.detectedType, chars: pdfText.length });
            } catch {
              // Don't fail the whole import if one material analysis errors
              dbg.materials.push({ fileName: mt.fileName, detectedType: "error", chars: pdfText.length });
            }
          })
        );
      }

      // ── b3) Material candidates — upsert all, then prune imported ones ────
      // Candidates are all PDF metadata from non-orientation modules. They let
      // students see and request files without downloading everything up front.
      const materialCandidates = c.materialCandidates ?? [];
      if (materialCandidates.length > 0) {
        for (const candidate of materialCandidates) {
          await db.canvasMaterialCandidate.upsert({
            where: { courseId_contentId: { courseId: scCourseId, contentId: candidate.contentId } },
            update: { fileName: candidate.fileName, moduleName: candidate.moduleName },
            create: {
              courseId: scCourseId,
              fileName: candidate.fileName,
              moduleName: candidate.moduleName,
              contentId: candidate.contentId,
              requested: false,
            },
          });
        }

        // Remove candidates that were just imported as full CourseMaterial records
        if (importedFileNames.size > 0) {
          await db.canvasMaterialCandidate.deleteMany({
            where: {
              courseId: scCourseId,
              fileName: { in: Array.from(importedFileNames) },
            },
          });
        }
      }

      // Pick highest-scoring candidate; fall back to longest if all score 0
      candidates.sort((a, b) => b.score !== a.score ? b.score - a.score : b.text.length - a.text.length);
      const best = candidates[0];
      const syllabusText = best?.text ?? "";
      const bestLabel = best ? `${best.label}(score=${best.score.toFixed(3)},${best.text.length}c)` : "none";

      // Full candidate list for diagnostics (all sources, not just the winner)
      const candidatesSummary = candidates.length === 0
        ? "none"
        : candidates.map((cd) => `${cd.label}(${cd.score.toFixed(2)},${cd.text.length}c)`).join(" | ");

      // Record ranked candidates in debug info
      dbg.candidates = candidates.map(cd => ({
        label: cd.label,
        chars: cd.text.length,
        windowChars: bestWindow(cd.text).length,
        score: cd.score,
      }));
      dbg.selectedSource = bestLabel;

      // ── d-pre) Syllabus drop rule extraction ──────────────────────────────
      // Only runs if at least one group still has syllabusDropLowest/Highest = 0.
      // Skipped on subsequent syncs once rules are detected — avoids redundant AI calls.
      if (syllabusText.length >= 200) {
        try {
          const groups = await db.assignmentGroup.findMany({
            where: { courseId: scCourseId },
            select: { id: true, name: true, dropLowest: true, dropHighest: true, syllabusDropLowest: true, syllabusDropHighest: true },
          });
          const needsDropRules = groups.some(
            (g) => g.syllabusDropLowest === 0 && g.syllabusDropHighest === 0
          );
          const dropRules = needsDropRules ? await extractDropRules(syllabusText) : [];
          if (dropRules.length > 0) {
            const norm = (s: string) => s.toLowerCase().replace(/s+$/, "").trim();
            for (const rule of dropRules) {
              const match = groups.find(
                (g) =>
                  norm(g.name).includes(norm(rule.groupName)) ||
                  norm(rule.groupName).includes(norm(g.name))
              );
              if (!match) continue;
              const data: { syllabusDropLowest?: number; syllabusDropHighest?: number } = {};
              if (rule.dropLowest > 0 && match.dropLowest === 0) data.syllabusDropLowest = rule.dropLowest;
              if (rule.dropHighest > 0 && match.dropHighest === 0) data.syllabusDropHighest = rule.dropHighest;
              if (Object.keys(data).length > 0) {
                await db.assignmentGroup.update({ where: { id: match.id }, data });
              }
            }
          }
        } catch {
          // Don't fail the whole import on this optional enrichment
        }
      }

      // ── d-pre2) Class schedule extraction ──────────────────────────────────
      // Extracts recurring meeting patterns (days, times, room) so students
      // can add class times to Google Calendar with one click.
      // Only runs if the course doesn't already have a classSchedule stored.
      // Source priority:
      //   1. Syllabus text (AI extraction) — most descriptive, has room info
      //   2. Canvas calendar events (deterministic) — reliable fallback when
      //      the syllabus doesn't mention meeting times
      try {
        let classSchedule = null;
        let classScheduleSource = "none";
        const debugClassScheduleCourse = /anthropology/i.test(c.name);

        // Source 1: best-scoring syllabus text (from topic extraction pipeline)
        if (syllabusText.length >= 200) {
          if (debugClassScheduleCourse) {
            console.log(`[sync-debug] ${c.name}: classSchedule source1 probe`, classScheduleProbe(syllabusText));
          }
          classSchedule = await extractClassSchedule(syllabusText);
          if (classSchedule) classScheduleSource = "syllabus-ai";
        }

        // Source 1b: raw syllabusBody HTML — handles courses where the meeting
        // times are in a short Canvas Page/syllabus tab that doesn't score well
        // in the topic pipeline (e.g. just "Meeting Times: MWF 1-1:50PM")
        if (!classSchedule && c.syllabusBody) {
          const rawBodyText = htmlToText(c.syllabusBody);
          if (debugClassScheduleCourse) {
            console.log(`[sync-debug] ${c.name}: classSchedule source1b probe`, classScheduleProbe(rawBodyText));
          }
          if (rawBodyText.length >= 50 && rawBodyText !== syllabusText) {
            console.log(`[sync] ${c.name}: trying Source 1b (syllabusBody raw, ${rawBodyText.length}c)`);
            classSchedule = await extractClassSchedule(rawBodyText);
            if (classSchedule) classScheduleSource = "syllabus-body-raw";
          }
        }

        // Source 2: Canvas calendar events (deterministic fallback)
        if (!classSchedule && c.calendarEvents && c.calendarEvents.length > 0) {
          classSchedule = extractScheduleFromCalendarEvents(
            c.calendarEvents,
            c.termStartAt,
            c.termEndAt,
          );
          if (classSchedule) classScheduleSource = `calEvents(${c.calendarEvents.length})`;
        }

        dbg.classScheduleSource = classScheduleSource + (classSchedule ? `(${classSchedule.meetings.length} meetings)` : "");
        scheduleRows.push(
          `${c.name}: ${classScheduleSource}` +
          (classSchedule ? ` → ${classSchedule.meetings.length} meeting(s)` : "")
        );

        if (classSchedule) {
          await db.course.update({
            where: { id: scCourseId },
            data: { classSchedule: classSchedule as object },
          });
        }
      } catch {
        // Don't fail the whole import on this optional enrichment
      }

      // ── d-pre3) Extract dated events for cross-source reconciliation ────────
      // Runs parseSyllabusText to find exam/assignment dates in the syllabus.
      // Stored on the Course so gradescope/import can fill in dates on assignments
      // that Gradescope doesn't date (e.g. exams).
      if (syllabusText.length >= 500) {
        try {
          const existingSyllabusEvents = await db.course.findUnique({
            where: { id: scCourseId },
            select: { syllabusEvents: true },
          });
          if (!existingSyllabusEvents?.syllabusEvents) {
            const events = await parseSyllabusText(syllabusText);
            if (events.length > 0) {
              const storable = events.map((e) => ({
                title: e.title,
                dueDate: e.dueDate,
                type: e.type,
              }));
              await db.course.update({
                where: { id: scCourseId },
                data: { syllabusEvents: storable as object[] },
              });
              console.log(`[sync] ${c.name}: extracted ${storable.length} syllabus events`);
            }
          }
        } catch {
          // Non-fatal — dates from syllabus are a bonus
        }
      }

      // ── d) AI topic extraction ─────────────────────────────────────────────
      const aiStatus = !shouldRunAI ? `skip:has-ai-topics(${existingAiTopics})`
        : syllabusText.length < 500 ? `skip:too-short(${syllabusText.length}c)`
        : `run(${syllabusText.length}c)`;

      if (!shouldRunAI || syllabusText.length < 500) {
        dbg.status = aiStatus;
        allCourseDebug.push(dbg);
        console.log(`[sync] ${c.name}: ${aiStatus} | sources: ${candidatesSummary}`);
        return;
      }

      try {
        // Build a format hint for the AI based on the winning source
        const bestFormat = detectSourceFormat(syllabusText);

        // ── Role 3: Extractor (merge-all-sources) ──────────────────────
        // Try every candidate source and merge results by week number.
        // Each source may cover different parts of the semester; merging
        // ensures we don't lose weeks that only appear in one source.
        const allGoodResults: { result: ReturnType<typeof sanitizeSchedule>; label: string; fmt: string; win: string }[] = [];
        let usedLabel = bestLabel;
        let usedFormat = bestFormat;
        let usedWindow = bestWindow(best?.text ?? "");

        for (let ci = 0; ci < candidates.length; ci++) {
          const src    = candidates[ci];
          const win    = bestWindow(src.text);
          const fmt    = detectSourceFormat(src.text);
          const hint   = `${src.label}, format: ${fmt}`;
          const raw    = await parseSyllabusTopics(win, hint);
          const result = sanitizeSchedule(raw).filter(isContentfulTopic);

          const richWeeks = result.filter(
            (t) => (t.topics ?? []).length > 0 || (t.readings ?? []).length > 0
          ).length;
          const isGoodResult = result.length > 0 && (result.length < 4 || richWeeks / result.length >= 0.4);

          dbg.aiAttempts.push({
            source: src.label,
            format: fmt,
            weeksTotal: result.length,
            weeksRich: richWeeks,
            accepted: isGoodResult,
          });
          console.log(`[sync] ${c.name} attempt[${ci}] ${src.label} fmt=${fmt}: ${result.length} weeks, ${richWeeks} rich → ${isGoodResult ? "ACCEPTED" : "rejected"}`);

          if (isGoodResult) {
            allGoodResults.push({ result, label: src.label, fmt, win });
          }
        }

        if (allGoodResults.length === 0) {
          dbg.status = `ai-0-weeks(${candidates.length} sources tried)`;
          allCourseDebug.push(dbg);
          console.log(`[sync] ${c.name}: 0 contentful weeks from all ${candidates.length} source(s) | ${candidatesSummary}`);
          return;
        }

        // Merge: start with the highest-coverage source, fill gaps from others
        allGoodResults.sort((a, b) => b.result.length - a.result.length);
        const merged = new Map<number, ReturnType<typeof sanitizeSchedule>[number]>();
        const sourceLabels: string[] = [];
        for (const { result, label, fmt, win } of allGoodResults) {
          let contributed = false;
          for (const week of result) {
            const existing = merged.get(week.weekNumber);
            if (!existing) {
              merged.set(week.weekNumber, week);
              contributed = true;
            } else {
              // Merge richer content into existing week
              const existingRich = (existing.topics?.length ?? 0) + (existing.readings?.length ?? 0);
              const newRich = (week.topics?.length ?? 0) + (week.readings?.length ?? 0);
              if (newRich > existingRich) {
                merged.set(week.weekNumber, { ...week, startDate: existing.startDate ?? week.startDate });
                contributed = true;
              } else if (!existing.startDate && week.startDate) {
                existing.startDate = week.startDate;
                contributed = true;
              }
            }
          }
          if (contributed) sourceLabels.push(label);
          if (sourceLabels.length === 1) { usedFormat = fmt; usedWindow = win; }
        }

        let topics = [...merged.values()].sort((a, b) => a.weekNumber - b.weekNumber);
        usedLabel = sourceLabels.length > 1
          ? `merged(${sourceLabels.join("+")})`
          : sourceLabels[0] ?? bestLabel;
        console.log(`[sync] ${c.name}: merged ${allGoodResults.length} source(s) → ${topics.length} weeks from [${sourceLabels.join(", ")}]`);

        // ── Role 5: Auditor ───────────────────────────────────────────────
        // Second AI pass — only fires when the result looks partial or messy.
        // Corrects week labels, removes hallucinated topics, fixes date order.
        // Passes the same bestWindow the extractor used — critical for calendar grid
        // PDFs where the calendar is in the middle/end, not the first 6k chars.
        const preAuditCount = topics.length;
        const auditFired = needsAudit(topics);
        dbg.auditFired = auditFired;
        if (auditFired) {
          const audited = await auditSchedule(topics, usedWindow);
          if (audited.length > 0) {
            topics    = audited;
            usedLabel = usedLabel + `+audited(${preAuditCount}→${audited.length})`;
            dbg.auditDelta = `${preAuditCount}→${audited.length}`;
          } else {
            dbg.auditDelta = `${preAuditCount}→unchanged(audit returned 0)`;
          }
        }

        // Renumber only after cross-source merge/audit so partial sources don't
        // collide (e.g. a source that only covers weeks 9-14 should not be
        // renumbered to 1-6 before merging).
        topics = renumberSequentialWeeks(topics);

        // Fetch existing module-based topics to preserve those covering
        // weeks that no AI source extracted (merge, not replace).
        const existingModuleTopics = await db.courseTopic.findMany({
          where: { courseId: scCourseId, canvasModuleId: { not: null } },
          select: { id: true, weekNumber: true, weekLabel: true },
        });

        const aiWeekNumbers = new Set(topics.map((t) =>
          Number.isInteger(t.weekNumber) ? t.weekNumber : (parseInt(String(t.weekNumber), 10) || 0)
        ));

        // Suppress module carryover when AI coverage is already strong and the
        // module labels look like non-weekly buckets (Unit/Orientation/Exam/etc).
        const termWeeks = c.termStartAt && c.termEndAt
          ? Math.max(
              0,
              Math.round(
                (new Date(c.termEndAt).getTime() - new Date(c.termStartAt).getTime()) / (7 * 86400_000)
              )
            )
          : null;
        const aiDatedWeeks = topics.filter((t) => typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate)).length;
        let aiDatesLookWeekly = false;
        if (aiDatedWeeks >= 6) {
          const dated = topics
            .filter((t) => typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate))
            .map((t) => new Date(`${t.startDate}T00:00:00Z`).getTime())
            .sort((a, b) => a - b);
          let weeklyishGaps = 0;
          for (let i = 1; i < dated.length; i++) {
            const days = Math.round((dated[i] - dated[i - 1]) / 86400_000);
            if (days >= 5 && days <= 10) weeklyishGaps++;
          }
          aiDatesLookWeekly = weeklyishGaps >= Math.max(4, dated.length - 2);
        }
        const strongAiCoverage = (termWeeks && termWeeks > 0
          ? topics.length >= Math.max(8, Math.round(termWeeks * 0.6))
          : topics.length >= 10)
          || (topics.length >= 8 && aiDatedWeeks >= 6 && aiDatesLookWeekly);
        const nonWeeklyModuleRx = /\b(unit|orientation|welcome|exam|quiz|aktiv|discussion module|module)\b/i;
        const nonWeeklyModuleCount = existingModuleTopics.filter((mt) => nonWeeklyModuleRx.test(mt.weekLabel)).length;
        const nonWeeklyModuleRatio = existingModuleTopics.length > 0
          ? nonWeeklyModuleCount / existingModuleTopics.length
          : 0;
        const suppressModuleCarryover = strongAiCoverage && nonWeeklyModuleRatio >= 0.4;

        if (existingModuleTopics.length > 0 || topics.length > 0) {
          console.log(
            `[sync-debug] ${c.name}: module-carryover decision ` +
            JSON.stringify({
              aiWeeks: topics.length,
              aiDatedWeeks,
              aiDatesLookWeekly,
              termWeeks,
              strongAiCoverage,
              moduleTopics: existingModuleTopics.length,
              nonWeeklyModuleCount,
              nonWeeklyModuleRatio: Number(nonWeeklyModuleRatio.toFixed(2)),
              suppressModuleCarryover,
            })
          );
        }

        // Delete module topics either:
        // 1) all of them when they are likely non-weekly scaffolding and AI is good, or
        // 2) only the overlapping week numbers when module carryover is still useful.
        const moduleIdsToDelete = suppressModuleCarryover
          ? existingModuleTopics.map((mt) => mt.id)
          : existingModuleTopics
              .filter((mt) => aiWeekNumbers.has(mt.weekNumber))
              .map((mt) => mt.id);

        if (moduleIdsToDelete.length > 0) {
          await db.courseTopic.deleteMany({
            where: { id: { in: moduleIdsToDelete } },
          });
        }

        // Also delete any prior AI-sourced topics so we don't create duplicates
        await db.courseTopic.deleteMany({
          where: { courseId: scCourseId, canvasModuleId: null },
        });

        await db.courseTopic.createMany({
          data: topics.map((t, i) => ({
            courseId: scCourseId,
            weekNumber: Number.isInteger(t.weekNumber) ? t.weekNumber : (parseInt(String(t.weekNumber), 10) || i + 1),
            weekLabel: typeof t.weekLabel === "string" && t.weekLabel.trim() ? t.weekLabel.trim() : `Week ${i + 1}`,
            startDate: typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate) ? t.startDate : null,
            topics: Array.isArray(t.topics) ? t.topics.filter((x: unknown) => typeof x === "string") : [],
            readings: Array.isArray(t.readings) ? t.readings.filter((x: unknown) => typeof x === "string") : [],
            notes: typeof t.notes === "string" ? t.notes : null,
            canvasModuleId: null,
          })),
        });

        aiTopicsCreated += topics.length;
        dbg.weeksWritten = topics.length;
        dbg.status = "ok";

        // Coverage warning: flag if week count seems low for a standard term
        const keptModuleWeeks = existingModuleTopics.length - moduleIdsToDelete.length;
        const totalWeeks = topics.length + keptModuleWeeks;
        if (totalWeeks > 0 && totalWeeks < 10 && c.termEndAt && c.termStartAt) {
          const termWeeks = Math.round(
            (new Date(c.termEndAt).getTime() - new Date(c.termStartAt).getTime()) / (7 * 86400_000)
          );
          if (termWeeks >= 14 && totalWeeks < termWeeks * 0.6) {
            dbg.coverageWarning = `${totalWeeks} weeks extracted for a ${termWeeks}-week term`;
            console.warn(`[sync] ${c.name}: LOW COVERAGE — ${totalWeeks} weeks for ${termWeeks}-week term`);
          }
        }

        allCourseDebug.push(dbg);
        console.log(
          `[sync] ${c.name}: OK ${topics.length} weeks written` +
          (keptModuleWeeks > 0 ? ` + ${keptModuleWeeks} module weeks kept` : "") +
          (suppressModuleCarryover ? ` modules-suppressed(nonweekly=${nonWeeklyModuleCount}/${existingModuleTopics.length})` : "") +
          ` | src=${usedLabel} fmt=${usedFormat}` +
          (auditFired ? ` audit(${dbg.auditDelta})` : ` audit-skipped`)
        );
      } catch (err) {
        dbg.status = "error";
        dbg.error = String(err);
        allCourseDebug.push(dbg);
        console.error(`[sync] ${c.name}: ERROR ${err} | sources: ${candidatesSummary}`);
      }
    })
  );

  if (scheduleRows.length > 0) {
    console.log("[sync] classSchedule:\n" + scheduleRows.join("\n"));
  }

  // 10. Auto-generate tasks from assignments
  const tasksCreated = await generateTasksForUser(user.id);

  const summary = {
    courses: { new: newCourses, updated: updatedCourses },
    assignments: { new: newAssignments, updated: updatedAssignments },
    assignmentGroups: { new: newGroups, updated: updatedGroups },
    modules: { new: newModules, updated: updatedModules },
    announcements: { new: newAnnouncements },
    tasks: { autoGenerated: tasksCreated },
    syllabus: { aiWeeks: aiTopicsCreated, filesImported: syllabusFilesImported },
  };

  return log.respond(
    NextResponse.json({
      ok: true,
      summary,
      debug: {
        syncedAt: new Date().toISOString(),
        courses: allCourseDebug,
      },
    }),
    summary,
  );
}
