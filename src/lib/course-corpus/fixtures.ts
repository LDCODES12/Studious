import type { ParsedTopic, ExtractedClassSchedule } from "@/lib/parse-syllabus";
import type { LoadedEvidence } from "@/lib/course-corpus/sync";

const NOW = new Date("2026-04-22T12:00:00.000Z");

function makeEvidence(overrides: Partial<LoadedEvidence> & Pick<LoadedEvidence, "id" | "courseId" | "sourceKind" | "sourceKey" | "title">): LoadedEvidence {
  return {
    id: overrides.id,
    courseId: overrides.courseId,
    sourceKind: overrides.sourceKind,
    sourceKey: overrides.sourceKey,
    title: overrides.title,
    bodyText: overrides.bodyText ?? null,
    structuredPayload: overrides.structuredPayload ?? null,
    provenance: overrides.provenance ?? [
      {
        discoveredVia: "fixture",
        rawSourceKind: overrides.sourceKind,
        sourceKey: overrides.sourceKey,
        remoteId: null,
        sourceUrl: null,
        moduleName: null,
        pageName: null,
        fileName: overrides.title,
        label: null,
        capturedAt: NOW.toISOString(),
      },
    ],
    capturedAt: overrides.capturedAt ?? NOW,
    remoteUpdatedAt: overrides.remoteUpdatedAt ?? NOW,
    contentHash: overrides.contentHash ?? `hash-${overrides.id}`,
    derivedHints: overrides.derivedHints ?? {
      roles: [],
      structuralAuthority: "content_only",
      authoritySignals: [],
      dateMentions: [],
      weekNumbers: [],
      lectureNumbers: [],
      unitNumbers: [],
      breakSignals: [],
      noClassSignals: [],
      sourceRoleSignals: [],
    },
  };
}

const twiceWeeklySchedule: ExtractedClassSchedule = {
  meetings: [
    { label: "Lecture", days: ["MO"], startTime: "10:00", endTime: "10:50", location: "Hall A" },
    { label: "Lecture", days: ["WE"], startTime: "10:00", endTime: "10:50", location: "Hall A" },
  ],
  semesterStart: "2026-01-12",
  semesterEnd: "2026-05-01",
  finalExamDate: null,
};

export const anthropologyDuplicateFixture = {
  title: "Anthropology duplicate-linked file fixture",
  discoveries: [
    {
      rawSourceKind: "canvas_syllabus",
      rawSourceKey: "8492",
      title: "Culture is really about science and technology.pdf",
      contentHash: "anthro-shared",
      provenance: {
        discoveredVia: "syllabus pdf",
        rawSourceKind: "canvas_syllabus",
        sourceKey: "8492",
        remoteId: "8492",
        sourceUrl: "https://canvas.example/files/8492",
        moduleName: null,
        pageName: null,
        fileName: "Culture is really about science and technology.pdf",
        label: "Week 13",
        capturedAt: NOW.toISOString(),
      },
    },
    {
      rawSourceKind: "canvas_module",
      rawSourceKey: "8492",
      title: "Culture is really about science and technology.pdf",
      contentHash: "anthro-shared",
      provenance: {
        discoveredVia: "module page",
        rawSourceKind: "canvas_module",
        sourceKey: "8492",
        remoteId: "8492",
        sourceUrl: "https://canvas.example/files/8492",
        moduleName: "Week 13",
        pageName: "Course Schedule",
        fileName: "Culture is really about science and technology.pdf",
        label: "Latour",
        capturedAt: NOW.toISOString(),
      },
    },
  ],
};

export const pcsProjectionFixture: {
  courseName: string;
  evidence: LoadedEvidence[];
  parsedScheduleWeeks: Array<{ evidenceId: string; weeks: ParsedTopic[] }>;
  classSchedule: ExtractedClassSchedule;
  termStartAt: string;
  termEndAt: string;
} = {
  courseName: "Physiological Control Systems",
  termStartAt: "2026-01-12",
  termEndAt: "2026-05-01",
  classSchedule: twiceWeeklySchedule,
  evidence: [
    makeEvidence({
      id: "pcs-syllabus",
      courseId: "pcs-course",
      sourceKind: "canvas_syllabus_pdf",
      sourceKey: "canvas-file:pcs-syllabus",
      title: "PCS Syllabus.pdf",
      bodyText: "Course schedule with weekly lecture cadence.",
      derivedHints: {
        roles: ["schedule_like"],
        structuralAuthority: "schedule_authority",
        authoritySignals: ["trusted_schedule_source", "explicit_schedule_structure"],
        dateMentions: [],
        weekNumbers: [],
        lectureNumbers: [],
        unitNumbers: [],
        breakSignals: [],
        noClassSignals: [],
        sourceRoleSignals: ["schedule"],
      },
    }),
    makeEvidence({
      id: "pcs-review-announcement",
      courseId: "pcs-course",
      sourceKind: "canvas_announcement",
      sourceKey: "canvas-announcement:review-1",
      title: "Exam 2 Review Session",
      bodyText: "Exam 2 Review Session on March 4 at 6pm.",
      derivedHints: {
        roles: ["event_like"],
        structuralAuthority: "schedule_support",
        authoritySignals: ["event_record", "date_mentions"],
        dateMentions: [{ raw: "March 4", isoDate: "2026-03-04" }],
        weekNumbers: [],
        lectureNumbers: [],
        unitNumbers: [],
        breakSignals: [],
        noClassSignals: [],
        sourceRoleSignals: ["dated_event"],
      },
    }),
    makeEvidence({
      id: "pcs-lecture-13",
      courseId: "pcs-course",
      sourceKind: "canvas_module_item",
      sourceKey: "canvas-module:13",
      title: "Lecture 13: Immune System",
      bodyText: "Lecture 13 content.",
      derivedHints: {
        roles: ["content_like"],
        structuralAuthority: "content_only",
        authoritySignals: ["content_source"],
        dateMentions: [],
        weekNumbers: [],
        lectureNumbers: [13],
        unitNumbers: [],
        breakSignals: [],
        noClassSignals: [],
        sourceRoleSignals: ["content"],
      },
    }),
  ],
  parsedScheduleWeeks: [
    {
      evidenceId: "pcs-syllabus",
      weeks: [
        {
          courseName: "Physiological Control Systems",
          weekNumber: 1,
          weekLabel: "Course foundations",
          startDate: "2026-01-12",
          topics: ["Homeostasis"],
          readings: [],
          notes: null,
        },
        {
          courseName: "Physiological Control Systems",
          weekNumber: 8,
          weekLabel: "Immune system regulation",
          startDate: "2026-03-02",
          topics: ["Immune System"],
          readings: [],
          notes: null,
        },
      ],
    },
  ],
};

export const genChemLabProjectionFixture: {
  courseName: string;
  evidence: LoadedEvidence[];
  parsedScheduleWeeks: Array<{ evidenceId: string; weeks: ParsedTopic[] }>;
  classSchedule: ExtractedClassSchedule;
  termStartAt: string;
  termEndAt: string;
} = {
  courseName: "Gen Chem 2 Lab",
  termStartAt: "2026-01-12",
  termEndAt: "2026-05-01",
  classSchedule: {
    meetings: [
      { label: "Lab", days: ["TU"], startTime: "13:00", endTime: "15:50", location: "Lab 201" },
    ],
    semesterStart: "2026-01-12",
    semesterEnd: "2026-05-01",
    finalExamDate: null,
  },
  evidence: [
    makeEvidence({
      id: "lab-syllabus",
      courseId: "lab-course",
      sourceKind: "canvas_syllabus_pdf",
      sourceKey: "canvas-file:lab-syllabus",
      title: "Gen Chem 2 Lab Syllabus.pdf",
      bodyText: "Weekly experiment schedule with spring break.",
      derivedHints: {
        roles: ["schedule_like"],
        structuralAuthority: "schedule_authority",
        authoritySignals: ["trusted_schedule_source", "explicit_schedule_structure"],
        dateMentions: [],
        weekNumbers: [],
        lectureNumbers: [],
        unitNumbers: [],
        breakSignals: [],
        noClassSignals: [],
        sourceRoleSignals: ["schedule"],
      },
    }),
    makeEvidence({
      id: "lab-overview-page",
      courseId: "lab-course",
      sourceKind: "canvas_page",
      sourceKey: "canvas-page:lab-4-overview",
      title: "Lab 4 Overview",
      bodyText: "Prepare buffer calculations before lab on February 10.",
      derivedHints: {
        roles: ["content_like"],
        structuralAuthority: "content_only",
        authoritySignals: ["content_source"],
        dateMentions: [{ raw: "February 10", isoDate: "2026-02-10" }],
        weekNumbers: [],
        lectureNumbers: [],
        unitNumbers: [],
        breakSignals: [],
        noClassSignals: [],
        sourceRoleSignals: ["content"],
      },
    }),
    makeEvidence({
      id: "lab-experiment-file",
      courseId: "lab-course",
      sourceKind: "canvas_linked_file",
      sourceKey: "canvas-file:experiment-4",
      title: "Experiment 4: Buffers.pdf",
      bodyText: "Experiment 4 instructions.",
      derivedHints: {
        roles: ["content_like"],
        structuralAuthority: "content_only",
        authoritySignals: ["content_source"],
        dateMentions: [{ raw: "2/10", isoDate: "2026-02-10" }],
        weekNumbers: [],
        lectureNumbers: [],
        unitNumbers: [],
        breakSignals: [],
        noClassSignals: [],
        sourceRoleSignals: ["content"],
      },
    }),
    makeEvidence({
      id: "lab-spring-break",
      courseId: "lab-course",
      sourceKind: "canvas_announcement",
      sourceKey: "canvas-announcement:spring-break",
      title: "Spring Break",
      bodyText: "No class during spring break on March 10.",
      derivedHints: {
        roles: ["schedule_like", "event_like", "break_like"],
        structuralAuthority: "schedule_support",
        authoritySignals: ["event_record", "explicit_break_signal"],
        dateMentions: [{ raw: "March 10", isoDate: "2026-03-10" }],
        weekNumbers: [],
        lectureNumbers: [],
        unitNumbers: [],
        breakSignals: ["Spring Break"],
        noClassSignals: ["No class"],
        sourceRoleSignals: ["schedule", "dated_event"],
      },
    }),
  ],
  parsedScheduleWeeks: [
    {
      evidenceId: "lab-syllabus",
      weeks: [
        {
          courseName: "Gen Chem 2 Lab",
          weekNumber: 5,
          weekLabel: "Buffers experiment",
          startDate: "2026-02-09",
          topics: ["Buffers Lab"],
          readings: ["Pre-lab"],
          notes: "Lecture + lab sequence",
        },
        {
          courseName: "Gen Chem 2 Lab",
          weekNumber: 9,
          weekLabel: "Spring Break",
          startDate: "2026-03-09",
          topics: [],
          readings: [],
          notes: "No class",
        },
      ],
    },
  ],
};
