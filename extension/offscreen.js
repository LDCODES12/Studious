/**
 * offscreen.js — PDF text extraction using pdfjs-dist.
 *
 * Runs in a Chrome Offscreen Document (hidden extension page with full DOM
 * and Worker support). Background.js sends PARSE_PDF messages; we fetch the
 * PDF URL, extract all text with pdfjs-dist, and reply with PDF_PARSED.
 *
 * This mirrors the pattern used in src/lib/extract-pdf-text.ts (web app),
 * adapted for the extension context (worker URL via chrome.runtime.getURL).
 */

import * as pdfjsLib from "./lib/pdf.min.mjs";

// Point pdfjs at the bundled worker file inside the extension package.
// chrome.runtime.getURL gives the full chrome-extension://id/... URL which
// pdfjs uses to spawn a dedicated Web Worker — genuinely non-blocking.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "lib/pdf.worker.min.mjs"
);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "PARSE_PDF") return false;

  const { url, messageId } = msg;

  extractTextFromUrl(url)
    .then((text) => {
      chrome.runtime.sendMessage({ type: "PDF_PARSED", messageId, text });
    })
    .catch(() => {
      chrome.runtime.sendMessage({ type: "PDF_PARSED", messageId, text: "" });
    });

  // Return true to indicate we will respond asynchronously.
  return true;
});

/**
 * Fetch a PDF from `url` and extract its full text using pdfjs-dist.
 * Returns an empty string if the fetch fails or the PDF has no text layer.
 */
async function extractTextFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) return "";

  const arrayBuffer = await response.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(pageText);
  }

  return pages.join("\n\n").trim();
}
