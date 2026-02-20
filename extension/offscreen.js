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
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // Group text items by their Y position so table rows and schedule lines
    // are preserved as separate lines rather than merged into one long string.
    // pdfjs item.transform[5] is the Y coordinate (increases bottom-to-top).
    const lineMap = new Map();
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const y = Math.round(item.transform[5]);
      lineMap.set(y, (lineMap.get(y) ?? "") + item.str);
    }
    // Sort descending (top of page first) then join with newlines
    const pageText = [...lineMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, text]) => text.trim())
      .filter(Boolean)
      .join("\n");
    pages.push(pageText);
  }

  const text = pages.join("\n\n").trim();
  console.log("[offscreen] extracted", text.length, "chars");
  return text;
}
