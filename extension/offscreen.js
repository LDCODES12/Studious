/**
 * offscreen.js — PDF text extraction using pdfjs-dist.
 *
 * Runs in a Chrome Offscreen Document (hidden extension page with full DOM
 * and Worker support). Background.js sends PARSE_PDF messages; we fetch the
 * PDF URL, extract all text with pdfjs-dist, and reply with PDF_PARSED.
 *
 * Key subtlety: pdfjs calls `new Worker(url)` without `{ type: "module" }`,
 * but pdf.worker.min.mjs is an ES module. We patch the global Worker
 * constructor before importing pdfjs so all worker creation uses module mode.
 */

// ── Patch Worker constructor BEFORE pdfjs initialises ────────────────────────
// pdfjs-dist v5 ships only ES module builds; the worker file (.mjs) must be
// loaded as a module worker. pdfjs internally calls `new Worker(url)` without
// type:"module", so we intercept and force it here.
const _OriginalWorker = globalThis.Worker;
globalThis.Worker = class extends _OriginalWorker {
  constructor(url, options) {
    super(url, { ...(options ?? {}), type: "module" });
  }
};

import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "lib/pdf.worker.min.mjs"
);

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type !== "PARSE_PDF") return false;

  const { url, messageId } = msg;

  // Reply via a separate sendMessage (not sendResponse), so we do NOT return
  // true here — returning true would tell Chrome to keep the channel open
  // waiting for sendResponse(), which we never call, causing an uncaught
  // "message channel closed" rejection.
  extractTextFromUrl(url)
    .then((text) => {
      chrome.runtime.sendMessage({ type: "PDF_PARSED", messageId, text });
    })
    .catch((err) => {
      console.error("[offscreen] extraction failed:", err);
      chrome.runtime.sendMessage({ type: "PDF_PARSED", messageId, text: "" });
    });

  return false;
});

// ── PDF text extraction ───────────────────────────────────────────────────────

/**
 * Fetch a PDF from `url` and extract its full text using pdfjs-dist.
 * Returns an empty string if the fetch fails or the PDF has no text layer.
 */
async function extractTextFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    console.warn("[offscreen] fetch failed:", response.status, url);
    return "";
  }

  const arrayBuffer = await response.arrayBuffer();
  console.log("[offscreen] fetched", arrayBuffer.byteLength, "bytes from", url.slice(0, 80));

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  console.log("[offscreen] PDF pages:", pdf.numPages);

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(extractPageText(content.items));
    } catch (pageErr) {
      // Some PDFs have corrupt or null entries in their page tree — skip and continue.
      console.warn(`[offscreen] page ${i}/${pdf.numPages} failed:`, pageErr.message);
    }
  }

  const text = pages.join("\n\n").trim();
  console.log("[offscreen] extracted", text.length, "chars");

  // Warn if text yield is suspiciously low for a multi-page PDF —
  // this usually means a scanned/image PDF with no text layer.
  if (pdf.numPages > 2 && text.length < 300) {
    console.warn("[offscreen] low text yield — PDF may be scanned/image-only:", text.length, "chars for", pdf.numPages, "pages");
  }

  return text;
}

/**
 * PDF Worker — extract text from one page's items with layout awareness.
 *
 * Two-column detection:
 *   Many syllabi are typeset in two columns. pdfjs returns items in stream
 *   order which can interleave left and right columns, producing garbled text.
 *   We detect a two-column layout by looking for a clear horizontal gap in
 *   the X-position distribution, then process each column separately so the
 *   left column text always precedes the right column text.
 *
 * Single-column / table layout:
 *   Items are grouped by their rounded Y coordinate so table rows and schedule
 *   lines stay as separate lines rather than being merged into one long string.
 */
function extractPageText(items) {
  // Filter to real text items only
  const textItems = items.filter((it) => "str" in it && it.str.trim().length > 0);
  if (textItems.length === 0) return "";

  // ── Column detection ────────────────────────────────────────────────────────
  // Collect left-edge X positions, sort them, and look for the biggest gap.
  // pdfjs item.transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
  const xs = textItems.map((it) => it.transform[4]).sort((a, b) => a - b);
  const xRange = xs[xs.length - 1] - xs[0];

  let columnBoundary = null; // X coordinate separating left from right column

  // Skip two-column detection for calendar grid pages (7-column Sun–Sat layout).
  // A calendar grid has ~6 evenly-spaced column boundaries; the biggest-gap
  // heuristic would fire on the middle boundary and split the grid into
  // "left 3.5 days" / "right 3.5 days", destroying the weekly row grouping.
  // Instead we let assembleLines group items by Y (row = one week) and insert
  // tabs between the 7 day cells so the row structure is preserved intact.
  const rawPageText = textItems.map((it) => it.str).join(" ").toLowerCase();
  const dayNameHits = (rawPageText.match(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/g
  ) ?? []).length;
  const isCalendarGrid = dayNameHits >= 5;

  if (!isCalendarGrid && xRange > 180 && textItems.length > 20) {
    // Find the largest gap between consecutive sorted X values
    let maxGap = 0;
    let gapAt  = -1;
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1];
      if (gap > maxGap) { maxGap = gap; gapAt = i; }
    }

    // Only treat as two-column if:
    //   • the gap is at least 15% of the total width (avoids small tab indents)
    //   • the gap splits items roughly in half (each column ≥ 25% of total)
    if (maxGap / xRange > 0.15 && gapAt > textItems.length * 0.25 && gapAt < textItems.length * 0.75) {
      columnBoundary = (xs[gapAt - 1] + xs[gapAt]) / 2;
      console.log("[offscreen] two-column layout detected, boundary X ≈", columnBoundary.toFixed(1));
    }
  }

  if (isCalendarGrid) {
    console.log("[offscreen] calendar grid detected — skipping two-column heuristic, dayNameHits:", dayNameHits);
  }

  // ── Line assembly ───────────────────────────────────────────────────────────
  if (columnBoundary !== null) {
    // Process left column then right column independently; each uses Y-grouping.
    const left  = textItems.filter((it) => it.transform[4] <= columnBoundary);
    const right = textItems.filter((it) => it.transform[4] >  columnBoundary);
    return [assembleLines(left), assembleLines(right)].filter(Boolean).join("\n");
  }

  return assembleLines(textItems);
}

/**
 * Group text items by their Y coordinate (rounded to nearest integer) and
 * join items on the same line in left-to-right order.
 * Returns lines sorted top-to-bottom (descending Y = top of page first).
 *
 * Column-gap detection within a row:
 *   pdfjs gives us item.width (advance width in PDF user units, ≈ points at 72dpi).
 *   When consecutive items on the same line have a gap larger than ~15pt we insert
 *   a tab so schedule table columns ("Week 1 | Jan 13 | Introduction to Calculus")
 *   survive as tab-separated values rather than one undivided blob. detectSourceFormat()
 *   then correctly classifies the output as "tab-separated table" and the AI prompt
 *   hint tells the Extractor exactly how to parse it.
 */
function assembleLines(items) {
  const lineMap = new Map();
  for (const item of items) {
    const y = Math.round(item.transform[5]);
    const x = item.transform[4];
    if (!lineMap.has(y)) lineMap.set(y, { parts: [] });
    // Store x, str, and advance width for gap detection
    lineMap.get(y).parts.push({ x, str: item.str, w: item.width ?? 0 });
  }

  return [...lineMap.entries()]
    .sort((a, b) => b[0] - a[0])               // descending Y = top first
    .map(([, entry]) => {
      const parts = entry.parts.sort((a, b) => a.x - b.x);
      if (parts.length === 0) return "";
      let line = parts[0].str;
      for (let i = 1; i < parts.length; i++) {
        const prev = parts[i - 1];
        // Gap between end of previous item and start of current item (in PDF points)
        const gap = parts[i].x - (prev.x + prev.w);
        // > 15pt gap indicates a table column boundary, not just word spacing.
        // Normal word spacing at 12pt is ~3pt; table gutters are typically 20-80pt.
        line += gap > 15 ? "\t" : "";
        line += parts[i].str;
      }
      return line.trim();
    })
    .filter(Boolean)
    .join("\n");
}
