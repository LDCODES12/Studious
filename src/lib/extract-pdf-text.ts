"use client";

import { analyzeCalendarGrid } from "./pdf-calendar-grid";

export async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");

  // Use local worker file served from /public
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(extractPageText(content.items));
  }

  return pages.join("\n\n");
}

/**
 * Extract text from one page's items with layout awareness.
 * Mirrors the logic in extension/offscreen.js extractPageText:
 *   1. Try cell-aware calendar grid extraction
 *   2. If grid-like, skip two-column split → line-aware assembly
 *   3. Otherwise, two-column detection → line-aware assembly
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPageText(items: any[]): string {
  const textItems = items.filter(
    (it: { str?: string }) => "str" in it && (it.str ?? "").trim().length > 0,
  );
  if (textItems.length === 0) return "";

  // ── Calendar grid analysis (three-tier fallback) ────────────────────────────
  const gridItems = textItems.map((it: { transform: number[]; width?: number; str: string }) => ({
    x: it.transform[4],
    y: it.transform[5],
    w: it.width ?? 0,
    str: it.str,
  }));
  const analysis = analyzeCalendarGrid(gridItems);

  if (analysis.kind === "grid") return analysis.text;
  if (analysis.kind === "grid-like") return assembleLines(textItems);

  // ── Two-column detection (same logic as offscreen.js) ───────────────────────
  const xs = textItems
    .map((it: { transform: number[] }) => it.transform[4])
    .sort((a: number, b: number) => a - b);
  const xRange = xs[xs.length - 1] - xs[0];

  if (xRange > 180 && textItems.length > 20) {
    let maxGap = 0;
    let gapAt = -1;
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1];
      if (gap > maxGap) {
        maxGap = gap;
        gapAt = i;
      }
    }

    if (
      maxGap / xRange > 0.15 &&
      gapAt > textItems.length * 0.25 &&
      gapAt < textItems.length * 0.75
    ) {
      const columnBoundary = (xs[gapAt - 1] + xs[gapAt]) / 2;
      const left = textItems.filter(
        (it: { transform: number[] }) => it.transform[4] <= columnBoundary,
      );
      const right = textItems.filter(
        (it: { transform: number[] }) => it.transform[4] > columnBoundary,
      );
      return [assembleLines(left), assembleLines(right)]
        .filter(Boolean)
        .join("\n");
    }
  }

  return assembleLines(textItems);
}

/**
 * Group text items by rounded Y coordinate and join left-to-right.
 * Inserts tabs for gaps > 15pt (table column boundaries).
 * Same logic as extension/offscreen.js assembleLines.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assembleLines(items: any[]): string {
  const lineMap = new Map<number, { x: number; str: string; w: number }[]>();
  for (const item of items) {
    const y = Math.round(item.transform[5]);
    const x: number = item.transform[4];
    if (!lineMap.has(y)) lineMap.set(y, []);
    lineMap.get(y)!.push({ x, str: item.str, w: item.width ?? 0 });
  }

  return [...lineMap.entries()]
    .sort((a, b) => b[0] - a[0]) // descending Y = top first
    .map(([, parts]) => {
      parts.sort((a, b) => a.x - b.x);
      if (parts.length === 0) return "";
      let line = parts[0].str;
      for (let i = 1; i < parts.length; i++) {
        const prev = parts[i - 1];
        const gap = parts[i].x - (prev.x + prev.w);
        line += gap > 15 ? "\t" : "";
        line += parts[i].str;
      }
      return line.trim();
    })
    .filter(Boolean)
    .join("\n");
}
