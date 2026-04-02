import test from "node:test";
import assert from "node:assert/strict";
import type { EvidenceMaterial, SelectionCandidate } from "@/lib/source-aware-evidence";
import {
  buildTranscriptDigest,
  classifyMaterialSourceRole,
  selectSourceAwareMaterials,
} from "@/lib/source-aware-evidence";

function makeMaterial(
  overrides: Partial<SelectionCandidate> = {},
): SelectionCandidate {
  const base: EvidenceMaterial = {
    id: "material-1",
    fileName: "Lecture Notes.pdf",
    courseName: null,
    detectedType: "lecture_notes",
    sourceKind: "canvas_module",
    sourceRole: "content",
    summary: "Covers equilibrium concepts and how K relates to reaction conditions.",
    relatedTopics: ["Equilibrium", "Reaction conditions"],
    rawText: "Equilibrium concepts and reaction conditions.",
    storedForAI: true,
    contentHash: "hash-1",
    sourceUpdatedAt: "2026-04-02T00:00:00.000Z",
    uploadedAt: new Date("2026-04-02T00:00:00.000Z").toISOString(),
    materialSourceRole: "canonical",
  };

  return {
    ...base,
    matchScore: 50,
    preferred: false,
    ...overrides,
  };
}

test("classifyMaterialSourceRole treats canvas_media as transcript", () => {
  assert.equal(classifyMaterialSourceRole({ sourceKind: "canvas_media" }), "transcript");
  assert.equal(classifyMaterialSourceRole({ sourceKind: "canvas_module" }), "canonical");
});

test("selectSourceAwareMaterials preserves canonical backbone and transcript quota", () => {
  const selected = selectSourceAwareMaterials(
    [
      makeMaterial({ id: "canon-1", fileName: "Lecture Notes.pdf", detectedType: "lecture_notes", materialSourceRole: "canonical", matchScore: 90 }),
      makeMaterial({ id: "canon-2", fileName: "Slides.pdf", detectedType: "lecture_slides", materialSourceRole: "canonical", matchScore: 80 }),
      makeMaterial({ id: "canon-3", fileName: "Textbook.pdf", detectedType: "textbook", materialSourceRole: "canonical", matchScore: 70 }),
      makeMaterial({ id: "tx-1", fileName: "Lecture 30 transcript.txt", sourceKind: "canvas_media", materialSourceRole: "transcript", matchScore: 95 }),
      makeMaterial({ id: "tx-2", fileName: "Exam 1 Review transcript.txt", sourceKind: "canvas_media", materialSourceRole: "transcript", matchScore: 85 }),
      makeMaterial({ id: "tx-3", fileName: "Lecture 31 transcript.txt", sourceKind: "canvas_media", materialSourceRole: "transcript", matchScore: 75 }),
    ],
    { maxCanonical: 2, maxTranscript: 2, transcriptOnlyMax: 3 },
  );

  assert.deepEqual(selected.canonicalMaterials.map((material) => material.id), ["canon-1", "canon-2"]);
  assert.deepEqual(selected.transcriptMaterials.map((material) => material.id), ["tx-2", "tx-1"]);
});

test("selectSourceAwareMaterials falls back to transcript-only when canonical materials are absent", () => {
  const selected = selectSourceAwareMaterials(
    [
      makeMaterial({ id: "tx-1", fileName: "Lecture 30 transcript.txt", sourceKind: "canvas_media", materialSourceRole: "transcript", matchScore: 95 }),
      makeMaterial({ id: "tx-2", fileName: "Lecture 31 transcript.txt", sourceKind: "canvas_media", materialSourceRole: "transcript", matchScore: 85 }),
      makeMaterial({ id: "tx-3", fileName: "Exam 1 Review transcript.txt", sourceKind: "canvas_media", materialSourceRole: "transcript", matchScore: 75 }),
      makeMaterial({ id: "tx-4", fileName: "Lecture 32 transcript.txt", sourceKind: "canvas_media", materialSourceRole: "transcript", matchScore: 65 }),
    ],
    { maxCanonical: 2, maxTranscript: 2, transcriptOnlyMax: 3 },
  );

  assert.equal(selected.canonicalMaterials.length, 0);
  assert.equal(selected.transcriptMaterials.length, 3);
});

test("selectSourceAwareMaterials does not let weak canonical docs block transcript-only fallback", () => {
  const selected = selectSourceAwareMaterials(
    [
      makeMaterial({
        id: "weak-1",
        fileName: "Course Syllabus.pdf",
        detectedType: "other",
        summary: "Course calendar, policies, and attendance expectations.",
        materialSourceRole: "canonical",
        matchScore: 95,
      }),
      makeMaterial({
        id: "tx-1",
        fileName: "Lecture 30 transcript.txt",
        sourceKind: "canvas_media",
        materialSourceRole: "transcript",
        matchScore: 90,
      }),
    ],
    { maxCanonical: 2, maxTranscript: 2, transcriptOnlyMax: 3 },
  );

  assert.equal(selected.canonicalMaterials.length, 0);
  assert.deepEqual(selected.transcriptMaterials.map((material) => material.id), ["tx-1"]);
});

test("buildTranscriptDigest keeps concepts, worked examples, review cues, and clarifications", () => {
  const digest = buildTranscriptDigest(
    [
      makeMaterial({
        id: "tx-1",
        sourceKind: "canvas_media",
        materialSourceRole: "transcript",
        fileName: "Lecture 30 transcript.txt",
        summary: "Lecture 30 introduces equilibrium concepts and focuses on calculating and interpreting Kc.",
        relatedTopics: ["Equilibrium", "Kc", "Reaction conditions"],
      }),
      makeMaterial({
        id: "tx-2",
        sourceKind: "canvas_media",
        materialSourceRole: "transcript",
        fileName: "Exam 1 Review transcript.txt",
        summary: "A live review session with walkthroughs of selected practice questions from last year's exam.",
        relatedTopics: ["Equilibrium", "Practice problems"],
      }),
    ],
    ["Equilibrium", "Kc", "Quiz 1"],
  );

  assert.ok(digest);
  assert.ok(digest?.emphasizedConcepts.includes("Equilibrium"));
  assert.ok(digest?.workedExamples.some((line) => /practice questions/i.test(line)));
  assert.ok(digest?.reviewSignals.some((line) => /review/i.test(line)));
  assert.ok(digest?.clarifications.some((line) => /focuses on calculating/i.test(line)));
});
