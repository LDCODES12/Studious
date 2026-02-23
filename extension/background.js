/**
 * background.js — Manifest V3 service worker.
 *
 * Two-phase sync flow:
 *   Phase 1: clear window.__sc_selectedIds → inject content.js → receives CANVAS_COURSES
 *            → sends COURSE_SELECTION to popup for user to pick
 *   Phase 2: popup sends SYNC_SELECTED → set window.__sc_selectedIds → re-inject content.js
 *            → receives CANVAS_DATA → extract PDF text via offscreen doc → POST to Study Circle
 *            → scrape Gradescope (all courses) → POST to gradescope/import → SYNC_COMPLETE
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
      (sum, c) => (sum + (c.syllabusFileUrls?.length ?? 0) + (c.materialFileUrls?.length ?? 0)), 0
    );

    if (totalPdfs > 0) {
      broadcastToPopup({
        type: "SYNC_PROGRESS",
        percent: 88,
        label: `Extracting text from ${totalPdfs} syllabus PDF${totalPdfs !== 1 ? "s" : ""}…`,
      });

      // Flatten all PDFs from all courses into one ordered list so the pdfjs
      // worker processes exactly one document at a time. Running multiple pdfjs
      // documents concurrently in the shared worker causes "Invalid page request"
      // errors mid-document because the worker crashes under memory pressure.
      for (const course of payload.courses) {
        course.syllabusTexts = [];
        course.materialTexts = [];
      }

      const allPdfTasks = [];
      for (const course of payload.courses) {
        for (const { fileName, url } of (course.syllabusFileUrls ?? [])) {
          allPdfTasks.push({ course, type: "syllabus", fileName, url });
        }
        for (const { fileName, url } of (course.materialFileUrls ?? [])) {
          allPdfTasks.push({ course, type: "material", fileName, url });
        }
      }

      await ensureOffscreen();

      for (const task of allPdfTasks) {
        const messageId = crypto.randomUUID();
        const t0   = Date.now();
        const text = await parsePdfViaOffscreen(task.url, messageId);
        const ms   = Date.now() - t0;
        if (text.length > 0) {
          console.log(`[worker] ${task.course.name} | ${task.type} "${task.fileName}": ${text.length}c in ${ms}ms`);
        } else {
          console.warn(`[worker] ${task.course.name} | ${task.type} "${task.fileName}": 0 chars after ${ms}ms`);
        }
        if (task.type === "syllabus") {
          task.course.syllabusTexts.push({ fileName: task.fileName, text });
        } else {
          task.course.materialTexts.push({ fileName: task.fileName, text });
        }
      }

      await closeOffscreen();

      for (const course of payload.courses) {
        delete course.syllabusFileUrls;
        delete course.materialFileUrls;
      }
    } else {
      // No PDFs — still clean up fields so the server type is consistent
      for (const course of payload.courses) {
        course.syllabusTexts = [];
        course.materialTexts = [];
        delete course.syllabusFileUrls;
        delete course.materialFileUrls;
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

    // Persist full debug info so it survives popup close.
    if (result.debug) {
      await chrome.storage.local.set({ lastSyncDebug: result.debug });
      console.log("[worker] sync debug saved to chrome.storage.local (key: lastSyncDebug)");
    }

    syncLog("canvas_import_done", { status: res.status });
    syncLog("gs_start");

    // ── Step 4: Scrape Gradescope (all courses) ──────────────────────────────
    // Runs after canvas/import so courses exist in Study Circle for matching.
    // Failure here is non-fatal — Canvas data is already saved.
    try {
      const gsResult = await syncGradescope(scUrl, apiToken);
      if (gsResult) {
        result.gradescope = gsResult;
        syncLog("gs_done", gsResult);
      } else {
        syncLog("gs_skipped", { reason: "null result" });
      }
    } catch (err) {
      syncLog("gs_error", { error: err?.message ?? String(err) });
      console.warn("[worker] Gradescope sync failed (non-fatal):", err?.message ?? err);
    }

    await flushSyncLog(scUrl, apiToken);
    await chrome.storage.session.set({ syncRunning: false });
    await chrome.storage.session.remove(["pendingCourses"]);
    broadcastToPopup({ type: "SYNC_COMPLETE", result });

  } catch (err) {
    syncLog("sync_fatal_error", { error: err?.message ?? String(err) });
    try {
      const { scUrl: u, apiToken: t } = await chrome.storage.local.get(["scUrl", "apiToken"]);
      if (u && t) await flushSyncLog(u, t);
    } catch { /* best-effort */ }
    await closeOffscreen();
    await chrome.storage.session.set({ syncRunning: false });
    handleError(err.message ?? String(err));
  }
}

// ── Gradescope sync (runs after canvas/import during full sync) ───────────────

/**
 * Find or create a Gradescope tab, inject the scraper, wait for data,
 * then POST to the gradescope/import API. Returns the API response or null.
 */
async function syncGradescope(scUrl, apiToken) {
  broadcastToPopup({ type: "SYNC_PROGRESS", percent: 96, label: "Checking Gradescope…" });

  let gsTabId = null;
  let createdTab = false;

  const tabs = await chrome.tabs.query({ url: "https://www.gradescope.com/*" });
  syncLog("gs_tab_query", { existingTabs: tabs.length });

  if (tabs.length > 0) {
    gsTabId = tabs[0].id;
  } else {
    try {
      const tab = await chrome.tabs.create({ url: "https://www.gradescope.com/", active: false });
      createdTab = true;
      syncLog("gs_tab_created", { tabId: tab.id });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Gradescope took too long to load")), 15_000);
        chrome.tabs.onUpdated.addListener(function listener(id, info) {
          if (id === tab.id && info.status === "complete") {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        });
      });
      gsTabId = tab.id;
      syncLog("gs_tab_loaded", { tabId: gsTabId });
    } catch (err) {
      syncLog("gs_tab_error", { error: err?.message });
      return null;
    }
  }

  try {
    syncLog("gs_execute", { tabId: gsTabId });

    // Use executeScript with an inline func that RETURNS the data directly.
    // This avoids the chrome.runtime.sendMessage channel which was silently failing.
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: gsTabId },
      func: async () => {
        const LOG = "[gs-sync]";
        const logs = [];
        function log(step, d) { logs.push({ step, ...d }); console.log(`${LOG} ${step}`, d || ""); }

        function courseNameFromTitle(title) {
          if (!title) return "";
          return title.replace(/\s*[-|]\s*Gradescope\s*$/i, "").trim().split("|").pop().trim();
        }

        function extractAssignments(doc) {
          const rows = doc.querySelectorAll(
            "table.table--assignments tbody tr, table.js-assignmentsTable tbody tr, " +
            "table.table tbody tr, table.js-assignmentTable tbody tr, tbody tr"
          );
          const results = [];
          for (const row of rows) {
            const titleLink = row.querySelector("th a");
            const titleCell = row.querySelector("th");
            const title = titleLink?.textContent?.trim() || titleCell?.textContent?.trim();
            if (!title) continue;

            const gradescopeAssignmentId =
              row.dataset?.assignmentId ||
              row.id?.replace(/^assignment-/, "") ||
              (titleLink ? titleLink.getAttribute("href")?.match(/\/assignments\/(\d+)/)?.[1] : null) ||
              null;

            const cells = Array.from(row.querySelectorAll("td"));
            let score = null, maxScore = null, status = "unsubmitted";
            for (const cell of cells) {
              const ct = cell.textContent?.trim() ?? "";
              const m = ct.match(/([\d.]+)\s*\/\s*([\d.]+)/);
              if (m) { score = parseFloat(m[1]); maxScore = parseFloat(m[2]); status = "graded"; break; }
              const lower = ct.toLowerCase();
              if (lower.includes("graded")) status = "graded";
              else if (lower.includes("submitted") && status !== "graded") status = "submitted";
            }
            results.push({ title, score, maxScore, status, gradescopeAssignmentId });
          }
          return results;
        }

        try {
          log("start", { url: location.href });

          const dashResp = await fetch("https://www.gradescope.com/", {
            credentials: "same-origin", headers: { Accept: "text/html" },
          });
          log("dash_fetch", { status: dashResp.status, ok: dashResp.ok, redirected: dashResp.redirected, url: dashResp.url });

          if (!dashResp.ok) return { courses: [], logs };

          const dashHtml = await dashResp.text();
          log("dash_html", { len: dashHtml.length, snippet: dashHtml.slice(0, 300) });
          const dashDoc = new DOMParser().parseFromString(dashHtml, "text/html");

          const courseMap = new Map();
          for (const a of dashDoc.querySelectorAll('a[href*="/courses/"]')) {
            const href = a.getAttribute("href") ?? "";
            const match = href.match(/\/courses\/(\d+)/);
            if (!match) continue;
            const cid = match[1];
            if (courseMap.has(cid)) continue;
            const name = a.textContent?.trim();
            if (name && name.length > 1) courseMap.set(cid, name);
          }

          log("courses_found", { count: courseMap.size, ids: [...courseMap.keys()] });
          if (courseMap.size === 0) return { courses: [], logs };

          const courses = [];
          for (const [cid, dashName] of courseMap) {
            try {
              const resp = await fetch(`/courses/${cid}/assignments`, {
                credentials: "same-origin", headers: { Accept: "text/html" },
              });
              if (!resp.ok) { log("course_fail", { cid, status: resp.status }); continue; }
              const html = await resp.text();
              const doc = new DOMParser().parseFromString(html, "text/html");
              const courseName = courseNameFromTitle(doc.querySelector("title")?.textContent) || dashName;
              const assignments = extractAssignments(doc);
              log("course_ok", { cid, name: courseName, assignments: assignments.length });
              courses.push({ name: courseName, gradescopeCourseId: cid, assignments });
            } catch (err) {
              log("course_err", { cid, error: err?.message });
            }
          }

          log("done", { courseCount: courses.length });
          return { courses, logs };
        } catch (err) {
          log("fatal", { error: err?.message, stack: err?.stack?.slice(0, 300) });
          return { courses: [], logs };
        }
      },
    });

    const data = result?.result;
    syncLog("gs_exec_result", {
      hasResult: !!data,
      courseCount: data?.courses?.length ?? 0,
      scriptLogs: data?.logs ?? [],
    });

    if (!data?.courses?.length) {
      syncLog("gs_no_courses", { reason: data ? "empty" : "no result" });
      return null;
    }

    syncLog("gs_scraped", {
      courseCount: data.courses.length,
      courses: data.courses.map(c => ({ name: c.name, assignments: c.assignments?.length ?? 0 })),
    });

    const gsRes = await fetch(`https://${scUrl}/api/gradescope/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ courses: data.courses }),
    });

    if (!gsRes.ok) {
      syncLog("gs_api_error", { status: gsRes.status });
      return null;
    }

    const gsResult = await gsRes.json();
    syncLog("gs_api_ok", gsResult);
    return gsResult;

  } finally {
    if (createdTab && gsTabId) {
      try { await chrome.tabs.remove(gsTabId); } catch { /* already closed */ }
    }
  }
}

function handleError(message) {
  chrome.storage.session.set({ syncRunning: false });
  broadcastToPopup({ type: "SYNC_ERROR", error: message });
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup may be closed */ });
}

// ── Persistent sync log ──────────────────────────────────────────────────────
// Accumulates breadcrumbs during a sync, persists to chrome.storage.local,
// and POSTs to the server so logs appear in Vercel for remote debugging.

const _syncLog = [];

function syncLog(step, detail) {
  const entry = { t: Date.now(), step, ...detail };
  _syncLog.push(entry);
  console.log(`[sync-log] ${step}`, detail ? JSON.stringify(detail) : "");
}

async function flushSyncLog(scUrl, apiToken) {
  if (_syncLog.length === 0) return;
  const logs = [..._syncLog];
  _syncLog.length = 0;

  await chrome.storage.local.set({ lastSyncLog: logs });

  try {
    await fetch(`https://${scUrl}/api/extension-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(logs),
    });
  } catch { /* best-effort */ }
}
