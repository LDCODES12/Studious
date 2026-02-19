/**
 * background.js — Manifest V3 service worker.
 *
 * Two-phase sync flow:
 *   Phase 1: clear window.__sc_selectedIds → inject content.js → receives CANVAS_COURSES
 *            → sends COURSE_SELECTION to popup for user to pick
 *   Phase 2: popup sends SYNC_SELECTED → set window.__sc_selectedIds → re-inject content.js
 *            → receives CANVAS_DATA → POST to Study Circle
 *
 * Phase info is passed via window.__sc_selectedIds (set by inline executeScript),
 * not chrome.storage.session, to avoid MV3 service worker dormancy timing issues.
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

// ── Handle full Canvas payload → POST to Study Circle ─────────────────────────
async function handleCanvasData(payload) {
  try {
    const { scUrl, apiToken } = await chrome.storage.local.get(["scUrl", "apiToken"]);

    // Let user know AI analysis is running — this phase takes 20-40s with syllabus parsing
    const courseCount = payload.courses?.length ?? 0;
    broadcastToPopup({
      type: "SYNC_PROGRESS",
      percent: 93,
      label: courseCount > 0
        ? `AI is reading ${courseCount} syllab${courseCount !== 1 ? "i" : "us"}… (may take ~30s)`
        : "Saving to Study Circle…",
    });

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
