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
          dateConfidence: true,
          scheduleMode: true,
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
  if (anthropology.topics.some((topic) => topic.startDate === "2026-01-01")) {
    fail("Anthropology still has a bogus 2026-01-01 row");
  }
  if (countDuplicateDates(anthropology.topics).length > 0) {
    fail("Anthropology still has duplicate dated weeks");
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
  if (!genChem.topics.some((topic) => topic.startDate === "2026-03-09" && /break/i.test(topic.weekLabel))) {
    fail("Gen Chem 2 is missing the 2026-03-09 break week");
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
  const sparseMeetings = neuro.timelineAnchors.filter((anchor) => anchor.anchorType === "sparse_meeting");
  if (sparseMeetings.some((anchor) => !anchor.isInstructional)) {
    fail("Neuroscience Futures still has non-instructional sparse anchors");
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
