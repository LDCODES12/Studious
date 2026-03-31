#!/usr/bin/env node
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function fail(message) {
  throw new Error(message);
}

function countDuplicateDates(topics) {
  const counts = new Map();
  for (const topic of topics) {
    if (!topic.startDate) continue;
    counts.set(topic.startDate, (counts.get(topic.startDate) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1);
}

async function main() {
  const allowedVerificationStatuses = new Set([
    "verified",
    "corroborated",
    "unverified",
    "conflicted",
    "gap",
  ]);
  const allowedSourceBlocks = new Set([
    "schedule_table",
    "syllabus_body",
    "canvas_assignments",
    "canvas_modules",
    null,
  ]);
  const allowedAnchorTypes = new Set([
    "syllabus_verified",
    "syllabus_corroborated",
    "syllabus_unverified",
    "canvas_only",
    "break",
    "conflicted",
  ]);

  const courses = await prisma.course.findMany({
    where: {
      name: {
        in: [
          "Anthropology",
          "Gen Chem 2",
          "Gen Chem 2 Lab",
          "Neuroscience Futures",
          "Physiological Control Systems",
        ],
      },
    },
    select: {
      name: true,
      timelineMode: true,
      topics: {
        orderBy: [{ startDate: "asc" }, { weekNumber: "asc" }],
        select: {
          weekNumber: true,
          weekLabel: true,
          startDate: true,
          topics: true,
          readings: true,
          dateConfidence: true,
          scheduleMode: true,
          verificationStatus: true,
          sourceBlock: true,
        },
      },
      timelineAnchors: {
        orderBy: { sequenceNumber: "asc" },
        select: {
          anchorDate: true,
          anchorType: true,
          isInstructional: true,
        },
      },
      materials: {
        select: {
          fileName: true,
          sourceRole: true,
        },
      },
    },
  });

  const byName = new Map(courses.map((course) => [course.name, course]));

  const anthropology = byName.get("Anthropology");
  if (!anthropology) fail("Missing Anthropology");
  if (anthropology.topics.some((topic) => !allowedVerificationStatuses.has(topic.verificationStatus))) {
    fail("Anthropology has an invalid verificationStatus");
  }
  if (anthropology.timelineMode !== "weekly") {
    fail(`Anthropology timelineMode regressed to ${anthropology.timelineMode}`);
  }
  if (anthropology.topics.length !== 15) {
    fail(`Anthropology should have 15 timeline weeks, found ${anthropology.topics.length}`);
  }
  if (anthropology.topics.some((topic) => topic.startDate === "2026-01-01")) {
    fail("Anthropology still has a bogus 2026-01-01 row");
  }
  if (countDuplicateDates(anthropology.topics).length > 0) {
    fail("Anthropology still has duplicate dated weeks");
  }
  const anthroWeek1 = anthropology.topics.find((topic) => topic.weekNumber === 1);
  if (!anthroWeek1 || anthroWeek1.startDate !== "2026-01-12" || !anthroWeek1.readings.includes("Boas")) {
    fail("Anthropology week 1 lost its expected Jan 12 / Boas grounding");
  }
  const anthroSpringBreak = anthropology.topics.find((topic) => topic.startDate === "2026-03-09");
  if (!anthroSpringBreak || !/spring break/i.test(anthroSpringBreak.weekLabel)) {
    fail("Anthropology is missing the explicit spring break week");
  }
  const anthroWeek12 = anthropology.topics.find((topic) => topic.weekNumber === 12);
  if (
    !anthroWeek12 ||
    !anthroWeek12.topics.some((entry) => /exam 3/i.test(entry)) ||
    !anthroWeek12.readings.includes("Latour")
  ) {
    fail("Anthropology week 12 lost its Exam 3 / Latour structure");
  }

  const pcs = byName.get("Physiological Control Systems");
  if (!pcs) fail("Missing Physiological Control Systems");
  if (pcs.timelineMode === "inferred") {
    fail("PCS is still stuck in inferred mode");
  }
  if (!pcs.topics.some((topic) => topic.startDate === "2026-03-09")) {
    fail("PCS is missing a distinct break week on 2026-03-09");
  }

  const genChem = byName.get("Gen Chem 2");
  if (!genChem) fail("Missing Gen Chem 2");
  if (genChem.topics.some((topic) => !allowedSourceBlocks.has(topic.sourceBlock))) {
    fail("Gen Chem 2 has an invalid sourceBlock");
  }
  if (genChem.topics.length > 20) {
    fail(`Gen Chem 2 regressed into an over-granular timeline (${genChem.topics.length} rows)`);
  }
  if (countDuplicateDates(genChem.topics).length > 0) {
    fail("Gen Chem 2 still has duplicate dated weeks");
  }
  if (genChem.topics.some((topic) => topic.sourceBlock === "schedule_table" && !topic.startDate)) {
    fail("Gen Chem 2 is still committing undated lecture-outline rows as canonical timeline");
  }
  const examStudyOutline = genChem.materials.find((material) => /Exam 1 Study Outline/i.test(material.fileName));
  if (!examStudyOutline || examStudyOutline.sourceRole !== "content") {
    fail("Gen Chem 2 study outline is not classified as content");
  }

  const genChemLab = byName.get("Gen Chem 2 Lab");
  if (!genChemLab) fail("Missing Gen Chem 2 Lab");
  if (countDuplicateDates(genChemLab.topics).length > 0) {
    fail("Gen Chem 2 Lab still has duplicate dated weeks");
  }
  if (!genChemLab.topics.some((topic) => topic.startDate === "2026-03-09")) {
    fail("Gen Chem 2 Lab is missing a standalone spring break week on 2026-03-09");
  }

  const neuro = byName.get("Neuroscience Futures");
  if (!neuro) fail("Missing Neuroscience Futures");
  if (neuro.timelineAnchors.some((anchor) => !allowedAnchorTypes.has(anchor.anchorType))) {
    fail("Neuroscience Futures has an invalid anchorType");
  }

  console.log("Timeline regression checks passed.");
}

main()
  .catch(async (error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
