/**
 * check-pdf-grid-fixtures.mjs — Test runner for pdf-calendar-grid fixtures.
 *
 * Loads all JSON fixtures from scripts/fixtures/pdf-grid/,
 * calls analyzeCalendarGrid() on each, and asserts expected outcomes.
 *
 * Usage: node --experimental-strip-types scripts/check-pdf-grid-fixtures.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const gridModule = await import(
  pathToFileURL(path.resolve("src/lib/pdf-calendar-grid.ts")).href
);
const { analyzeCalendarGrid } = gridModule;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const fixtureDir = path.resolve("scripts/fixtures/pdf-grid");
const files = fs.readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));

let passed = 0;
let failed = 0;

for (const file of files) {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, file), "utf-8"),
  );
  const { name, items, expected } = fixture;

  try {
    const result = analyzeCalendarGrid(items);

    // Assert kind
    assert(
      result.kind === expected.kind,
      `kind: got "${result.kind}", expected "${expected.kind}"`,
    );

    // Assert columnCount if expected
    if (expected.columnCount !== undefined && result.kind === "grid") {
      assert(
        result.columnCount === expected.columnCount,
        `columnCount: got ${result.columnCount}, expected ${expected.columnCount}`,
      );
    }

    // Assert rowBandCount if expected
    if (expected.rowBandCount !== undefined && result.kind === "grid") {
      assert(
        result.rowBandCount === expected.rowBandCount,
        `rowBandCount: got ${result.rowBandCount}, expected ${expected.rowBandCount}`,
      );
    }

    // Content assertions for the Reading Days page
    if (name === "chem-1752-page-15" && result.kind === "grid") {
      const bands = result.text.split("\n");

      // Band 1 (Apr 26-May 2): should contain "Reading Days"
      assert(
        bands[1]?.includes("Reading Days"),
        `Band 1 missing "Reading Days": "${bands[1]}"`,
      );

      // Band 2 (May 3-May 9): should contain "Final Exam"
      assert(
        bands[2]?.includes("Final") && bands[2]?.includes("Exam"),
        `Band 2 missing "Final Exam": "${bands[2]}"`,
      );

      // Band 2 should NOT contain "Reading"
      assert(
        !bands[2]?.includes("Reading"),
        `Band 2 has "Reading" bleed from previous band: "${bands[2]}"`,
      );

      // Band 1 should NOT contain "Final"
      assert(
        !bands[1]?.includes("Final"),
        `Band 1 has "Final" bleed from next band: "${bands[1]}"`,
      );
    }

    // Content assertions for page 14 (spring break)
    if (name === "chem-1752-page-14" && result.kind === "grid") {
      const text = result.text;
      assert(
        text.includes("spring break"),
        `Page 14 missing "spring break" in output`,
      );
      assert(
        text.includes("Midterm Exam"),
        `Page 14 missing "Midterm Exam" in output`,
      );
    }

    console.log(
      `  PASS  ${name} — kind=${result.kind}, confidence=${result.confidence.toFixed(3)}` +
        (result.kind === "grid"
          ? `, cols=${result.columnCount}, bands=${result.rowBandCount}`
          : ""),
    );
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name} — ${err.message}`);
    failed++;
  }
}

console.log(
  `\n${passed + failed} fixtures: ${passed} passed, ${failed} failed`,
);

if (failed > 0) process.exit(1);
