/**
 * capture-pdf-items.mjs — Dump raw pdfjs TextItem data from a PDF page.
 *
 * Usage:
 *   node scripts/capture-pdf-items.mjs <pdf-path> <page-number> [output-path]
 *
 * Outputs JSON with { x, y, w, str } items for the specified page.
 * If output-path is omitted, writes to stdout.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node scripts/capture-pdf-items.mjs <pdf-path> <page-number> [output-path]");
  process.exit(1);
}

const pdfPath = path.resolve(args[0]);
const pageNumber = parseInt(args[1], 10);
const outputPath = args[2] ? path.resolve(args[2]) : null;

if (!fs.existsSync(pdfPath)) {
  console.error(`PDF not found: ${pdfPath}`);
  process.exit(1);
}
if (isNaN(pageNumber) || pageNumber < 1) {
  console.error(`Invalid page number: ${args[1]}`);
  process.exit(1);
}

// pdfjs-dist legacy build works in Node without canvas
const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

const data = new Uint8Array(fs.readFileSync(pdfPath));
const pdf = await pdfjsLib.getDocument({ data }).promise;

if (pageNumber > pdf.numPages) {
  console.error(`Page ${pageNumber} does not exist (PDF has ${pdf.numPages} pages)`);
  pdf.destroy();
  process.exit(1);
}

const page = await pdf.getPage(pageNumber);
const content = await page.getTextContent();

const items = content.items
  .filter((it) => "str" in it && it.str.trim().length > 0)
  .map((it) => ({
    x: Math.round(it.transform[4] * 100) / 100,
    y: Math.round(it.transform[5] * 100) / 100,
    w: Math.round((it.width ?? 0) * 100) / 100,
    str: it.str,
  }));

console.error(`Page ${pageNumber}: ${items.length} text items extracted from ${pdf.numPages}-page PDF`);

const output = JSON.stringify(items, null, 2);

if (outputPath) {
  fs.writeFileSync(outputPath, output, "utf-8");
  console.error(`Written to ${outputPath}`);
} else {
  console.log(output);
}

pdf.destroy();
