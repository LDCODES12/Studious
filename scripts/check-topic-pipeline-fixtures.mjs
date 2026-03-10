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

function runLectureCalendarFixture(fixture) {
  const result = timelinePipelineInternals.buildLectureCalendar(
    fixture.input.classSchedule,
    fixture.input.termStartDate,
    fixture.input.termEndDate,
    fixture.input.assignments,
    fixture.input.syllabusEvents ?? [],
  );

  if (fixture.expect.source) {
    assert(result.source === fixture.expect.source, `${fixture.name}: expected source ${fixture.expect.source}, got ${result.source}`);
  }
  if (fixture.expect.firstWeekStart) {
    assert(result.weeks[0]?.startDate === fixture.expect.firstWeekStart, `${fixture.name}: expected first week ${fixture.expect.firstWeekStart}, got ${result.weeks[0]?.startDate}`);
  }
  if (fixture.expect.weeksInclude) {
    const starts = result.weeks.map((week) => week.startDate);
    for (const date of fixture.expect.weeksInclude) {
      assert(starts.includes(date), `${fixture.name}: missing lecture-calendar week ${date}`);
    }
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
