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
  assert.deepEqual(hints.weekNumbers, [8]);
  assert.deepEqual(hints.lectureNumbers, [13]);
  assert.ok(hints.dateMentions.some((hint) => hint.isoDate === "2026-03-04"));
  assert.ok(hints.dateMentions.some((hint) => hint.isoDate === "2026-03-09"));
  assert.deepEqual(hints.breakSignals, ["Spring break"]);
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
});
