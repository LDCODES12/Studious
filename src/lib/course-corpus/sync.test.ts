import test from "node:test";
import assert from "node:assert/strict";
import { extractCourseEvidenceHints } from "@/lib/course-corpus/hints";
import { anthropologyDuplicateFixture, genChemLabProjectionFixture, pcsProjectionFixture } from "@/lib/course-corpus/fixtures";
import { __testables } from "@/lib/course-corpus/sync";

test("canonical dedupe keeps one source key and merged provenance across syllabus/module discovery", () => {
  const [syllabusDiscovery, moduleDiscovery] = anthropologyDuplicateFixture.discoveries;
  const syllabusKey = __testables.deriveCanonicalSourceKey({
    rawSourceKind: syllabusDiscovery.rawSourceKind,
    rawSourceKey: syllabusDiscovery.rawSourceKey,
    title: syllabusDiscovery.title,
    contentHash: syllabusDiscovery.contentHash,
    announcedId: null,
    calendarSeed: null,
  });
  const moduleKey = __testables.deriveCanonicalSourceKey({
    rawSourceKind: moduleDiscovery.rawSourceKind,
    rawSourceKey: moduleDiscovery.rawSourceKey,
    title: moduleDiscovery.title,
    contentHash: moduleDiscovery.contentHash,
    announcedId: null,
    calendarSeed: null,
  });

  assert.equal(syllabusKey, moduleKey);

  const mergedProvenance = __testables.mergeProvenance([syllabusDiscovery.provenance], moduleDiscovery.provenance);
  assert.equal(mergedProvenance.length, 2);
  assert.deepEqual(
    mergedProvenance.map((entry) => entry.discoveredVia).sort(),
    ["module page", "syllabus pdf"],
  );
});

test("hint extraction finds dates, weeks, lectures, and break signals", () => {
  const hints = extractCourseEvidenceHints({
    sourceKind: "canvas_syllabus_page",
    title: "Week 8 Lecture 13 Schedule",
    bodyText: "Lecture 13 happens on March 4, 2026. Spring break begins on 3/9.",
    structuredPayload: null,
    termStartAt: "2026-01-12",
    termEndAt: "2026-05-01",
    remoteUpdatedAt: null,
  });

  assert.ok(hints.roles.includes("schedule_like"));
  assert.equal(hints.structuralAuthority, "schedule_authority");
  assert.deepEqual(hints.weekNumbers, [8]);
  assert.deepEqual(hints.lectureNumbers, [13]);
  assert.ok(hints.dateMentions.some((hint) => hint.isoDate === "2026-03-04"));
  assert.ok(hints.dateMentions.some((hint) => hint.isoDate === "2026-03-09"));
  assert.deepEqual(hints.breakSignals, ["Spring break"]);
});

test("content-looking lecture files do not become schedule authority just because they mention a date", () => {
  const hints = extractCourseEvidenceHints({
    sourceKind: "canvas_linked_file",
    title: "for_canvas_lecture 5p5 Mar 2 2026.pdf",
    bodyText: "Lecture 5.5 review of equilibrium constants and worked examples for March 2, 2026.",
    structuredPayload: null,
    termStartAt: "2026-01-12",
    termEndAt: "2026-05-01",
    remoteUpdatedAt: null,
  });

  assert.equal(hints.structuralAuthority, "content_only");
  assert.ok(hints.roles.includes("content_like"));
});

test("PCS review announcements attach as event evidence without replacing syllabus schedule truth", () => {
  const projection = __testables.deriveCorpusProjection(pcsProjectionFixture);
  const immuneWeek = projection.finalBuckets.find((bucket) => bucket.startDate === "2026-03-02");

  assert.ok(immuneWeek);
  assert.equal(immuneWeek?.weekLabel, "Immune system regulation");
  assert.ok(immuneWeek?.sourceEvidenceIds.includes("pcs-syllabus"));
  assert.ok(immuneWeek?.eventEvidenceIds.includes("pcs-review-announcement"));
  assert.ok(!immuneWeek?.sourceEvidenceIds.includes("pcs-review-announcement"));

  const reviewPlacement = projection.finalPlacements.find((placement) => placement.evidenceId === "pcs-review-announcement");
  assert.equal(reviewPlacement?.placementKind, "event_only");
  assert.ok(projection.diagnostics.authoritySourcesUsed.some((entry) => entry.evidenceId === "pcs-syllabus"));
});

test("Gen Chem Lab projection merges same-week activity and prunes phantom weeks while preserving spring break", () => {
  const projection = __testables.deriveCorpusProjection(genChemLabProjectionFixture);

  assert.equal(projection.finalBuckets.length, 2);

  const labWeek = projection.finalBuckets.find((bucket) => bucket.startDate === "2026-02-09");
  assert.ok(labWeek);
  assert.equal(labWeek?.weekLabel, "Buffers experiment");
  assert.ok(labWeek?.topics.includes("Buffers Lab"));
  assert.ok(labWeek?.topics.includes("Lab 4 Overview"));
  assert.ok(labWeek?.notes.some((note) => /Experiment 4: Buffers/i.test(note)));

  const springBreakWeek = projection.finalBuckets.find((bucket) => bucket.startDate === "2026-03-09");
  assert.ok(springBreakWeek);
  assert.equal(springBreakWeek?.placementKind, "explicit_break");
  assert.match(springBreakWeek?.weekLabel ?? "", /spring break/i);
  assert.ok(projection.diagnostics.emptyWeeksPruned >= 1);
});

test("only schedule-authority evidence can define class schedule source candidates", () => {
  const scheduleAuthority = pcsProjectionFixture.evidence[0];
  const contentFile = {
    ...pcsProjectionFixture.evidence[2],
    sourceKind: "canvas_linked_file" as const,
    title: "Lecture 13 Review.pdf",
    derivedHints: {
      ...pcsProjectionFixture.evidence[2].derivedHints,
      roles: ["schedule_like", "content_like"] as Array<"schedule_like" | "content_like">,
      structuralAuthority: "content_only" as const,
    },
  };

  const projection = __testables.deriveCorpusProjection({
    ...pcsProjectionFixture,
    evidence: [scheduleAuthority, contentFile],
  });

  assert.ok(projection.diagnostics.authoritySourcesUsed.some((entry) => entry.evidenceId === "pcs-syllabus"));
  assert.ok(projection.diagnostics.rejectedLowAuthorityScheduleSources.some((entry) => entry.evidenceId === "pcs-lecture-13"));
});

test("course-local RAG synthesis can label weeks but cannot promote content-only evidence into a break", () => {
  const projection = __testables.deriveCorpusProjection(pcsProjectionFixture);
  const applied = __testables.applyTimelineSynthesisToProjection({
    courseName: pcsProjectionFixture.courseName,
    evidence: pcsProjectionFixture.evidence,
    projection,
    context: {
      queries: ["fixture synthesis"],
      evidence: __testables.buildTimelineContextEvidence(pcsProjectionFixture.evidence),
      chunks: [],
    },
    synthesis: {
      confidence: "medium",
      citedEvidenceIds: ["pcs-lecture-13"],
      concerns: [],
      weeks: [
        {
          startDate: "2026-03-02",
          weekLabel: "Immune system regulation",
          placementKind: "explicit_break",
          topics: ["Immune System"],
          readings: [],
          notes: [],
          sourceEvidenceIds: ["pcs-lecture-13"],
          eventEvidenceIds: [],
          confidence: "medium",
          rationale: "Fixture tries to over-promote content-only evidence.",
        },
      ],
    },
  });

  assert.ok(applied);
  const immuneWeek = applied.finalBuckets.find((bucket) => bucket.startDate === "2026-03-02");
  assert.equal(immuneWeek?.placementKind, "instructional_week");
  assert.equal(applied.diagnostics.retrievalDecisionCounts.timelineSyntheses, 1);
  assert.equal(applied.diagnostics.ragContext?.evidenceItems, 3);
});

test("course-local RAG synthesis does not leak uncited deterministic placements into final weeks", () => {
  const projection = __testables.deriveCorpusProjection(pcsProjectionFixture);
  const applied = __testables.applyTimelineSynthesisToProjection({
    courseName: pcsProjectionFixture.courseName,
    evidence: pcsProjectionFixture.evidence,
    projection,
    context: {
      queries: ["fixture synthesis"],
      evidence: __testables.buildTimelineContextEvidence(pcsProjectionFixture.evidence),
      chunks: [],
    },
    synthesis: {
      confidence: "high",
      citedEvidenceIds: ["pcs-syllabus"],
      concerns: [],
      weeks: [
        {
          startDate: "2026-03-02",
          weekLabel: "Immune system regulation",
          placementKind: "instructional_week",
          topics: ["Immune System"],
          readings: [],
          notes: [],
          sourceEvidenceIds: ["pcs-syllabus"],
          eventEvidenceIds: [],
          confidence: "high",
          rationale: "Fixture cites only schedule authority.",
        },
      ],
    },
  });

  assert.ok(applied);
  const immuneWeek = applied.finalBuckets.find((bucket) => bucket.startDate === "2026-03-02");
  assert.ok(immuneWeek);
  assert.deepEqual(immuneWeek?.sourceEvidenceIds, ["pcs-syllabus"]);
  assert.ok(!immuneWeek?.sourceEvidenceIds.includes("pcs-lecture-13"));

  const uncitedLecture = applied.finalPlacements.find((placement) => placement.evidenceId === "pcs-lecture-13");
  assert.equal(uncitedLecture?.weekNumber, null);
  assert.equal(uncitedLecture?.startDate, null);
  assert.equal(uncitedLecture?.placementKind, "global");
  assert.ok(uncitedLecture?.signals.includes("rag_uncited"));
});
