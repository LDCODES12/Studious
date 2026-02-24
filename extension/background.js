/**
 * background.js — Manifest V3 service worker.
 *
 * Two-phase sync flow:
 *   Phase 1: clear window.__sc_selectedIds → inject content.js → receives CANVAS_COURSES
 *            → sends COURSE_SELECTION to popup for user to pick
 *   Phase 2: popup sends SYNC_SELECTED → set window.__sc_selectedIds → re-inject content.js
 *            → receives CANVAS_DATA → resolve Gradescope IDs from Canvas LTI tabs
 *            → extract PDF text via offscreen doc → POST canvas/import
 *            → scrape Gradescope assignments (linked courses only) → POST gradescope/import
 *            → SYNC_COMPLETE
 *
 * Gradescope integration: content.js discovers Gradescope LTI tabs in Canvas
 * navigation. This background worker navigates to each Canvas LTI URL and reads
 * the Gradescope iframe URL to get the actual course ID — deterministic matching,
 * no fuzzy name heuristics.
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
    const { scUrl, apiToken, canvasUrl } = await chrome.storage.local.get(["scUrl", "apiToken", "canvasUrl"]);

    // ── Step 1: Resolve Gradescope course IDs from Canvas LTI tab URLs ───────
    // content.js stores gradescopeTabUrl (absolute Canvas URL) for courses with
    // a Gradescope navigation tab. We navigate to each URL — Canvas LTI redirects
    // to gradescope.com/courses/XXXX — and read the resulting URL to get the ID.

    const coursesNeedingResolve = payload.courses.filter(
      (c) => !c.gradescopeCourseId && c.gradescopeTabUrl,
    );

    syncLog("gs_detection", {
      total: payload.courses.length,
      directId: payload.courses.filter((c) => c.gradescopeCourseId).length,
      tabUrl: payload.courses.filter((c) => c.gradescopeTabUrl).length,
      needResolve: coursesNeedingResolve.length,
      details: payload.courses.map((c) => ({
        name: c.name,
        gsId: c.gradescopeCourseId ?? null,
        tabUrl: c.gradescopeTabUrl ?? null,
      })),
    });

    if (coursesNeedingResolve.length > 0) {
      broadcastToPopup({ type: "SYNC_PROGRESS", percent: 86, label: "Discovering Gradescope links…" });
      syncLog("gs_resolve_start", { count: coursesNeedingResolve.length });

      let resolveTabId = null;
      let createdResolveTab = false;
      try {
        const existingTabs = await chrome.tabs.query({ url: `https://${canvasUrl}/*` });
        if (existingTabs.length > 0) {
          resolveTabId = existingTabs[0].id;
        } else {
          const tab = await chrome.tabs.create({ url: `https://${canvasUrl}`, active: false });
          createdResolveTab = true;
          resolveTabId = tab.id;
          await waitForTabLoad(resolveTabId);
        }

        for (const course of coursesNeedingResolve) {
          try {
            const gsId = await resolveGradescopeCourseId(resolveTabId, course.gradescopeTabUrl);
            if (gsId) {
              course.gradescopeCourseId = gsId;
              syncLog("gs_resolved", { canvas: course.name, gsId });
            } else {
              syncLog("gs_resolve_fail", { canvas: course.name, url: course.gradescopeTabUrl });
            }
          } catch (err) {
            syncLog("gs_resolve_err", { canvas: course.name, error: err?.message });
          }
        }
        if (createdResolveTab) {
          try { await chrome.tabs.remove(resolveTabId); } catch { /* already closed */ }
        }
      } catch (err) {
        syncLog("gs_resolve_tab_err", { error: err?.message });
      }
    }

    // Clean up — server doesn't need these
    for (const c of payload.courses) delete c.gradescopeTabUrl;

    // ── Step 2: Extract text from all PDF URLs via the offscreen document ─────
    const totalPdfs = payload.courses.reduce(
      (sum, c) => (sum + (c.syllabusFileUrls?.length ?? 0) + (c.materialFileUrls?.length ?? 0)), 0
    );

    if (totalPdfs > 0) {
      broadcastToPopup({
        type: "SYNC_PROGRESS",
        percent: 88,
        label: `Extracting text from ${totalPdfs} syllabus PDF${totalPdfs !== 1 ? "s" : ""}…`,
      });

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
      for (const course of payload.courses) {
        course.syllabusTexts = [];
        course.materialTexts = [];
        delete course.syllabusFileUrls;
        delete course.materialFileUrls;
      }
    }

    // ── Step 3: POST the enriched payload to Study Circle ────────────────────
    const courseCount = payload.courses?.length ?? 0;
    broadcastToPopup({
      type: "SYNC_PROGRESS",
      percent: 93,
      label: courseCount > 0
        ? `AI is reading ${courseCount} syllab${courseCount !== 1 ? "i" : "us"}… (may take ~60s)`
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

    if (result.debug) {
      await chrome.storage.local.set({ lastSyncDebug: result.debug });
    }

    syncLog("canvas_import_done", { status: res.status });

    // ── Step 4: Scrape Gradescope assignments for linked courses ─────────────
    // Only scrapes courses where we successfully resolved a Gradescope ID.
    const gsLinkedCourses = payload.courses.filter((c) => c.gradescopeCourseId);
    if (gsLinkedCourses.length > 0) {
      syncLog("gs_scrape_start", { count: gsLinkedCourses.length });
      try {
        const gsResult = await scrapeGradescopeAssignments(scUrl, apiToken, gsLinkedCourses);
        if (gsResult) {
          result.gradescope = gsResult;
          syncLog("gs_done", gsResult);
        }
      } catch (err) {
        syncLog("gs_error", { error: err?.message ?? String(err) });
        console.warn("[worker] Gradescope sync failed (non-fatal):", err?.message ?? err);
      }
    } else {
      syncLog("gs_skipped", { reason: "no linked courses" });
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

// ── Gradescope helpers ────────────────────────────────────────────────────────

/** Navigate a tab and wait for it to finish loading. */
function waitForTabLoad(tabId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("page load timeout"));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 600);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Navigate to a Canvas LTI external tool page and extract the Gradescope
 * course ID from the embedded iframe. Canvas opens Gradescope via LTI in
 * an iframe — we inject into all frames to find the gradescope.com URL.
 */
async function resolveGradescopeCourseId(tabId, canvasTabUrl) {
  await chrome.tabs.update(tabId, { url: canvasTabUrl });
  await waitForTabLoad(tabId);

  // The LTI iframe may still be redirecting — poll a few times
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));

    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => window.location.href,
    });

    for (const frame of results) {
      const url = frame?.result ?? "";
      const m = url.match(/gradescope\.com\/courses\/(\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Scrape Gradescope assignments for courses with known Gradescope IDs.
 * Navigates to each course page and reads the rendered DOM.
 */
async function scrapeGradescopeAssignments(scUrl, apiToken, linkedCourses) {
  broadcastToPopup({ type: "SYNC_PROGRESS", percent: 96, label: "Syncing Gradescope grades…" });

  let gsTabId = null;
  let createdTab = false;

  const tabs = await chrome.tabs.query({ url: "https://www.gradescope.com/*" });
  if (tabs.length > 0) {
    gsTabId = tabs[0].id;
  } else {
    const tab = await chrome.tabs.create({ url: "https://www.gradescope.com/", active: false });
    createdTab = true;
    gsTabId = tab.id;
    await waitForTabLoad(gsTabId);
  }

  try {
    const allCourses = [];

    for (const course of linkedCourses) {
      const cid = course.gradescopeCourseId;
      try {
        await chrome.tabs.update(gsTabId, { url: `https://www.gradescope.com/courses/${cid}` });
        await waitForTabLoad(gsTabId);

        const [courseResult] = await chrome.scripting.executeScript({
          target: { tabId: gsTabId },
          func: () => {
            const rows = document.querySelectorAll(
              "table.table--assignments tbody tr, table.js-assignmentsTable tbody tr, " +
              "table.table tbody tr, table.js-assignmentTable tbody tr, " +
              ".assignments tbody tr, [data-testid='assignment-row'], tbody tr"
            );
            const results = [];
            const seen = new Set();
            const pushResult = (item) => {
              const key = item.gradescopeAssignmentId
                ? `id:${item.gradescopeAssignmentId}`
                : `title:${(item.title || "").toLowerCase()}`;
              if (!item.title || seen.has(key)) return;
              seen.add(key);
              results.push(item);
            };
            for (const row of rows) {
              const titleLink = row.querySelector("th a, td a[href*='/assignments/']");
              const titleCell = row.querySelector("th, td:first-child");
              const title = titleLink?.textContent?.trim() || titleCell?.textContent?.trim();
              if (!title || title.length < 2) continue;

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
                if (
                  lower.includes("late due date passed") ||
                  lower.includes("due date passed")
                ) {
                  status = "missing";
                }
                if (lower.includes("graded")) status = "graded";
                else if (lower.includes("submitted") && status !== "graded") status = "submitted";
              }

              // Extract due date from <time datetime="..."> elements in the row.
              // Gradescope rows can have multiple time tags (released, due).
              // The due date is typically the last one.
              let dueDate = null;
              const timeTags = row.querySelectorAll("time[datetime]");
              if (timeTags.length > 0) {
                const dt = timeTags[timeTags.length - 1].getAttribute("datetime");
                if (dt) {
                  try { dueDate = new Date(dt).toISOString().split("T")[0]; } catch { /* skip */ }
                }
              }

              pushResult({ title, score, maxScore, status, gradescopeAssignmentId, dueDate });
            }

            // Fallback pass: some Gradescope variants don't render standard table rows
            // (or hide rows behind different wrappers). Scan assignment links directly.
            for (const a of document.querySelectorAll("a[href*='/assignments/']")) {
              const href = a.getAttribute("href") || "";
              const m = href.match(/\/assignments\/(\d+)/);
              const title = a.textContent?.trim();
              if (!m || !title || title.length < 2) continue;

              const container =
                a.closest("tr,[data-testid='assignment-row'],li,div") || a.parentElement;
              const blob = (container?.textContent || "").toLowerCase();
              let status = "unsubmitted";
              if (blob.includes("late due date passed") || blob.includes("due date passed")) {
                status = "missing";
              } else if (blob.includes("graded")) {
                status = "graded";
              } else if (blob.includes("submitted")) {
                status = "submitted";
              }

              let dueDate = null;
              const timeTags = container?.querySelectorAll?.("time[datetime]") || [];
              if (timeTags.length > 0) {
                const dt = timeTags[timeTags.length - 1].getAttribute("datetime");
                if (dt) {
                  try { dueDate = new Date(dt).toISOString().split("T")[0]; } catch { /* skip */ }
                }
              }

              pushResult({
                title,
                score: null,
                maxScore: null,
                status,
                gradescopeAssignmentId: m[1],
                dueDate,
              });
            }
            return results;
          },
        });

        const assignments = courseResult?.result ?? [];
        syncLog("gs_course", { cid, canvas: course.name, assignments: assignments.length });
        allCourses.push({ gradescopeCourseId: cid, assignments });
      } catch (err) {
        syncLog("gs_course_err", { cid, error: err?.message });
      }
    }

    if (allCourses.length === 0) return null;

    syncLog("gs_scraped", {
      courseCount: allCourses.length,
      courses: allCourses.map((c) => ({ gsId: c.gradescopeCourseId, assignments: c.assignments?.length ?? 0 })),
    });

    const gsRes = await fetch(`https://${scUrl}/api/gradescope/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ courses: allCourses }),
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
