import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.OPENAI_API_KEY ??= "fixture-test-key";

const topicPipelineModule = await import(pathToFileURL(path.resolve("src/lib/topic-pipeline.ts")).href);
const { finalizeTimelineForPersistence, timelinePipelineInternals } = topicPipelineModule;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countDuplicateDates(topics) {
  const counts = new Map();
  for (const topic of topics) {
    if (!topic.startDate) continue;
    counts.set(topic.startDate, (counts.get(topic.startDate) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1);
}

function runFinalizeFixture(fixture) {
  const result = finalizeTimelineForPersistence({
    ...fixture.input,
    topics: fixture.input.topics.map((topic) => ({
      readings: [],
      topics: [],
      ...topic,
    })),
  });
  const labels = result.topics.map((topic) => topic.weekLabel);
  const notes = result.topics.map((topic) => topic.notes ?? "");
  const instructionalNotes = result.topics
    .filter((topic) => !/spring break|academic break|reading days|bye week|no class/i.test(`${topic.weekLabel} ${topic.notes ?? ""}`))
    .map((topic) => topic.notes ?? "");
  const breakDates = result.topics
    .filter((topic) => /spring break|academic break|reading days|bye week|no class/i.test(`${topic.weekLabel} ${topic.notes ?? ""}`))
    .map((topic) => topic.startDate)
    .filter(Boolean);

  if (fixture.expect.topicCount != null) {
    assert(result.topics.length === fixture.expect.topicCount, `${fixture.name}: expected ${fixture.expect.topicCount} topics, got ${result.topics.length}`);
  }
  if (fixture.expect.noDuplicateDates) {
    assert(countDuplicateDates(result.topics).length === 0, `${fixture.name}: duplicate dated topics remain`);
  }
  if (fixture.expect.breakDates) {
    for (const date of fixture.expect.breakDates) {
      assert(breakDates.includes(date), `${fixture.name}: missing break date ${date}`);
    }
  }
  if (fixture.expect.labelsPresent) {
    for (const label of fixture.expect.labelsPresent) {
      assert(labels.includes(label), `${fixture.name}: missing label "${label}"`);
    }
  }
  if (fixture.expect.labelsAbsent) {
    for (const label of fixture.expect.labelsAbsent) {
      assert(!labels.includes(label), `${fixture.name}: unexpected label "${label}"`);
    }
  }
  if (fixture.expect.notesAbsentContains) {
    for (const snippet of fixture.expect.notesAbsentContains) {
      assert(notes.every((note) => !note.includes(snippet)), `${fixture.name}: unexpected note snippet "${snippet}" remained`);
    }
  }
  if (fixture.expect.instructionalNotesAbsentContains) {
    for (const snippet of fixture.expect.instructionalNotesAbsentContains) {
      assert(instructionalNotes.every((note) => !note.includes(snippet)), `${fixture.name}: instructional note still contains "${snippet}"`);
    }
  }
  if (fixture.expect.repairActionsInclude) {
    for (const action of fixture.expect.repairActionsInclude) {
      assert(result.repairActionsApplied.some((item) => item.startsWith(action)), `${fixture.name}: missing repair action "${action}"`);
    }
  }
  if (fixture.expect.timelineQuality) {
    assert(result.timelineQuality === fixture.expect.timelineQuality, `${fixture.name}: expected quality ${fixture.expect.timelineQuality}, got ${result.timelineQuality}`);
  }
}

function runScaffoldFixture(fixture) {
  const result = timelinePipelineInternals.organizeModulesAsTimeline(
    fixture.input.contentModules,
    [],
    fixture.input.courseName,
    fixture.input.termStartDate,
    fixture.input.termEndDate,
  );
  const labels = result.map((topic) => topic.weekLabel);
  const startDates = result.map((topic) => topic.startDate).filter(Boolean);

  if (fixture.expect.topicCount != null) {
    assert(result.length === fixture.expect.topicCount, `${fixture.name}: expected ${fixture.expect.topicCount} scaffold topics, got ${result.length}`);
  }
  if (fixture.expect.startDates) {
    for (const date of fixture.expect.startDates) {
      assert(startDates.includes(date), `${fixture.name}: missing scaffold start date ${date}`);
    }
  }
  if (fixture.expect.labelsPresent) {
    for (const label of fixture.expect.labelsPresent) {
      assert(labels.includes(label), `${fixture.name}: missing scaffold label "${label}"`);
    }
  }
}

function runWeekScaffoldFixture(fixture) {
  const { buildWeekScaffold, classifyAnchorsFromAI, mapContentOntoScaffold } = timelinePipelineInternals;

  // Build scaffold
  const scaffold = buildWeekScaffold(fixture.input.scaffoldArgs);

  if (fixture.expect.scaffoldWeeks != null) {
    assert(scaffold.length === fixture.expect.scaffoldWeeks, `${fixture.name}: expected ${fixture.expect.scaffoldWeeks} scaffold weeks, got ${scaffold.length}`);
  } else {
    assert(scaffold.length > 0, `${fixture.name}: scaffold is empty`);
  }
  if (fixture.expect.firstWeekStart) {
    assert(scaffold[0]?.weekStartDate === fixture.expect.firstWeekStart, `${fixture.name}: expected first scaffold week ${fixture.expect.firstWeekStart}, got ${scaffold[0]?.weekStartDate}`);
  }
  if (fixture.expect.lastWeekStart) {
    assert(scaffold[scaffold.length - 1]?.weekStartDate === fixture.expect.lastWeekStart, `${fixture.name}: expected last scaffold week ${fixture.expect.lastWeekStart}, got ${scaffold[scaffold.length - 1]?.weekStartDate}`);
  }

  // Pre-AI checks
  if (fixture.expect.preAI) {
    const { instructionalCount, hasFinalExamWeeks } = fixture.expect.preAI;
    if (instructionalCount != null) {
      const actual = scaffold.filter((w) => w.isInstructional).length;
      assert(actual === instructionalCount, `${fixture.name}: pre-AI instructional count: expected ${instructionalCount}, got ${actual}`);
    }
    if (hasFinalExamWeeks) {
      const finalsWeeks = scaffold.filter((w) => w.hasFinalExam).map((w) => w.weekStartDate);
      for (const date of hasFinalExamWeeks) {
        assert(finalsWeeks.includes(date), `${fixture.name}: pre-AI missing hasFinalExam week ${date}`);
      }
    }
  }

  // Post-AI reclassification
  if (fixture.input.aiTopics) {
    classifyAnchorsFromAI(scaffold, fixture.input.aiTopics);
  }

  if (fixture.expect.postAI) {
    const { instructionalCount, nonInstructionalCount, nonInstructionalWeeks, evidenceUpgrades } = fixture.expect.postAI;
    if (instructionalCount != null) {
      const actual = scaffold.filter((w) => w.isInstructional).length;
      assert(actual === instructionalCount, `${fixture.name}: post-AI instructional count: expected ${instructionalCount}, got ${actual}`);
    }
    if (nonInstructionalCount != null) {
      const actual = scaffold.filter((w) => !w.isInstructional).length;
      assert(actual === nonInstructionalCount, `${fixture.name}: post-AI non-instructional count: expected ${nonInstructionalCount}, got ${actual}`);
    }
    if (nonInstructionalWeeks) {
      const actual = scaffold.filter((w) => !w.isInstructional).map((w) => w.weekStartDate);
      for (const date of nonInstructionalWeeks) {
        assert(actual.includes(date), `${fixture.name}: expected non-instructional week ${date} not found`);
      }
    }
    if (evidenceUpgrades) {
      for (const { weekStartDate, expectedEvidence } of evidenceUpgrades) {
        const sw = scaffold.find((w) => w.weekStartDate === weekStartDate);
        assert(sw, `${fixture.name}: evidence upgrade check — week ${weekStartDate} not found`);
        assert(sw.evidence === expectedEvidence, `${fixture.name}: week ${weekStartDate} evidence: expected ${expectedEvidence}, got ${sw.evidence}`);
      }
    }
  }

  // Content mapping
  if (fixture.input.aiTopics && fixture.expect.mapped) {
    const mapped = mapContentOntoScaffold(
      scaffold,
      fixture.input.aiTopics,
      fixture.input.scaffoldArgs.courseName ?? "TestCourse",
      fixture.input.rowSemantics ?? "sequence_number",
    );
    if (fixture.expect.mapped.totalRows != null) {
      assert(mapped.length === fixture.expect.mapped.totalRows, `${fixture.name}: mapped rows: expected ${fixture.expect.mapped.totalRows}, got ${mapped.length}`);
    }
    if (fixture.expect.mapped.contentRows != null) {
      const actual = mapped.filter((t) => t._scaffoldRole === "content").length;
      assert(actual === fixture.expect.mapped.contentRows, `${fixture.name}: content rows: expected ${fixture.expect.mapped.contentRows}, got ${actual}`);
    }
    if (fixture.expect.mapped.breakRows != null) {
      const actual = mapped.filter((t) => t._scaffoldRole === "break").length;
      assert(actual === fixture.expect.mapped.breakRows, `${fixture.name}: break rows: expected ${fixture.expect.mapped.breakRows}, got ${actual}`);
    }
    if (fixture.expect.mapped.emptyRows != null) {
      const actual = mapped.filter((t) => t._scaffoldRole === "empty").length;
      assert(actual === fixture.expect.mapped.emptyRows, `${fixture.name}: empty rows: expected ${fixture.expect.mapped.emptyRows}, got ${actual}`);
    }
    if (fixture.expect.mapped.allDated) {
      const undated = mapped.filter((t) => !t.startDate);
      assert(undated.length === 0, `${fixture.name}: ${undated.length} mapped rows have no startDate`);
    }
  }
}

/**
 * End-to-end scaffold fixture: runs the full chain from scaffold-annotated topics
 * through finalizeTimelineForPersistence → buildTimelineSpine → mergeContentOntoSpine.
 * This covers orchestrator wiring, finalization skipping, scaffold-driven spine,
 * and provenance encoding — the path not reached by internal-only fixtures.
 */
function runScaffoldE2EFixture(fixture) {
  const {
    buildWeekScaffold, classifyAnchorsFromAI, mapContentOntoScaffold,
    finalizeTimelineForPersistence: finalize,
    buildTimelineSpine, mergeContentOntoSpine,
  } = timelinePipelineInternals;

  // Stage 2c: build scaffold
  const scaffold = buildWeekScaffold(fixture.input.scaffoldArgs);
  assert(scaffold.length > 0, `${fixture.name}: scaffold is empty`);

  // Stage 3c: classify + map
  classifyAnchorsFromAI(scaffold, fixture.input.aiTopics);
  const mapped = mapContentOntoScaffold(
    scaffold,
    fixture.input.aiTopics,
    fixture.input.courseName,
    fixture.input.rowSemantics ?? "sequence_number",
  );

  // Stage 6: finalize (with usedWeekScaffold = true)
  const finalized = finalize({
    topics: mapped,
    termStartDate: fixture.input.scaffoldArgs.termStartDate,
    termEndDate: fixture.input.scaffoldArgs.termEndDate,
    courseName: fixture.input.courseName,
    timelineSource: "syllabus",
    lectureCalendarSource: fixture.input.scaffoldArgs.lectureCalendarSource,
    usedModuleScaffold: false,
    hasTimelineAuthority: true,
    usedWeekScaffold: true,
  });

  // Verify finalization skipped break splitting/insertion
  if (fixture.expect.finalize) {
    if (fixture.expect.finalize.topicCount != null) {
      assert(finalized.topics.length === fixture.expect.finalize.topicCount,
        `${fixture.name}: finalized topic count: expected ${fixture.expect.finalize.topicCount}, got ${finalized.topics.length}`);
    }
    if (fixture.expect.finalize.noBreakRepairs) {
      const breakRepairs = finalized.repairActionsApplied.filter(
        (a) => a.startsWith("split_mixed_break") || a.startsWith("inserted_gap_break"),
      );
      assert(breakRepairs.length === 0,
        `${fixture.name}: scaffold path should skip break repairs, but got: ${breakRepairs.join(", ")}`);
    }
    if (fixture.expect.finalize.timelineQuality) {
      assert(finalized.timelineQuality === fixture.expect.finalize.timelineQuality,
        `${fixture.name}: quality: expected ${fixture.expect.finalize.timelineQuality}, got ${finalized.timelineQuality}`);
    }
  }

  // Stage 7: spine + merge
  const spine = buildTimelineSpine({
    topics: finalized.topics,
    hasTimelineAuthority: true,
    usedModuleScaffold: false,
    lectureCalendarSource: fixture.input.scaffoldArgs.lectureCalendarSource,
    sourceRefs: [],
    usedWeekScaffold: true,
    weekScaffold: scaffold,
  });

  const synthesized = mergeContentOntoSpine({
    spine,
    topics: finalized.topics,
    timelineSource: "syllabus",
    contentSource: "syllabus",
    lectureCalendarSource: fixture.input.scaffoldArgs.lectureCalendarSource,
    sourceRefs: [],
    usedModuleScaffold: false,
    usedWeekScaffold: true,
    validationWarnings: [],
  });

  // Verify spine
  if (fixture.expect.spine) {
    if (fixture.expect.spine.scheduleMode) {
      assert(spine.scheduleMode === fixture.expect.spine.scheduleMode,
        `${fixture.name}: scheduleMode: expected ${fixture.expect.spine.scheduleMode}, got ${spine.scheduleMode}`);
    }
    if (fixture.expect.spine.anchorCount != null) {
      assert(spine.anchors.length === fixture.expect.spine.anchorCount,
        `${fixture.name}: anchor count: expected ${fixture.expect.spine.anchorCount}, got ${spine.anchors.length}`);
    }
    if (fixture.expect.spine.breakAnchors != null) {
      const actual = spine.anchors.filter((a) => a.anchorType === "break").length;
      assert(actual === fixture.expect.spine.breakAnchors,
        `${fixture.name}: break anchors: expected ${fixture.expect.spine.breakAnchors}, got ${actual}`);
    }
    if (fixture.expect.spine.allDated) {
      const undated = spine.anchors.filter((a) => !a.anchorDate);
      assert(undated.length === 0,
        `${fixture.name}: ${undated.length} anchors have no date`);
    }
  }

  // Verify synthesized topics
  if (fixture.expect.synthesized) {
    if (fixture.expect.synthesized.count != null) {
      assert(synthesized.length === fixture.expect.synthesized.count,
        `${fixture.name}: synthesized count: expected ${fixture.expect.synthesized.count}, got ${synthesized.length}`);
    }
    if (fixture.expect.synthesized.scaffoldProvenanceCount != null) {
      const actual = synthesized.filter((t) => t.provenance?.usedWeekScaffold === true).length;
      assert(actual === fixture.expect.synthesized.scaffoldProvenanceCount,
        `${fixture.name}: scaffold provenance count: expected ${fixture.expect.synthesized.scaffoldProvenanceCount}, got ${actual}`);
    }
    if (fixture.expect.synthesized.scaffoldRoles) {
      const roles = { content: 0, break: 0, empty: 0 };
      for (const t of synthesized) {
        const role = t.provenance?.scaffoldRole;
        if (role === "content") roles.content++;
        else if (role === "break") roles.break++;
        else if (role === "empty") roles.empty++;
      }
      for (const [role, expected] of Object.entries(fixture.expect.synthesized.scaffoldRoles)) {
        assert(roles[role] === expected,
          `${fixture.name}: scaffoldRole "${role}": expected ${expected}, got ${roles[role]}`);
      }
    }
    if (fixture.expect.synthesized.breakConfidenceHigh) {
      const breakTopics = synthesized.filter((t) => t.provenance?.scaffoldRole === "break");
      for (const bt of breakTopics) {
        assert(bt.contentConfidence === "high",
          `${fixture.name}: break topic "${bt.weekLabel}" has contentConfidence "${bt.contentConfidence}", expected "high"`);
      }
    }
    if (fixture.expect.synthesized.emptyConfidenceLow) {
      const emptyTopics = synthesized.filter((t) => t.provenance?.scaffoldRole === "empty");
      for (const et of emptyTopics) {
        assert(et.contentConfidence === "low",
          `${fixture.name}: empty topic "${et.weekLabel}" has contentConfidence "${et.contentConfidence}", expected "low"`);
      }
    }
  }
}

function runLectureCalendarFixture(fixture) {
  const scheduleEvidence = fixture.input.scheduleEvidence
    ?? (fixture.input.candidates
      ? timelinePipelineInternals.extractScheduleEvidence(
        fixture.input.candidates,
        fixture.input.termStartDate,
        fixture.input.termEndDate,
      )
      : undefined);
  const result = timelinePipelineInternals.buildLectureCalendar(
    fixture.input.classSchedule,
    fixture.input.termStartDate,
    fixture.input.termEndDate,
    fixture.input.assignments,
    fixture.input.syllabusEvents ?? [],
    scheduleEvidence,
  );

  if (fixture.expect.source) {
    assert(result.source === fixture.expect.source, `${fixture.name}: expected source ${fixture.expect.source}, got ${result.source}`);
  }
  if (fixture.expect.firstWeekStart) {
    assert(result.weeks[0]?.startDate === fixture.expect.firstWeekStart, `${fixture.name}: expected first week ${fixture.expect.firstWeekStart}, got ${result.weeks[0]?.startDate}`);
  }
  if (fixture.expect.lastWeekStart) {
    assert(result.weeks[result.weeks.length - 1]?.startDate === fixture.expect.lastWeekStart, `${fixture.name}: expected last week ${fixture.expect.lastWeekStart}, got ${result.weeks[result.weeks.length - 1]?.startDate}`);
  }
  if (fixture.expect.weeksInclude) {
    const starts = result.weeks.map((week) => week.startDate);
    for (const date of fixture.expect.weeksInclude) {
      assert(starts.includes(date), `${fixture.name}: missing lecture-calendar week ${date}`);
    }
  }
}

function runMergeSpineFixture(fixture) {
  const { buildTimelineSpine, mergeContentOntoSpine } = timelinePipelineInternals;
  const spine = buildTimelineSpine(fixture.input.spineArgs);
  const synthesized = mergeContentOntoSpine({
    spine,
    topics: fixture.input.topics,
    timelineSource: fixture.input.timelineSource ?? "syllabus",
    contentSource: fixture.input.contentSource ?? "syllabus",
    lectureCalendarSource: fixture.input.lectureCalendarSource ?? "none",
    sourceRefs: fixture.input.sourceRefs ?? [],
    usedModuleScaffold: fixture.input.usedModuleScaffold ?? false,
    usedWeekScaffold: fixture.input.usedWeekScaffold ?? false,
    validationWarnings: fixture.input.validationWarnings ?? [],
  });

  if (fixture.expect.scaffoldRoles) {
    const actual = synthesized.map((topic) => topic.provenance?.scaffoldRole ?? null);
    assert(
      JSON.stringify(actual) === JSON.stringify(fixture.expect.scaffoldRoles),
      `${fixture.name}: expected scaffold roles ${JSON.stringify(fixture.expect.scaffoldRoles)}, got ${JSON.stringify(actual)}`,
    );
  }
  if (fixture.expect.contentConfidences) {
    const actual = synthesized.map((topic) => topic.contentConfidence);
    assert(
      JSON.stringify(actual) === JSON.stringify(fixture.expect.contentConfidences),
      `${fixture.name}: expected content confidences ${JSON.stringify(fixture.expect.contentConfidences)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function runNormalizeNumberingFixture(fixture) {
  const result = timelinePipelineInternals.normalizeExtractedTopicNumbers(
    fixture.input.topics,
    fixture.input.rowSemantics,
  );

  if (fixture.expect.weekNumbers) {
    const actual = result.map((topic) => topic.weekNumber);
    assert(
      JSON.stringify(actual) === JSON.stringify(fixture.expect.weekNumbers),
      `${fixture.name}: expected week numbers ${JSON.stringify(fixture.expect.weekNumbers)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const fixturesDir = path.join(__dirname, "fixtures", "timeline");
  const files = fs.readdirSync(fixturesDir).filter((file) => file.endsWith(".json")).sort();

  for (const file of files) {
    const fullPath = path.join(fixturesDir, file);
    const fixture = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    if (fixture.kind === "finalize") {
      runFinalizeFixture(fixture);
    } else if (fixture.kind === "scaffold") {
      runScaffoldFixture(fixture);
    } else if (fixture.kind === "lecture-calendar") {
      runLectureCalendarFixture(fixture);
    } else if (fixture.kind === "normalize-numbering") {
      runNormalizeNumberingFixture(fixture);
    } else if (fixture.kind === "merge-spine") {
      runMergeSpineFixture(fixture);
    } else if (fixture.kind === "week-scaffold") {
      runWeekScaffoldFixture(fixture);
    } else if (fixture.kind === "scaffold-e2e") {
      runScaffoldE2EFixture(fixture);
    } else {
      throw new Error(`Unknown fixture kind in ${file}`);
    }
  }

  console.log(`Topic pipeline fixture checks passed (${files.length} fixtures).`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
