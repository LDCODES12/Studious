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

    // ── Step 1b: Discover Kaltura / Media Gallery transcript attachments ────
    // Transcript .txt attachments are high-value lecture material: they contain
    // the spoken lecture itself, but they live outside the normal module PDF
    // workflow. We discover them from the Media Gallery tab and feed them into
    // the regular material sync as plain text.
    const coursesWithMediaGallery = payload.courses.filter((c) => c.mediaGalleryTabUrl);
    if (coursesWithMediaGallery.length > 0) {
      broadcastToPopup({ type: "SYNC_PROGRESS", percent: 87, label: "Checking lecture transcripts…" });
      try {
        await syncCanvasMediaTranscripts(scUrl, apiToken, canvasUrl, coursesWithMediaGallery);
      } catch (err) {
        syncLog("media_sync_err", { error: err?.message ?? String(err) });
        console.warn("[worker] Media transcript sync failed (non-fatal):", err?.message ?? err);
      }
    }

    // Clean up — server doesn't need these
    for (const c of payload.courses) {
      delete c.gradescopeTabUrl;
      delete c.mediaGalleryTabUrl;
    }

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
        course.syllabusTexts = course.syllabusTexts ?? [];
        course.materialTexts = course.materialTexts ?? [];
      }

      const allPdfTasks = [];
      for (const course of payload.courses) {
        for (const { fileName, url, sourceKey, sourceKind, remoteSize, remoteUpdatedAt } of (course.syllabusFileUrls ?? [])) {
          allPdfTasks.push({ course, type: "syllabus", fileName, url, sourceKey, sourceKind, remoteSize, remoteUpdatedAt });
        }
        for (const { fileName, url, sourceKey, sourceKind, remoteSize, remoteUpdatedAt } of (course.materialFileUrls ?? [])) {
          allPdfTasks.push({ course, type: "material", fileName, url, sourceKey, sourceKind, remoteSize, remoteUpdatedAt });
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
          task.course.syllabusTexts.push({
            fileName: task.fileName,
            text,
            sourceKey: task.sourceKey ?? null,
            sourceKind: task.sourceKind ?? "canvas_syllabus",
            remoteSize: task.remoteSize ?? null,
            remoteUpdatedAt: task.remoteUpdatedAt ?? null,
          });
        } else {
          task.course.materialTexts.push({
            fileName: task.fileName,
            text,
            sourceKey: task.sourceKey ?? null,
            sourceKind: task.sourceKind ?? "canvas_module",
            remoteSize: task.remoteSize ?? null,
            remoteUpdatedAt: task.remoteUpdatedAt ?? null,
          });
        }
      }

      await closeOffscreen();

      for (const course of payload.courses) {
        delete course.syllabusFileUrls;
        delete course.materialFileUrls;
      }
    } else {
      for (const course of payload.courses) {
        course.syllabusTexts = course.syllabusTexts ?? [];
        course.materialTexts = course.materialTexts ?? [];
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

async function fetchPendingCandidateIds(scUrl, apiToken, canvasCourseId) {
  try {
    const res = await fetch(
      `https://${scUrl}/api/canvas/materials/pending?canvasCourseId=${canvasCourseId}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set((data.candidates ?? []).map((candidate) => String(candidate.contentId)));
  } catch {
    return new Set();
  }
}

async function fetchPlainTextFile(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return "";
  const buf = await res.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.trim();
}

function buildMediaTranscriptContentId(mediaId, attachmentFileName, attachmentUrl) {
  const normalizedMediaId = String(mediaId || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 120);
  const normalizedFile = encodeURIComponent(
    String(attachmentFileName || attachmentUrl || "transcript.txt").trim().toLowerCase()
  );
  return `media:${normalizedMediaId}:${normalizedFile}`;
}

function buildMediaTranscriptDisplayName(mediaTitle, attachmentFileName) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const title = clean(mediaTitle);
  const fileName = clean(attachmentFileName);
  const opaqueAttachment =
    !fileName ||
    (/pid[\s._-]*\d+/i.test(fileName) && /^\d/.test(fileName)) ||
    /^[\d\s._-]+\.txt$/i.test(fileName);

  if (!title) return fileName || "Lecture transcript.txt";
  if (opaqueAttachment) return `${title} transcript.txt`;
  if (fileName.toLowerCase().includes(title.toLowerCase())) return fileName;
  return `${title} — ${fileName}`;
}

async function collectMediaGalleryEntries(tabId) {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const clean = (value) =>
        String(value || "")
          .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const findNearestSection = (node) => {
        let current = node;
        while (current && current !== document.body) {
          let sibling = current.previousElementSibling;
          while (sibling) {
            const heading = sibling.matches?.("h1,h2,h3,h4,h5,h6")
              ? sibling
              : sibling.querySelector?.("h1,h2,h3,h4,h5,h6");
            const text = clean(heading?.textContent);
            if (text) return text;
            sibling = sibling.previousElementSibling;
          }
          current = current.parentElement;
        }
        return null;
      };

      const titleFromAnchor = (anchor) =>
        clean(anchor.getAttribute("aria-label")) ||
        clean(anchor.querySelector("img")?.getAttribute("alt")) ||
        clean(anchor.querySelector("h1,h2,h3,h4,h5,h6,.title,.media-title,.name,.video-title")?.textContent) ||
        clean(anchor.textContent);

      const results = [];
      const seen = new Set();

      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor.href || "";
        const mediaMatch =
          href.match(/\/media\/([^/?#]+)/i) ||
          href.match(/[?&]entry_id=([^&#]+)/i);
        if (!mediaMatch?.[1]) continue;

        const mediaId = mediaMatch[1];
        if (seen.has(mediaId)) continue;

        const title = titleFromAnchor(anchor);
        if (!title || title.length < 4) continue;
        if (/^(attachments|share|back|actions)$/i.test(title)) continue;

        seen.add(mediaId);
        results.push({
          mediaId,
          url: href,
          title,
          section: findNearestSection(anchor),
        });
      }

      return results;
    },
  });

  const merged = [];
  const seen = new Set();
  for (const frame of frameResults) {
    for (const entry of frame?.result ?? []) {
      const key = entry.mediaId || entry.url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

async function extractMediaTranscriptAttachments(tabId) {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

      const findAttachmentsTab = () =>
        Array.from(document.querySelectorAll("a,button,[role='tab']"))
          .find((el) => /attachments/i.test(clean(el.textContent)));

      const scanAttachments = () => {
        const attachments = [];
        const seen = new Set();
        const extractSize = (text) => {
          const match = clean(text).match(/(\d+(?:\.\d+)?)\s*(kb|mb|bytes?)/i);
          if (!match) return null;
          const value = Number(match[1]);
          const unit = match[2].toLowerCase();
          if (!Number.isFinite(value)) return null;
          if (unit.startsWith("mb")) return Math.round(value * 1024 * 1024);
          if (unit.startsWith("kb")) return Math.round(value * 1024);
          return Math.round(value);
        };

        const extractUploadedAt = (row) => {
          const text = clean(row.textContent);
          const match = text.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i);
          return match?.[0] ?? null;
        };

        const extractFileName = (row) => {
          const explicit = clean(
            row.querySelector("a[href], td, th, [class*='file'], [class*='name']")?.textContent
          );
          if (/\.txt\b/i.test(explicit)) {
            const txtMatch = explicit.match(/([^/\\]+?\.txt)\b/i);
            return txtMatch?.[1] ?? explicit;
          }
          const rowText = clean(row.textContent);
          const txtMatch = rowText.match(/([^/\\]+?\.txt)\b/i);
          return txtMatch?.[1] ?? null;
        };

        const containers = Array.from(
          document.querySelectorAll("tr, li, .attachment, [class*='attachment'], [data-testid*='attachment']")
        );
        for (const row of containers) {
          const rowText = clean(row.textContent);
          if (!/\.txt\b/i.test(rowText)) continue;

          const fileName = extractFileName(row);
          if (!fileName) continue;

          const downloadUrl =
            row.querySelector("a[download][href]")?.href ||
            row.querySelector("a[href*='download']")?.href ||
            row.querySelector("a[href]")?.href ||
            row.querySelector("[data-download-url]")?.getAttribute("data-download-url") ||
            row.querySelector("[data-url]")?.getAttribute("data-url") ||
            null;
          if (!downloadUrl) continue;

          const key = `${fileName}|${downloadUrl}`;
          if (seen.has(key)) continue;
          seen.add(key);

          attachments.push({
            fileName,
            url: downloadUrl,
            uploadedAt: extractUploadedAt(row),
            size: extractSize(rowText),
          });
        }

        if (attachments.length > 0) return attachments;

        for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
          const label = clean(anchor.textContent) || clean(anchor.getAttribute("aria-label"));
          const href = anchor.href || "";
          if (!label && !href) continue;
          const fileNameMatch = label.match(/([^/\\]+?\.txt)\b/i) || href.match(/([^/\\?&#]+?\.txt)\b/i);
          if (!fileNameMatch?.[1]) continue;
          const key = `${fileNameMatch[1]}|${href}`;
          if (seen.has(key)) continue;
          seen.add(key);
          attachments.push({
            fileName: fileNameMatch[1],
            url: href,
            uploadedAt: null,
            size: null,
          });
        }

        return attachments;
      };

      const attachmentsTab = findAttachmentsTab();
      if (attachmentsTab) attachmentsTab.click();

      for (let attempt = 0; attempt < 8; attempt++) {
        const found = scanAttachments();
        if (found.length > 0) return found;
        await sleep(400);
      }

      return scanAttachments();
    },
  });

  const merged = [];
  const seen = new Set();
  for (const frame of frameResults) {
    for (const attachment of frame?.result ?? []) {
      const key = `${attachment.fileName}|${attachment.url}`;
      if (!attachment?.url || seen.has(key)) continue;
      seen.add(key);
      merged.push(attachment);
    }
  }
  return merged;
}

async function syncCanvasMediaTranscripts(scUrl, apiToken, canvasUrl, courses) {
  const MAX_MEDIA_ITEMS_TO_INSPECT = 24;
  const MAX_AUTO_IMPORTS_PER_COURSE = 8;

  const tab = await chrome.tabs.create({ url: `https://${canvasUrl}`, active: false });
  const mediaTabId = tab.id;
  await waitForTabLoad(mediaTabId, 30_000);

  try {
    for (const course of courses) {
      const requestedIds = await fetchPendingCandidateIds(scUrl, apiToken, course.id);
      course.materialCandidates = course.materialCandidates ?? [];
      course.materialTexts = course.materialTexts ?? [];

      try {
        await chrome.tabs.update(mediaTabId, { url: course.mediaGalleryTabUrl });
        await waitForTabLoad(mediaTabId, 30_000);

        const galleryEntries = await collectMediaGalleryEntries(mediaTabId);
        if (galleryEntries.length === 0) {
          syncLog("media_gallery_empty", { course: course.name });
          continue;
        }

        const entriesToInspect = galleryEntries.slice(0, MAX_MEDIA_ITEMS_TO_INSPECT);
        const seenCandidateIds = new Set(course.materialCandidates.map((candidate) => candidate.contentId));
        const downloadedIds = new Set(course.materialTexts.map((material) => material.sourceKey).filter(Boolean));
        let autoImportedCount = 0;
        let transcriptCount = 0;

        syncLog("media_gallery_found", {
          course: course.name,
          entries: galleryEntries.length,
          inspecting: entriesToInspect.length,
        });

        for (const entry of entriesToInspect) {
          try {
            await chrome.tabs.update(mediaTabId, { url: entry.url });
            await waitForTabLoad(mediaTabId, 30_000);

            const attachments = await extractMediaTranscriptAttachments(mediaTabId);
            if (attachments.length === 0) continue;

            for (const attachment of attachments) {
              const contentId = buildMediaTranscriptContentId(entry.mediaId, attachment.fileName, attachment.url);
              const displayName = buildMediaTranscriptDisplayName(entry.title, attachment.fileName);
              const moduleName = entry.section ? `Kaltura Media Gallery · ${entry.section}` : "Kaltura Media Gallery";

              if (!seenCandidateIds.has(contentId)) {
                seenCandidateIds.add(contentId);
                course.materialCandidates.push({
                  fileName: displayName,
                  moduleName,
                  contentId,
                  sourceKind: "canvas_media",
                  remoteSize: attachment.size ?? null,
                  remoteUpdatedAt: attachment.uploadedAt ?? null,
                });
              }

              const shouldAutoImport = autoImportedCount < MAX_AUTO_IMPORTS_PER_COURSE;
              const shouldDownload = requestedIds.has(contentId) || shouldAutoImport;
              if (!shouldDownload || downloadedIds.has(contentId)) continue;

              const text = await fetchPlainTextFile(attachment.url);
              if (text.length < 100) continue;

              downloadedIds.add(contentId);
              course.materialTexts.push({
                fileName: displayName,
                text,
                sourceKey: contentId,
                sourceKind: "canvas_media",
                remoteSize: attachment.size ?? null,
                remoteUpdatedAt: attachment.uploadedAt ?? null,
              });
              transcriptCount++;
              if (!requestedIds.has(contentId)) autoImportedCount++;
            }
          } catch (err) {
            syncLog("media_entry_err", {
              course: course.name,
              title: entry.title,
              error: err?.message ?? String(err),
            });
          }
        }

        syncLog("media_gallery_done", {
          course: course.name,
          transcriptsImported: transcriptCount,
          candidates: course.materialCandidates.filter((candidate) => candidate.sourceKind === "canvas_media").length,
        });
      } catch (err) {
        syncLog("media_course_err", {
          course: course.name,
          error: err?.message ?? String(err),
        });
      }
    }
  } finally {
    if (mediaTabId) {
      try { await chrome.tabs.remove(mediaTabId); } catch { /* already closed */ }
    }
  }
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
            const results = [];
            const seen = new Set();
            const debug = {
              candidateContainers: 0,
              parsed: 0,
              skippedNoTitle: 0,
              missingId: 0,
              missingDue: 0,
              statusCounts: { graded: 0, submitted: 0, missing: 0, unsubmitted: 0 },
            };

            const courseIdFromPath = window.location.pathname.match(/\/courses\/(\d+)/)?.[1] ?? "unknown";
            const normalizeTitle = (s) =>
              (s || "")
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            const canonicalDateTime = (value) => {
              if (!value) return null;
              try {
                const d = new Date(value);
                if (!Number.isFinite(d.getTime())) return null;
                return d.toISOString();
              } catch {
                return null;
              }
            };
            const canonicalDueDate = (value) => {
              const ts = canonicalDateTime(value);
              return ts ? ts.split("T")[0] : null;
            };
            const extractDateFragments = (text) => {
              if (!text) return [];
              const flat = text.replace(/\s+/g, " ").trim();
              const monthRx = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?(?:(?:\s+at)?\s+\d{1,2}:\d{2}\s*[ap]m)?\b/ig;
              const slashRx = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+\d{1,2}:\d{2}\s*[ap]m?)?\b/ig;
              const matches = [];
              for (const rx of [monthRx, slashRx]) {
                for (const m of flat.matchAll(rx)) matches.push(m[0]);
              }
              return matches;
            };
            const parseDateFragment = (fragment) => {
              if (!fragment) return null;
              const text = fragment.replace(/\s+/g, " ").trim();
              const monthMap = {
                jan: 0, january: 0,
                feb: 1, february: 1,
                mar: 2, march: 2,
                apr: 3, april: 3,
                may: 4,
                jun: 5, june: 5,
                jul: 6, july: 6,
                aug: 7, august: 7,
                sep: 8, sept: 8, september: 8,
                oct: 9, october: 9,
                nov: 10, november: 10,
                dec: 11, december: 11,
              };
              const normalizeYear = (y) => {
                if (!y) return new Date().getFullYear();
                const n = Number(y);
                if (!Number.isFinite(n)) return new Date().getFullYear();
                if (y.length === 2) return 2000 + n;
                return n;
              };
              const to24h = (hourRaw, ampmRaw) => {
                if (!hourRaw) return 0;
                let h = Number(hourRaw);
                if (!Number.isFinite(h)) return 0;
                const ampm = (ampmRaw || "").toLowerCase();
                if (ampm === "pm" && h < 12) h += 12;
                if (ampm === "am" && h === 12) h = 0;
                return h;
              };
              const buildIso = (year, month, day, hour = 0, minute = 0) => {
                const d = new Date(year, month, day, hour, minute, 0, 0);
                if (!Number.isFinite(d.getTime())) return null;
                return d.toISOString();
              };

              let m = text.match(
                /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{2,4}))?(?:(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?$/
              );
              if (m) {
                const monKey = m[1].toLowerCase();
                const month = monthMap[monKey];
                if (month === undefined) return null;
                const day = Number(m[2]);
                const year = normalizeYear(m[3] || "");
                const hour = to24h(m[4] || "", m[6] || "");
                const minute = m[5] ? Number(m[5]) : 0;
                return buildIso(year, month, day, hour, minute);
              }

              m = text.match(
                /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?$/
              );
              if (m) {
                const month = Number(m[1]) - 1;
                const day = Number(m[2]);
                const year = normalizeYear(m[3] || "");
                const hour = to24h(m[4] || "", m[6] || "");
                const minute = m[5] ? Number(m[5]) : 0;
                return buildIso(year, month, day, hour, minute);
              }

              return canonicalDateTime(text);
            };
            const parseDateTimesFromText = (text) => {
              const out = [];
              for (const fragment of extractDateFragments(text)) {
                const parsed = parseDateFragment(fragment);
                if (parsed) out.push(parsed);
              }
              return out;
            };
            const parseReleasedAt = (cell) => {
              if (!cell) return null;
              for (const tag of Array.from(cell.querySelectorAll("time[datetime]"))) {
                const parsed = canonicalDateTime(tag.getAttribute("datetime"));
                if (parsed) return parsed;
              }
              return parseDateTimesFromText(cell.textContent || "")[0] || null;
            };
            const classifyTimeTag = (tag) => {
              // Use aria-label and CSS class ONLY — never parentElement.textContent
              // which mixes text from sibling tags and causes misclassification.
              const aria = (tag.getAttribute("aria-label") || "").toLowerCase();
              const cls = (tag.className || "").toLowerCase();
              if (cls.includes("release") || aria.includes("release")) return "release";
              if (aria.includes("late due") || aria.includes("hard due")) return "late-due";
              if (cls.includes("due") || aria.includes("due")) return "due";
              // Fallback: check the tag's own inner text only (not parent)
              const own = (tag.textContent || "").toLowerCase();
              if (own.includes("late due") || own.includes("hard due")) return "late-due";
              return "due"; // default: treat unknown as regular due
            };
            const parseDueFields = (cell) => {
              if (!cell) return { dueAt: null, lateDueAt: null };
              let dueAt = null;
              let lateDueAt = null;

              const timeTags = Array.from(cell.querySelectorAll("time[datetime]"));
              for (const tag of timeTags) {
                const parsed = canonicalDateTime(tag.getAttribute("datetime"));
                if (!parsed) continue;
                const kind = classifyTimeTag(tag);
                if (kind === "release") continue;
                if (kind === "late-due") {
                  if (!lateDueAt) lateDueAt = parsed;
                  continue;
                }
                if (!dueAt) dueAt = parsed;
              }
              if (dueAt) return { dueAt, lateDueAt };

              const flat = (cell.textContent || "").replace(/\s+/g, " ").trim();
              const all = parseDateTimesFromText(flat);
              if (all.length === 0) return { dueAt: null, lateDueAt: null };

              dueAt = all[0] || null;
              const lateChunk = flat.match(/late due date:\s*(.*)$/i)?.[1] || "";
              const lateCandidates = parseDateTimesFromText(lateChunk);
              lateDueAt = lateCandidates[0] || (/(late due|hard due)/i.test(flat) ? all[1] || null : null);

              return { dueAt, lateDueAt };
            };
            const tableHeaderCache = new WeakMap();
            const getColumnIndexes = (container) => {
              const row = container.closest("tr,[role='row']") || (container.matches?.("tr,[role='row']") ? container : null);
              if (!row) return null;
              const table = row.closest("table");
              if (!table) return null;
              if (tableHeaderCache.has(table)) return tableHeaderCache.get(table);
              const idx = { released: -1, due: -1 };
              const headerCells = Array.from(table.querySelectorAll("thead tr th, thead tr td"));
              for (const [i, header] of headerCells.entries()) {
                const t = (header.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
                if (idx.released === -1 && t.includes("released")) idx.released = i;
                if (idx.due === -1 && t.includes("due")) idx.due = i;
              }
              tableHeaderCache.set(table, idx);
              return idx;
            };
            const extractDateFields = (container) => {
              let releasedAt = null;
              let dueAt = null;
              let lateDueAt = null;

              const row = container.matches?.("tr,[role='row']") ? container : container.closest?.("tr,[role='row']");
              const idx = getColumnIndexes(container);
              if (row && idx && idx.due >= 0) {
                const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td"));
                if (idx.released >= 0 && idx.released < cells.length) {
                  releasedAt = parseReleasedAt(cells[idx.released]);
                }
                if (idx.due >= 0 && idx.due < cells.length) {
                  const due = parseDueFields(cells[idx.due]);
                  dueAt = due.dueAt;
                  lateDueAt = due.lateDueAt;
                }
              }
              // Robust structural fallback: most GS rows are Name | Status | Released | Due.
              if (row && !dueAt) {
                const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td"));
                if (cells.length >= 3) {
                  const dueCell = cells[cells.length - 1];
                  const releasedCell = cells[cells.length - 2];
                  const due = parseDueFields(dueCell);
                  if (due.dueAt) dueAt = due.dueAt;
                  if (due.lateDueAt) lateDueAt = due.lateDueAt;
                  if (!releasedAt) releasedAt = parseReleasedAt(releasedCell);
                }
              }

              // Fallback for non-table layouts.
              if (!dueAt || !releasedAt) {
                for (const tag of Array.from(container.querySelectorAll("time[datetime]"))) {
                  const parsed = canonicalDateTime(tag.getAttribute("datetime"));
                  if (!parsed) continue;
                  const kind = classifyTimeTag(tag);
                  if (!releasedAt && kind === "release") releasedAt = parsed;
                  if (!lateDueAt && kind === "late-due") lateDueAt = parsed;
                  if (!dueAt && kind === "due") dueAt = parsed;
                }
              }

              if (!dueAt) {
                const cells = Array.from(container.querySelectorAll("td,th,span,div"));
                for (const cell of cells.slice(0, 24)) {
                  const txt = cell.textContent?.trim() || "";
                  if (!txt || txt.length > 600) continue;
                  const parsed = parseDateTimesFromText(txt);
                  if (parsed.length) {
                    dueAt = parsed[0];
                    break;
                  }
                }
              }

              return { releasedAt, dueAt, lateDueAt };
            };
            const getAttrFirst = (els, attr) => {
              for (const el of els) {
                const v = el?.getAttribute?.(attr);
                if (v && String(v).trim()) return String(v).trim();
              }
              return null;
            };
            const extractAssignmentId = (container) => {
              const candidateEls = [
                container,
                ...Array.from(container.querySelectorAll("[data-assignment-id],a[href*='/assignments/'],button.js-submitAssignment,button[data-assignment-id],th a,td a")),
              ];
              const fromData =
                getAttrFirst(candidateEls, "data-assignment-id") ||
                container?.dataset?.assignmentId ||
                null;
              if (fromData) return fromData;

              const containerId = container?.id?.replace(/^assignment-/, "").trim();
              if (containerId) return containerId;

              for (const el of candidateEls) {
                const href = el?.getAttribute?.("href") || "";
                const m = href.match(/\/assignments\/(\d+)/);
                if (m?.[1]) return m[1];
                const onclick = el?.getAttribute?.("onclick") || "";
                const mo = onclick.match(/assignment[^0-9]*(\d+)/i) || onclick.match(/(\d{5,})/);
                if (mo?.[1]) return mo[1];
              }
              return null;
            };
            const extractTitle = (container) => {
              const titleNode = container.querySelector(
                "th a[href*='/assignments/'], td a[href*='/assignments/'], button.js-submitAssignment, button[data-assignment-id], [data-testid='assignment-title'], .table--primaryLink a"
              );
              const raw =
                titleNode?.textContent?.trim() ||
                container.querySelector("th, td, [role='cell']")?.textContent?.trim() ||
                null;
              if (!raw) return null;
              const cleaned = raw.replace(/\s+/g, " ").trim();
              return cleaned.length >= 2 ? cleaned : null;
            };
            const deriveStatusAndScores = (container) => {
              const blob = (container.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
              const scoreMatch = blob.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
              if (scoreMatch) {
                return {
                  status: "graded",
                  score: parseFloat(scoreMatch[1]),
                  maxScore: parseFloat(scoreMatch[2]),
                };
              }
              const maxOnly = blob.match(/[-–]\s*\/\s*(\d+(?:\.\d+)?)/);
              if (blob.includes("late due date passed") || blob.includes("due date passed") || blob.includes("missing")) {
                return { status: "missing", score: null, maxScore: maxOnly ? parseFloat(maxOnly[1]) : null };
              }
              if (blob.includes("no submission") || blob.includes("not submitted") || blob.includes("unsubmitted")) {
                return { status: "unsubmitted", score: null, maxScore: maxOnly ? parseFloat(maxOnly[1]) : null };
              }
              if (blob.includes("submitted") || blob.includes("ungraded") || blob.includes("pending review")) {
                return { status: "submitted", score: null, maxScore: maxOnly ? parseFloat(maxOnly[1]) : null };
              }
              return { status: "unsubmitted", score: null, maxScore: maxOnly ? parseFloat(maxOnly[1]) : null };
            };

            const candidates = new Set();
            const registerCandidate = (el) => {
              if (!el) return;
              candidates.add(el);
            };
            for (const el of document.querySelectorAll(
              "table.table--assignments tbody tr, table.js-assignmentsTable tbody tr, " +
              "table.table tbody tr, table.js-assignmentTable tbody tr, tr[role='row'], [data-testid='assignment-row']"
            )) {
              registerCandidate(el);
            }
            for (const trigger of document.querySelectorAll(
              "button.js-submitAssignment, button[data-assignment-id], a[href*='/assignments/']"
            )) {
              registerCandidate(trigger.closest("tr,[role='row'],[data-testid='assignment-row'],li,article,div"));
            }
            debug.candidateContainers = candidates.size;

            const pushResult = (item) => {
              const key = item.gradescopeAssignmentId
                ? `id:${item.gradescopeAssignmentId}`
                : `fp:${item.gradescopeFingerprint}`;
              if (!item.title || seen.has(key)) return;
              seen.add(key);
              results.push(item);
            };

            for (const container of candidates) {
              const text = (container?.textContent || "").toLowerCase();
              if (
                !container?.querySelector?.("a[href*='/assignments/'],button[data-assignment-id],button.js-submitAssignment,time[datetime]") &&
                !/(submission|submitted|no submission|due|graded|late due date passed|ungraded)/i.test(text)
              ) {
                continue;
              }
              const title = extractTitle(container);
              if (!title) {
                debug.skippedNoTitle++;
                continue;
              }

              const gradescopeAssignmentId = extractAssignmentId(container);
              if (!gradescopeAssignmentId) debug.missingId++;

              const { releasedAt, dueAt, lateDueAt } = extractDateFields(container);
              if (!dueAt) debug.missingDue++;

              const normTitle = normalizeTitle(title);
              const dueDay = canonicalDueDate(dueAt);
              const gradescopeFingerprint = `${courseIdFromPath}|${normTitle}|${dueDay || "no-date"}`;
              const { status, score, maxScore } = deriveStatusAndScores(container);
              if (debug.statusCounts[status] !== undefined) debug.statusCounts[status]++;

              // Debug: capture raw time tags for diagnosing date issues
              const _timeTags = Array.from(container.querySelectorAll("time[datetime]")).map(t => ({
                dt: t.getAttribute("datetime"),
                aria: t.getAttribute("aria-label") || "",
                cls: t.className || "",
                kind: classifyTimeTag(t),
              }));

              pushResult({
                title,
                score,
                maxScore,
                status,
                gradescopeAssignmentId,
                gradescopeFingerprint,
                dueDate: dueAt || null,
                dueAt: dueAt || null,
                releasedAt: releasedAt || null,
                lateDueAt: lateDueAt || null,
                _debug: _timeTags.length > 0 ? { timeTags: _timeTags } : undefined,
              });
              debug.parsed++;
            }
            return { assignments: results, debug };
          },
        });

        const payload = Array.isArray(courseResult?.result)
          ? { assignments: courseResult.result, debug: null }
          : (courseResult?.result ?? { assignments: [], debug: null });
        const assignments = Array.isArray(payload.assignments) ? payload.assignments : [];
        syncLog("gs_course", {
          cid,
          canvas: course.name,
          assignments: assignments.length,
          scrape: payload.debug
            ? {
                candidates: payload.debug.candidateContainers,
                parsed: payload.debug.parsed,
                skippedNoTitle: payload.debug.skippedNoTitle,
                missingId: payload.debug.missingId,
                missingDue: payload.debug.missingDue,
              }
            : undefined,
        });
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
