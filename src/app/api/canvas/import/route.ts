import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import crypto from "crypto";
import { generateTasksForUser } from "@/lib/tasks";
import {
  deriveCandidateStatus,
  materialStateKey,
} from "@/lib/canvas-sync/import-support";
import type { MaterialSourceKind } from "@/lib/material-sync";
import {
  ingestCanvasCourseEvidence,
  rebuildCourseCorpusProjections,
} from "@/lib/course-corpus/sync";

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
  sourceKey?: string | null;
  sourceKind?: MaterialSourceKind;
  remoteUpdatedAt?: string | null;
  remoteSize?: number | null;
}

interface MaterialCandidate {
  fileName: string;
  moduleName: string;
  contentId: string;
  sourceKind?: MaterialSourceKind;
  remoteUpdatedAt?: string | null;
  remoteSize?: number | null;
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
  /** Pre-extracted text from Canvas Pages discovered during sync */
  pageTexts?: SyllabusText[];
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
  syncMode?: "manual" | "scout";
  deferProjection?: boolean;
  finalizeProjection?: boolean;
  uploadPhase?: string;
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

async function persistCanvasMaterialCandidates(
  courseId: string,
  materialCandidates: MaterialCandidate[],
): Promise<void> {
  if (materialCandidates.length === 0) return;

  const [importedMaterials, existingCandidates] = await Promise.all([
    db.courseMaterial.findMany({
      where: {
        courseId,
        sourceKind: { in: ["canvas_module", "canvas_media", "canvas_syllabus"] },
        sourceKey: { in: materialCandidates.map((candidate) => candidate.contentId) },
      },
      select: {
        sourceKind: true,
        sourceKey: true,
        sourceUpdatedAt: true,
      },
    }),
    db.canvasMaterialCandidate.findMany({
      where: {
        courseId,
        contentId: { in: materialCandidates.map((candidate) => candidate.contentId) },
      },
      select: {
        contentId: true,
        requested: true,
        remoteSize: true,
      },
    }),
  ]);

  const importedMaterialMap = new Map(
    importedMaterials
      .filter((material): material is typeof material & { sourceKey: string } => Boolean(material.sourceKey))
      .map((material) => [
        materialStateKey(material.sourceKind as MaterialSourceKind, material.sourceKey),
        { sourceUpdatedAt: material.sourceUpdatedAt },
      ]),
  );
  const existingCandidateMap = new Map(existingCandidates.map((candidate) => [candidate.contentId, candidate]));

  await Promise.all(
    materialCandidates.map((candidate) => {
      const sourceKind = candidate.sourceKind ?? "canvas_module";
      const candidateKey = materialStateKey(sourceKind, candidate.contentId);
      const importedMaterial = importedMaterialMap.get(candidateKey) ?? null;
      const requested = importedMaterial
        ? false
        : (existingCandidateMap.get(candidate.contentId)?.requested ?? false);
      const previousCandidate = existingCandidateMap.get(candidate.contentId) ?? null;

      return db.canvasMaterialCandidate.upsert({
        where: { courseId_contentId: { courseId, contentId: candidate.contentId } },
        update: {
          fileName: candidate.fileName,
          moduleName: candidate.moduleName,
          sourceKind,
          remoteUpdatedAt: candidate.remoteUpdatedAt ?? null,
          remoteSize: candidate.remoteSize ?? null,
          requested,
          status: deriveCandidateStatus({
            requested,
            importedMaterial,
            remoteUpdatedAt: candidate.remoteUpdatedAt ?? null,
            remoteSize: candidate.remoteSize ?? null,
            previousRemoteSize: previousCandidate?.remoteSize ?? null,
          }),
          lastSeenAt: new Date(),
        },
        create: {
          courseId,
          fileName: candidate.fileName,
          moduleName: candidate.moduleName,
          contentId: candidate.contentId,
          sourceKind,
          remoteUpdatedAt: candidate.remoteUpdatedAt ?? null,
          remoteSize: candidate.remoteSize ?? null,
          requested,
          status: deriveCandidateStatus({
            requested,
            importedMaterial,
            remoteUpdatedAt: candidate.remoteUpdatedAt ?? null,
            remoteSize: candidate.remoteSize ?? null,
            previousRemoteSize: previousCandidate?.remoteSize ?? null,
          }),
          lastSeenAt: new Date(),
        },
      });
    }),
  );
}

// ─── POST — full Canvas sync ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Authenticate via Bearer token
  const user = await authedUser(request);
  if (!user) return withCors(NextResponse.json({ error: "Invalid or missing token" }, { status: 401 }));

  const log = apiLogger("POST /api/canvas/import", user.id);

  // 2. Parse payload
  const payload: ImportPayload = await request.json();
  const {
    syncMode = "manual",
    deferProjection = false,
    finalizeProjection = false,
    uploadPhase = null,
    courses = [],
    assignments = [],
    modules = [],
    announcements = [],
    assignmentGroups: rawGroups = [],
  } = payload;

  log.info("sync started", {
    syncMode,
    deferProjection,
    finalizeProjection,
    uploadPhase,
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

  // 7. Modules are now canonical evidence inputs, not temporary CourseTopic rows.
  const newModules = 0;
  const updatedModules = 0;

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

  // 9. Persist canonical course evidence now, but leave expensive chunking/RAG
  // projection to the final server-side background pass.
  const corpusInputs: Array<{
    canvasCourse: CanvasCourse;
    courseId: string;
    courseAssignments: CanvasAssignment[];
    courseModules: CanvasModule[];
    courseAnnouncements: CanvasAnnouncement[];
  }> = [];

  for (const c of courses) {
    const scCourseId = courseIdMap.get(c.id);
    if (!scCourseId) continue;

    const courseAssignments = assignments.filter((assignment) => assignment.courseId === c.id);
    const courseModules = modules.filter((module) => module.courseId === c.id);
    const courseAnnouncements = announcements.filter((announcement) => announcement.courseId === c.id);

    await persistCanvasMaterialCandidates(scCourseId, c.materialCandidates ?? []);
    await ingestCanvasCourseEvidence({
      courseId: scCourseId,
      courseName: c.name,
      termStartAt: c.termStartAt ?? null,
      termEndAt: c.termEndAt ?? null,
      calendarEvents: c.calendarEvents ?? [],
      course: c,
      assignments: courseAssignments,
      modules: courseModules,
      announcements: courseAnnouncements,
    }, { ensureChunks: false });

    corpusInputs.push({
      canvasCourse: c,
      courseId: scCourseId,
      courseAssignments,
      courseModules,
      courseAnnouncements,
    });
  }

  // 10. Auto-generate tasks from assignments (fast — runs before response)
  const tasksCreated = await generateTasksForUser(user.id);

  // Return the response immediately so the extension can keep collecting browser-only data.
  // Corpus chunking/RAG projection runs in the background only on final handoff.
  const summary = {
    courses: { new: newCourses, updated: updatedCourses },
    assignments: { new: newAssignments, updated: updatedAssignments },
    assignmentGroups: { new: newGroups, updated: updatedGroups },
    modules: { new: newModules, updated: updatedModules },
    announcements: { new: newAnnouncements },
    tasks: { autoGenerated: tasksCreated },
    syllabus: {
      aiWeeks: 0,
      filesImported: 0,
      background: !deferProjection || finalizeProjection || uploadPhase === "canvas-main",
    },
  };

  // Kick off corpus processing as soon as the main Canvas payload lands so the
  // website "Analyzing syllabi…" banner can pick up the baton immediately.
  // Later batches (materials, pages, transcripts, Gradescope) add enhancement
  // data; the finalize handoff re-runs processing with everything. If the
  // extension service worker dies before finalize, the user still has a
  // processed timeline from this first pass.
  const shouldRunProjection =
    !deferProjection || finalizeProjection || uploadPhase === "canvas-main";

  if (shouldRunProjection) {
    // Set the banner flag synchronously so the website starts showing
    // "Analyzing syllabi…" before after() actually begins.
    await db.user
      .update({ where: { id: user.id }, data: { bgSyncProcessingAt: new Date() } })
      .catch(() => {});
  }

  if (shouldRunProjection) after(async () => {
    const bgLog = apiLogger("POST /api/canvas/import [after]", user.id);
    bgLog.info("background corpus processing started", {
      courses: courses.length,
      syncMode,
      finalizeProjection,
      uploadPhase,
    });

    try {
      // canvas-main runs before the materials/pages/transcripts batches have
      // landed. Rebuilding existing timelines from that partial corpus makes
      // the schedule visibly flip mid-sync (and again at finalize). So the
      // early pass is a first-sync safety net only: it projects courses that
      // have no timeline yet, and everything else waits for finalize.
      let projectionInputs = corpusInputs;
      if (uploadPhase === "canvas-main" && !finalizeProjection) {
        const coursesWithTopics = await db.courseTopic.findMany({
          where: { courseId: { in: corpusInputs.map((input) => input.courseId) } },
          distinct: ["courseId"],
          select: { courseId: true },
        });
        const hasTimeline = new Set(coursesWithTopics.map((row) => row.courseId));
        projectionInputs = corpusInputs.filter((input) => !hasTimeline.has(input.courseId));
        bgLog.info("canvas-main projection gate", {
          totalCourses: corpusInputs.length,
          projectingNow: projectionInputs.length,
          deferredToFinalize: corpusInputs.length - projectionInputs.length,
        });
      }

      const courseDebug: Array<{
        name: string;
        weeksWritten: number;
        classScheduleSource: string;
        status: string;
        error?: string;
      }> = [];

      await Promise.all(
        projectionInputs.map(async (input) => {
          const c = input.canvasCourse;
          try {
            const result = await rebuildCourseCorpusProjections({
              courseId: input.courseId,
              courseName: c.name,
              termStartAt: c.termStartAt ?? null,
              termEndAt: c.termEndAt ?? null,
              calendarEvents: c.calendarEvents ?? [],
            });

            courseDebug.push({
              name: c.name,
              weeksWritten: result.weeksWritten,
              classScheduleSource: result.classScheduleSource,
              status: syncMode === "scout" ? "scout:corpus-refresh" : "ok",
            });
            console.log(
              `[sync] ${c.name}: corpus-first rebuild → ${result.weeksWritten} weeks | classSchedule=${result.classScheduleSource}`,
            );
          } catch (courseErr) {
            courseDebug.push({
              name: c.name,
              weeksWritten: 0,
              classScheduleSource: "error",
              status: "error",
              error: String(courseErr),
            });
            console.error(`[sync] ${c.name}: corpus-first sync failed`, courseErr);
          }
        }),
      );

      bgLog.info("background corpus processing complete", {
        coursesProcessed: courseDebug.length,
        weeksWritten: courseDebug.reduce((sum, item) => sum + item.weeksWritten, 0),
        statuses: courseDebug.map((item) => ({
          name: item.name,
          weeksWritten: item.weeksWritten,
          classScheduleSource: item.classScheduleSource,
          status: item.status,
        })),
      });
      await db.user.update({ where: { id: user.id }, data: { bgSyncProcessingAt: null } }).catch(() => {});
    } catch (err) {
      bgLog.error("background corpus processing crashed", {
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
