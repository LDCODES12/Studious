/**
 * background.js — Manifest V3 service worker.
 *
 * Two-phase sync flow:
 *   Phase 1: clear window.__sc_selectedIds → inject content.js → receives CANVAS_COURSES
 *            → sends COURSE_SELECTION to popup for user to pick
 *   Phase 2: popup sends SYNC_SELECTED → set window.__sc_selectedIds → re-inject content.js
 *            → receives CANVAS_DATA → extract PDF text via offscreen doc → POST to Study Circle
 *
 * Phase info is passed via window.__sc_selectedIds (set by inline executeScript),
 * not chrome.storage.session, to avoid MV3 service worker dormancy timing issues.
 *
 * PDF extraction: content.js sends PDF URLs (not binary data). We create a
 * Chrome Offscreen Document that runs pdfjs-dist to fetch + extract text from
 * each URL, then we include the extracted text in the payload sent to the server.
 * The server does zero PDF processing — it receives plain text only.
 */

// ── Alarm for auto-sync ───────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "autoSync") startPhase1();
});

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === "SYNC_START") {
    sendResponse({ ok: true });
    startPhase1();
  }

  if (msg.type === "SYNC_SELECTED") {
    // User chose courses in popup — kick off phase 2
    startPhase2(msg.selectedIds);
  }

  if (msg.type === "SYNC_PROGRESS") broadcastToPopup(msg);
  if (msg.type === "CANVAS_COURSES") handleCourseList(msg.courses);
  if (msg.type === "CANVAS_DATA")    handleCanvasData(msg.payload);
  if (msg.type === "SYNC_ERROR")     handleError(msg.error);

  return false;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCanvasTabId() {
  const { canvasUrl } = await chrome.storage.local.get(["canvasUrl"]);
  const canvasOrigin  = `https://${canvasUrl}`;
  const tabs = await chrome.tabs.query({ url: `${canvasOrigin}/*` });

  if (tabs.length > 0) return tabs[0].id;

  broadcastToPopup({ type: "SYNC_PROGRESS", percent: 5, label: "Opening Canvas…" });
  const tab = await chrome.tabs.create({ url: canvasOrigin, active: false });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Canvas took too long to load")), 30000);
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tab.id && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });

  return tab.id;
}

// ── Offscreen document management ────────────────────────────────────────────

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

/**
 * Create the offscreen document if it doesn't already exist.
 * The document persists until closeOffscreen() is called.
 */
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [OFFSCREEN_URL],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: "Extract text from Canvas syllabus PDFs using pdfjs-dist",
  });
}

/** Close the offscreen document when we no longer need it. */
async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch { /* already closed or never opened */ }
}

/**
 * Ask the offscreen document to fetch `url` and extract its text via pdfjs.
 * Returns empty string on any error or if it exceeds the 20s per-file timeout.
 *
 * Each call gets a unique messageId so concurrent calls don't cross-wire.
 */
function parsePdfViaOffscreen(url, messageId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve("");
    }, 30_000);

    function listener(msg) {
      if (msg.type !== "PDF_PARSED" || msg.messageId !== messageId) return;
      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(timer);
      resolve(msg.text ?? "");
    }

    chrome.runtime.onMessage.addListener(listener);
    // Send to the offscreen document (it's the only listener for PARSE_PDF)
    chrome.runtime.sendMessage({ type: "PARSE_PDF", url, messageId });
  });
}

// ── Phase 1: fetch course list ────────────────────────────────────────────────
async function startPhase1() {
  await chrome.storage.session.set({ syncRunning: true });
  try {
    const { canvasUrl, scUrl, apiToken } =
      await chrome.storage.local.get(["canvasUrl", "scUrl", "apiToken"]);
    if (!canvasUrl || !scUrl || !apiToken) throw new Error("Extension not fully configured.");

    const tabId = await getCanvasTabId();
    broadcastToPopup({ type: "SYNC_PROGRESS", percent: 15, label: "Fetching your courses…" });

    // Clear any stale selection, then inject content.js for Phase 1
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { delete window.__sc_selectedIds; },
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    await chrome.storage.session.set({ syncRunning: false });
    handleError(err.message ?? String(err));
  }
}

// ── Receive course list → send to popup for selection ─────────────────────────
async function handleCourseList(courses) {
  // Stash courses so phase 2 can reference them if needed
  await chrome.storage.session.set({ pendingCourses: courses });
  broadcastToPopup({ type: "COURSE_SELECTION", courses });
}

// ── Phase 2: fetch full data for selected courses ─────────────────────────────
async function startPhase2(selectedIds) {
  try {
    const tabId = await getCanvasTabId();
    broadcastToPopup({ type: "SYNC_PROGRESS", percent: 10, label: "Syncing selected courses…" });

    // Pass selected IDs to content.js via window variable, then inject
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (ids) => { window.__sc_selectedIds = ids; },
      args: [selectedIds],
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    await chrome.storage.session.set({ syncRunning: false });
    handleError(err.message ?? String(err));
  }
}

// ── Handle full Canvas payload → extract PDFs → POST to Study Circle ──────────
async function handleCanvasData(payload) {
  try {
    const { scUrl, apiToken } = await chrome.storage.local.get(["scUrl", "apiToken"]);

    // ── Step 1: Extract text from all PDF URLs via the offscreen document ─────
    // Count total PDFs across all courses so we can show accurate progress.
    const totalPdfs = payload.courses.reduce(
      (sum, c) => sum + (c.syllabusFileUrls?.length ?? 0), 0
    );

    if (totalPdfs > 0) {
      broadcastToPopup({
        type: "SYNC_PROGRESS",
        percent: 88,
        label: `Extracting text from ${totalPdfs} syllabus PDF${totalPdfs !== 1 ? "s" : ""}…`,
      });

      await ensureOffscreen();

      // Process all courses in parallel; within each course, process files
      // sequentially to avoid flooding the offscreen doc with concurrent messages.
      await Promise.all(
        payload.courses.map(async (course) => {
          const fileUrls = course.syllabusFileUrls ?? [];
          const syllabusTexts = [];

          for (const { fileName, url } of fileUrls) {
            const messageId = crypto.randomUUID();
            const text = await parsePdfViaOffscreen(url, messageId);
            syllabusTexts.push({ fileName, text });
          }

          // Replace syllabusFileUrls with syllabusTexts in place
          course.syllabusTexts  = syllabusTexts;
          delete course.syllabusFileUrls;
        })
      );

      await closeOffscreen();
    } else {
      // No PDFs — still clean up the field so the server type is consistent
      for (const course of payload.courses) {
        course.syllabusTexts = [];
        delete course.syllabusFileUrls;
      }
    }

    // ── Step 2: Let user know AI analysis is starting ─────────────────────────
    const courseCount = payload.courses?.length ?? 0;
    broadcastToPopup({
      type: "SYNC_PROGRESS",
      percent: 93,
      label: courseCount > 0
        ? `AI is reading ${courseCount} syllab${courseCount !== 1 ? "i" : "us"}… (may take ~60s)`
        : "Saving to Study Circle…",
    });

    // ── Step 3: POST the enriched payload to Study Circle ────────────────────
    const res = await fetch(`https://${scUrl}/api/canvas/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Study Circle API error (${res.status})`);
    }

    const result = await res.json();
    await chrome.storage.session.set({ syncRunning: false });
    await chrome.storage.session.remove(["pendingCourses"]);
    broadcastToPopup({ type: "SYNC_COMPLETE", result });

  } catch (err) {
    await closeOffscreen();
    await chrome.storage.session.set({ syncRunning: false });
    handleError(err.message ?? String(err));
  }
}

function handleError(message) {
  chrome.storage.session.set({ syncRunning: false });
  broadcastToPopup({ type: "SYNC_ERROR", error: message });
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup may be closed */ });
}
