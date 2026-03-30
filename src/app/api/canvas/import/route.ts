import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  extractDropRules,
  extractClassSchedule,
  extractScheduleFromCalendarEvents,
  parseSyllabusText,
  scheduleScore,
  bestWindow,
  detectSourceFormat,
  type ParsedTopic,
  type ExtractedClassSchedule,
} from "@/lib/parse-syllabus";
import { runTopicPipeline, type PipelineInput, type PipelineResult } from "@/lib/topic-pipeline";
import { runTopicPipelineV2, runCrossCourseConsistencyCheck, reReconcileWithInstitutionalContext, type V2PipelineResult } from "@/lib/reconciliation/pipeline-v2";
import { buildInstitutionalContext } from "@/lib/reconciliation/cross-course-pass";
import type { ReconciliationResult } from "@/lib/reconciliation/types";
import crypto from "crypto";
import { addDays, addYears, parseISO, subDays } from "date-fns";
import { generateTasksForUser } from "@/lib/tasks";
import { analyzeCourseMaterial, inferMaterialSourceRole } from "@/lib/analyze-material";
import { generateEmbedding } from "@/lib/embeddings";

export const maxDuration = 300; // allow up to 5 min for parallel AI syllabus parsing

// ─── CORS (Chrome extension sends cross-origin requests) ─────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function withCors<T extends Response>(res: T): T {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

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
  /** Canvas assignment availability window */
  availableFrom?: string | null; // unlock_at
  availableUntil?: string | null; // lock_at
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

/** Preserve Canvas due datetime (ISO string) when present. */
function normalizeDueDate(iso: string | null): string | null {
  if (!iso) return null;
  return iso;
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

function hasOverlappingDateRanges(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function isoDateOnly(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

function shiftDateIntoTerm(dateStr: string | null, termStart: string | null, termEnd: string | null): string | null {
  if (!dateStr) return null;
  const parsed = parseISO(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateStr;

  const termStartDate = termStart ? parseISO(`${termStart}T12:00:00Z`) : null;
  const termEndDate = termEnd ? parseISO(`${termEnd}T12:00:00Z`) : termStartDate;
  if (!termStartDate || Number.isNaN(termStartDate.getTime()) || !termEndDate || Number.isNaN(termEndDate.getTime())) {
    return dateStr;
  }

  const paddedStart = subDays(termStartDate, 21);
  const paddedEnd = addDays(termEndDate, 21);
  if (parsed >= paddedStart && parsed <= paddedEnd) {
    return dateStr;
  }

  let best = dateStr;
  let bestInRange = false;

  for (let shift = -3; shift <= 3; shift++) {
    const shifted = addYears(parsed, shift);
    const shiftedStr = shifted.toISOString().slice(0, 10);
    const inRange = shifted >= paddedStart && shifted <= paddedEnd;
    if (inRange) {
      best = shiftedStr;
      bestInRange = true;
      break;
    }
  }

  return bestInRange ? best : dateStr;
}

function hasUsefulMeetingTimes(schedule: ExtractedClassSchedule | null): boolean {
  if (!schedule) return false;
  return schedule.meetings.some(
    (meeting) =>
      Boolean(meeting.startTime) &&
      Boolean(meeting.endTime) &&
      !(meeting.startTime === "00:00" && meeting.endTime === "00:00"),
  );
}

function normalizeScheduleForTerm(
  schedule: ExtractedClassSchedule | null,
  termStartAt?: string | null,
  termEndAt?: string | null,
): ExtractedClassSchedule | null {
  if (!schedule) return null;

  const termStart = isoDateOnly(termStartAt);
  const termEnd = isoDateOnly(termEndAt);

  return {
    ...schedule,
    semesterStart: termStart ?? shiftDateIntoTerm(schedule.semesterStart, termStart, termEnd),
    semesterEnd: termEnd ?? shiftDateIntoTerm(schedule.semesterEnd, termStart, termEnd),
    finalExamDate: shiftDateIntoTerm(schedule.finalExamDate, termStart, termEnd),
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
  if (!user) return withCors(NextResponse.json({ error: "Invalid or missing token" }, { status: 401 }));

  const log = apiLogger("GET /api/canvas/import", user.id);

  const [courses, assignments, topics] = await Promise.all([
    db.course.count({ where: { userId: user.id } }),
    db.assignment.count({ where: { course: { userId: user.id } } }),
    db.courseTopic.count({ where: { course: { userId: user.id } } }),
  ]);

  return withCors(log.respond(NextResponse.json({ courses, assignments, topics }), { courses, assignments, topics }));
}

// ─── POST — full Canvas sync ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Authenticate via Bearer token
  const user = await authedUser(request);
  if (!user) return withCors(NextResponse.json({ error: "Invalid or missing token" }, { status: 401 }));

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
      const dueDate = normalizeDueDate(a.dueDate);
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
        availableFrom: a.availableFrom ?? null,
        availableUntil: a.availableUntil ?? null,
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

  // 9. Auto-generate tasks from assignments (fast — runs before response)
  const tasksCreated = await generateTasksForUser(user.id);

  // Return the response immediately so the extension can proceed to Gradescope.
  // AI syllabus processing runs in the background via after().
  const summary = {
    courses: { new: newCourses, updated: updatedCourses },
    assignments: { new: newAssignments, updated: updatedAssignments },
    assignmentGroups: { new: newGroups, updated: updatedGroups },
    modules: { new: newModules, updated: updatedModules },
    announcements: { new: newAnnouncements },
    tasks: { autoGenerated: tasksCreated },
    syllabus: { aiWeeks: 0, filesImported: 0, background: true },
  };

  // Schedule AI syllabus processing to run after the response is sent.
  // This avoids the Vercel function timeout killing the response before
  // the extension receives it.
  after(async () => {
    const bgLog = apiLogger("POST /api/canvas/import [after]", user.id);
    bgLog.info("background AI processing started", { courses: courses.length });
    await db.user.update({ where: { id: user.id }, data: { bgSyncProcessingAt: new Date() } });

  try {
  // AI syllabus processing — run all courses in parallel for speed
  //    For each course that provided syllabus content:
  //      a) Build best available syllabus text from HTML body + pre-extracted PDF texts
  //      b) Save PDF-sourced materials as CourseMaterial records
  //      c) Run parseSyllabusTopics() if we have substantial text
  //      d) If AI returns a schedule, replace module-based topics with it
  //
  //    Skip courses that already have AI-parsed topics (canvasModuleId = null)
  //    so subsequent syncs are fast and don't overwrite user-annotated progress.

  let aiTopicsCreated = 0;
  let syllabusFilesImported = 0;

  // ── Per-course structured debug info ──────────────────────────────────────
  // Built during processing, logged immediately per course (not batched at
  // end so a timeout can't silently kill the log), and returned in the
  // response body so the extension can persist it to chrome.storage.local.
  type CandidateDebug = { label: string; chars: number; windowChars: number; score: number };
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
    weeksWritten: number;
    classScheduleSource: string;
    status: string;
    error?: string;
  };
  const allCourseDebug: CourseDebug[] = [];
  const scheduleRows: string[] = [];

  // V2 pipeline: collect reconciliation results for cross-course pass
  const useV2 = true;
  const v2CourseResults: {
    courseId: string;
    courseName: string;
    result: ReconciliationResult;
    pipelineInput: PipelineInput;
    announcements?: { title: string; body: string; postedAt: string }[];
    calendarEvents?: { title: string; startAt: string; endAt: string }[];
  }[] = [];

  await Promise.all(
    courses.map(async (c) => {
      try {
      const scCourseId = courseIdMap.get(c.id);
      if (!scCourseId) return;

      // ── a) Check whether AI topics already exist ─────────────────────────
      const existingAiTopics = await db.courseTopic.count({
        where: { courseId: scCourseId, canvasModuleId: null },
      });
      const existingAiTopicRange = existingAiTopics > 0
        ? await db.courseTopic.aggregate({
            where: {
              courseId: scCourseId,
              canvasModuleId: null,
              startDate: { not: null },
            },
            _min: { startDate: true },
            _max: { startDate: true },
          })
        : null;

      let staleAiTimeline = false;
      if (
        existingAiTopicRange?._min.startDate &&
        existingAiTopicRange?._max.startDate &&
        c.termStartAt
      ) {
        const termStart = c.termStartAt.split("T")[0];
        const termEnd = c.termEndAt
          ? c.termEndAt.split("T")[0]
          : addDays(new Date(`${termStart}T12:00:00Z`), 140).toISOString().slice(0, 10);
        const paddedStart = subDays(new Date(`${termStart}T12:00:00Z`), 42).toISOString().slice(0, 10);
        const paddedEnd = addDays(new Date(`${termEnd}T12:00:00Z`), 42).toISOString().slice(0, 10);
        staleAiTimeline = !hasOverlappingDateRanges(
          existingAiTopicRange._min.startDate,
          existingAiTopicRange._max.startDate,
          paddedStart,
          paddedEnd,
        );
      }

      // If we already parsed this course's syllabus, don't overwrite unless the
      // stored AI timeline is clearly from a different term and therefore stale.
      const shouldRunAI = existingAiTopics === 0 || staleAiTimeline;

      const dbg: CourseDebug = {
        name: c.name,
        existingAiTopics,
        shouldRunAI,
        syllabusBody: null,
        syllabusTexts: [],
        candidates: [],
        selectedSource: "none",
        materials: [],
        weeksWritten: 0,
        classScheduleSource: "",
        status: staleAiTimeline ? "pending:stale-ai-timeline" : "pending",
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
        try {
          const existing = await db.courseMaterial.findFirst({
            where: { courseId: scCourseId, fileName: st.fileName },
            select: { id: true },
          });
          const storedText = pdfText.slice(0, 60_000); // Syllabi need more — course outlines are often on the last pages
          if (!existing) {
            const material = await db.courseMaterial.create({
              data: {
                courseId: scCourseId,
                fileName: st.fileName,
                detectedType: "syllabus",
                sourceRole: "mixed",
                summary: "Syllabus automatically imported from Canvas.",
                relatedTopics: [],
                rawText: storedText,
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
          } else {
            // Update stored text if we have a longer version (previous truncation may have lost data)
            await db.courseMaterial.update({
              where: { id: existing.id },
              data: { rawText: storedText },
            });
          }
        } catch (matErr) {
          console.error(`[sync] ${c.name}: material save failed for ${st.fileName}:`, matErr);
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
                  sourceRole: inferMaterialSourceRole(analysis.detectedType, mt.fileName),
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
        try {
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
        } catch (candErr) {
          console.error(`[sync] ${c.name}: candidate upsert failed:`, candErr);
        }
      }

      // Fallback: if client didn't send syllabus text, try stored CourseMaterial
      if (candidates.length === 0) {
        try {
          const storedSyllabus = await db.courseMaterial.findMany({
            where: { courseId: scCourseId, detectedType: "syllabus" },
            select: { fileName: true, rawText: true },
          });
          for (const stored of storedSyllabus) {
            if (stored.rawText && stored.rawText.length >= 100) {
              const win = bestWindow(stored.rawText);
              const score = scheduleScore(win);
              candidates.push({ text: stored.rawText, score, label: `stored:${stored.fileName}` });
              console.log(`[sync] ${c.name}: using stored syllabus text "${stored.fileName}" (${stored.rawText.length}c, score=${score.toFixed(3)})`);
            }
          }
        } catch { /* non-fatal */ }
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
        let syllabusClassSchedule: ExtractedClassSchedule | null = null;
        let calendarClassSchedule: ExtractedClassSchedule | null = null;
        const debugClassScheduleCourse = /anthropology/i.test(c.name);

        // Source 1: best-scoring syllabus text (from topic extraction pipeline)
        if (syllabusText.length >= 200) {
          if (debugClassScheduleCourse) {
            console.log(`[sync-debug] ${c.name}: classSchedule source1 probe`, classScheduleProbe(syllabusText));
          }
          syllabusClassSchedule = await extractClassSchedule(syllabusText);
          if (syllabusClassSchedule) classScheduleSource = "syllabus-ai";
        }

        // Source 1b: raw syllabusBody HTML — handles courses where the meeting
        // times are in a short Canvas Page/syllabus tab that doesn't score well
        // in the topic pipeline (e.g. just "Meeting Times: MWF 1-1:50PM")
        if (!syllabusClassSchedule && c.syllabusBody) {
          const rawBodyText = htmlToText(c.syllabusBody);
          if (debugClassScheduleCourse) {
            console.log(`[sync-debug] ${c.name}: classSchedule source1b probe`, classScheduleProbe(rawBodyText));
          }
          if (rawBodyText.length >= 50 && rawBodyText !== syllabusText) {
            console.log(`[sync] ${c.name}: trying Source 1b (syllabusBody raw, ${rawBodyText.length}c)`);
            syllabusClassSchedule = await extractClassSchedule(rawBodyText);
            if (syllabusClassSchedule) classScheduleSource = "syllabus-body-raw";
          }
        }

        // Source 2: Canvas calendar events (deterministic fallback)
        if (c.calendarEvents && c.calendarEvents.length > 0) {
          calendarClassSchedule = extractScheduleFromCalendarEvents(
            c.calendarEvents,
            c.termStartAt,
            c.termEndAt,
          );
          if (!syllabusClassSchedule && calendarClassSchedule) {
            classScheduleSource = `calEvents(${c.calendarEvents.length})`;
          }
        }

        const normalizedSyllabusSchedule = normalizeScheduleForTerm(
          syllabusClassSchedule,
          c.termStartAt,
          c.termEndAt,
        );
        const normalizedCalendarSchedule = normalizeScheduleForTerm(
          calendarClassSchedule,
          c.termStartAt,
          c.termEndAt,
        );

        if (normalizedSyllabusSchedule && hasUsefulMeetingTimes(normalizedSyllabusSchedule)) {
          classSchedule = normalizedSyllabusSchedule;
        } else if (normalizedCalendarSchedule) {
          classSchedule = normalizedCalendarSchedule;
          classScheduleSource = `calEvents(${c.calendarEvents?.length ?? 0})`;
          if (normalizedSyllabusSchedule?.finalExamDate && !classSchedule.finalExamDate) {
            classSchedule.finalExamDate = normalizedSyllabusSchedule.finalExamDate;
            classScheduleSource += "+syllabus-final";
          }
        } else if (normalizedSyllabusSchedule) {
          classSchedule = normalizedSyllabusSchedule;
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
      // Count existing module topics to decide if pipeline should run for module cleanup
      const existingModuleCount = await db.courseTopic.count({
        where: { courseId: scCourseId, canvasModuleId: { not: null } },
      });
      const hasModulesToProcess = existingModuleCount > 0;

      const aiStatus = !shouldRunAI ? `skip:has-ai-topics(${existingAiTopics})`
        : syllabusText.length < 500 && !hasModulesToProcess ? `skip:too-short(${syllabusText.length}c)`
        : `run(${syllabusText.length}c${hasModulesToProcess ? ',modules=' + existingModuleCount : ''})`;

      if (!shouldRunAI || (syllabusText.length < 500 && !hasModulesToProcess)) {
        dbg.status = aiStatus;
        allCourseDebug.push(dbg);
        console.log(`[sync] ${c.name}: ${aiStatus} | sources: ${candidatesSummary}`);
        return;
      }

      try {
        // ── Topic Pipeline: classify modules, extract topics, fuse timeline ──

        // Fetch existing module-based topics
        const existingModuleTopics = await db.courseTopic.findMany({
          where: { courseId: scCourseId, canvasModuleId: { not: null } },
          select: { id: true, weekNumber: true, weekLabel: true, topics: true, readings: true, canvasModuleId: true },
        });

        // Fetch class schedule (already stored earlier in this after() block)
        const courseRecord = await db.course.findUnique({
          where: { id: scCourseId },
          select: { classSchedule: true, syllabusEvents: true },
        });

        // Fetch assignment due dates for date anchoring
        const courseAssignments = await db.assignment.findMany({
          where: { courseId: scCourseId, dueDate: { not: null } },
          select: { title: true, dueDate: true },
          orderBy: { dueDate: "asc" },
        });

        const pipelineInput: PipelineInput = {
          courseId: scCourseId,
          courseName: c.name,
          candidates: candidates.map((src) => ({ text: src.text, score: src.score, label: src.label })),
          modules: existingModuleTopics.map((mt) => ({
            id: mt.id,
            canvasModuleId: mt.canvasModuleId!,
            weekNumber: mt.weekNumber,
            weekLabel: mt.weekLabel,
            topics: mt.topics,
            readings: mt.readings,
          })),
          classSchedule: (courseRecord?.classSchedule as PipelineInput["classSchedule"]) ?? null,
          termStartDate: c.termStartAt ? c.termStartAt.split("T")[0] : null,
          termEndDate: c.termEndAt
            ? c.termEndAt.split("T")[0]
            : (courseRecord?.classSchedule as { finalExamDate?: string | null })?.finalExamDate ?? null,
          assignments: courseAssignments.map((a) => ({
            title: a.title,
            dueDate: a.dueDate,
          })),
          syllabusEvents: Array.isArray(courseRecord?.syllabusEvents)
            ? (courseRecord.syllabusEvents as { title?: string; dueDate?: string; type?: string }[])
                .filter(
                  (event): event is { title: string; dueDate: string; type: string } =>
                    typeof event?.title === "string" &&
                    typeof event?.dueDate === "string" &&
                    typeof event?.type === "string",
                )
                .map((event) => ({
                  title: event.title,
                  dueDate: event.dueDate,
                  type: event.type,
                }))
            : [],
        };

        // Fetch announcements for V2 evidence bundle
        const courseAnnouncements = useV2
          ? await db.announcement.findMany({
              where: { courseId: scCourseId },
              select: { title: true, body: true, postedAt: true },
              orderBy: { postedAt: "desc" },
              take: 20,
            })
          : [];

        let pipelineResult: PipelineResult;
        if (useV2) {
          const v2Result = await runTopicPipelineV2(pipelineInput, {
            announcements: courseAnnouncements.map((a) => ({
              title: a.title,
              body: a.body ?? "",
              postedAt: a.postedAt ?? "",
            })),
            calendarEvents: c.calendarEvents?.map((e) => ({
              title: e.title,
              startAt: e.startAt,
              endAt: e.endAt,
            })),
          });

          if (v2Result.v2Failed) {
            // V2 validation failed — fall back to V1 to preserve existing timeline
            console.log(`[sync] ${c.name}: V2 validation failed, falling back to V1`);
            pipelineResult = await runTopicPipeline(pipelineInput);
          } else {
            pipelineResult = v2Result;
            // Stash full reconciliation result for cross-course pass
            v2CourseResults.push({
              courseId: scCourseId,
              courseName: c.name,
              result: v2Result.reconciliationResult,
              pipelineInput,
              announcements: courseAnnouncements.map((a) => ({
                title: a.title,
                body: a.body ?? "",
                postedAt: a.postedAt ?? "",
              })),
              calendarEvents: c.calendarEvents?.map((e) => ({
                title: e.title,
                startAt: e.startAt,
                endAt: e.endAt,
              })),
            });
          }
        } else {
          pipelineResult = await runTopicPipeline(pipelineInput);
        }

        const topics = pipelineResult.topics;
        const anchors = pipelineResult.anchors;

        if (pipelineResult.materialSourceRoles.length > 0) {
          await Promise.all(
            pipelineResult.materialSourceRoles.map(async ({ label, role }) => {
              const fileName = label.replace(/^stored:/, "");
              if (fileName === "html-body") return;
              await db.courseMaterial.updateMany({
                where: { courseId: scCourseId, fileName },
                data: { sourceRole: role },
              });
            }),
          );
        }

        // Delete identified module topics
        if (pipelineResult.moduleIdsToDelete.length > 0) {
          await db.courseTopic.deleteMany({
            where: { id: { in: pipelineResult.moduleIdsToDelete } },
          });
        }

        // Delete any prior AI-sourced topics (avoid duplicates)
        await db.courseTopic.deleteMany({
          where: { courseId: scCourseId, canvasModuleId: null },
        });
        await db.courseTimelineAnchor.deleteMany({
          where: { courseId: scCourseId },
        });

        // Write new unified timeline
        await db.course.update({
          where: { id: scCourseId },
          data: {
            timelineMode: pipelineResult.timelineMode,
            timelineDiagnostics: {
              ...(pipelineResult.timelineDiagnostics as Record<string, unknown>),
              selectedSource: dbg.selectedSource,
              candidateSources: dbg.candidates,
              classScheduleSource: dbg.classScheduleSource,
              importedMaterials: dbg.materials,
            },
          },
        });

        if (anchors.length > 0) {
          await db.courseTimelineAnchor.createMany({
            data: anchors.map((anchor) => ({
              courseId: scCourseId,
              sequenceNumber: anchor.sequenceNumber,
              anchorDate: anchor.anchorDate,
              anchorType: anchor.anchorType,
              isInstructional: anchor.isInstructional,
              calendarConfidence: anchor.calendarConfidence,
              sourceRefs: anchor.sourceRefs as object[],
              notes: anchor.notes ?? null,
            })),
          });
        }

        if (topics.length > 0) {
          await db.courseTopic.createMany({
            data: topics.map((t, i) => ({
              courseId: scCourseId,
              weekNumber: Number.isInteger(t.weekNumber) ? t.weekNumber : (parseInt(String(t.weekNumber), 10) || i + 1),
              weekLabel: typeof t.weekLabel === "string" && t.weekLabel.trim() ? t.weekLabel.trim() : `Week ${i + 1}`,
              startDate: typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate) ? t.startDate : null,
              topics: Array.isArray(t.topics) ? t.topics.filter((x: unknown) => typeof x === "string") : [],
              readings: Array.isArray(t.readings) ? t.readings.filter((x: unknown) => typeof x === "string") : [],
              notes: typeof t.notes === "string" ? t.notes : null,
              dateConfidence: t.dateConfidence,
              contentConfidence: t.contentConfidence,
              scheduleMode: t.scheduleMode,
              provenance: t.provenance as object,
              canvasModuleId: null,
            })),
          });
        }

        aiTopicsCreated += topics.length;
        dbg.weeksWritten = topics.length;
        dbg.status = topics.length > 0 ? "ok" : "pipeline-0-weeks";

        allCourseDebug.push(dbg);
        console.log(
          `[sync] ${c.name}: pipeline → ${topics.length} weeks` +
          ` | deleted ${pipelineResult.moduleIdsToDelete.length} module topics` +
          ` | stage2=${pipelineResult.debug.stage2Classifications.length} modules classified` +
          ` | stage3=${pipelineResult.debug.stage3Weeks} ai weeks` +
          ` | stage4=${pipelineResult.debug.stage4OutputWeeks} fused weeks` +
          (pipelineResult.debug.fallbackUsed ? " | FALLBACK" : "") +
          (pipelineResult.debug.stage5Warnings.length > 0 ? ` | warnings=${pipelineResult.debug.stage5Warnings.length}` : "")
        );
      } catch (err) {
        dbg.status = "error";
        dbg.error = String(err);
        allCourseDebug.push(dbg);
        console.error(`[sync] ${c.name}: ERROR ${err} | sources: ${candidatesSummary}`);
      }
      } catch (courseErr) {
        console.error(`[sync] ${c.name}: UNHANDLED course-level error:`, courseErr);
      }
    })
  );

  if (scheduleRows.length > 0) {
    console.log("[sync] classSchedule:\n" + scheduleRows.join("\n"));
  }

  // ── V2 Cross-Course Consistency Pass ────────────────────────────────────────
  if (useV2 && v2CourseResults.length >= 2) {
    try {
      console.log(`[sync] V2 cross-course pass: analyzing ${v2CourseResults.length} courses`);
      const crossCourseResult = await runCrossCourseConsistencyCheck(
        v2CourseResults.map((cr) => ({ courseId: cr.courseId, courseName: cr.courseName, result: cr.result })),
      );

      const institutionalContext = buildInstitutionalContext(crossCourseResult);
      const affectedCourses = crossCourseResult.institutionalBreaks
        .filter((b) => b.confidence === "high" || b.confidence === "medium")
        .flatMap((b) => b.missingFromCourses);
      const uniqueAffected = [...new Set(affectedCourses)];

      console.log(`[sync] V2 cross-course: ${crossCourseResult.institutionalBreaks.length} breaks detected, ${uniqueAffected.length} courses need re-reconciliation`);

      // Re-reconcile affected courses with institutional context
      for (const courseName of uniqueAffected) {
        const cr = v2CourseResults.find((c) => c.courseName === courseName);
        if (!cr) continue;

        try {
          const reResult = await reReconcileWithInstitutionalContext(cr.pipelineInput, institutionalContext, {
            announcements: cr.announcements,
            calendarEvents: cr.calendarEvents,
          });
          const topics = reResult.topics;
          const anchors = reResult.anchors;

          // Rewrite DB for this course
          await db.courseTopic.deleteMany({ where: { courseId: cr.courseId, canvasModuleId: null } });
          await db.courseTimelineAnchor.deleteMany({ where: { courseId: cr.courseId } });

          await db.course.update({
            where: { id: cr.courseId },
            data: {
              timelineMode: reResult.timelineMode,
              timelineDiagnostics: {
                ...(reResult.timelineDiagnostics as Record<string, unknown>),
                crossCourseReReconciled: true,
                crossCourseSummary: crossCourseResult.summary,
              },
            },
          });

          if (anchors.length > 0) {
            await db.courseTimelineAnchor.createMany({
              data: anchors.map((anchor) => ({
                courseId: cr.courseId,
                sequenceNumber: anchor.sequenceNumber,
                anchorDate: anchor.anchorDate,
                anchorType: anchor.anchorType,
                isInstructional: anchor.isInstructional,
                calendarConfidence: anchor.calendarConfidence,
                sourceRefs: anchor.sourceRefs as object[],
                notes: anchor.notes ?? null,
              })),
            });
          }

          if (topics.length > 0) {
            await db.courseTopic.createMany({
              data: topics.map((t, i) => ({
                courseId: cr.courseId,
                weekNumber: Number.isInteger(t.weekNumber) ? t.weekNumber : (parseInt(String(t.weekNumber), 10) || i + 1),
                weekLabel: typeof t.weekLabel === "string" && t.weekLabel.trim() ? t.weekLabel.trim() : `Week ${i + 1}`,
                startDate: typeof t.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate) ? t.startDate : null,
                topics: Array.isArray(t.topics) ? t.topics.filter((x: unknown) => typeof x === "string") : [],
                readings: Array.isArray(t.readings) ? t.readings.filter((x: unknown) => typeof x === "string") : [],
                notes: typeof t.notes === "string" ? t.notes : null,
                dateConfidence: t.dateConfidence,
                contentConfidence: t.contentConfidence,
                scheduleMode: t.scheduleMode,
                provenance: t.provenance as object,
                canvasModuleId: null,
              })),
            });
          }

          console.log(`[sync] V2 cross-course re-reconciled "${courseName}": ${topics.length} weeks`);
        } catch (reErr) {
          console.error(`[sync] V2 cross-course re-reconciliation failed for "${courseName}":`, reErr);
        }
      }
    } catch (crossErr) {
      console.error("[sync] V2 cross-course pass failed:", crossErr);
    }
  }

  bgLog.info("background AI processing complete", {
    aiWeeks: aiTopicsCreated,
    filesImported: syllabusFilesImported,
    coursesProcessed: allCourseDebug.length,
  });
  await db.user.update({ where: { id: user.id }, data: { bgSyncProcessingAt: null } }).catch(() => {});

  } catch (err) {
    bgLog.error("background AI processing CRASHED", {
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await db.user.update({ where: { id: user.id }, data: { bgSyncProcessingAt: null } }).catch(() => {});
  }

  }); // end after()

  return withCors(log.respond(
    NextResponse.json({
      ok: true,
      summary,
    }),
    summary,
  ));
}
