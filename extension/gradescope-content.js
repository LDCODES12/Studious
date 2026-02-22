/**
 * gradescope-content.js — Silently syncs Gradescope assignments to Study Circle.
 *
 * Fires on ANY Gradescope course page (manifest: gradescope.com/courses/*).
 *
 * Strategy:
 *  1. If already on the /assignments page → read the live `document` (JS-rendered, reliable).
 *  2. Otherwise → fetch /assignments HTML as a same-origin request and parse it.
 *
 * Per-course debounce: skips if the same course was synced within the last hour.
 * Check DevTools > Console on any Gradescope course page to see [gs-sync] logs.
 */

(async () => {
  const { scUrl, apiToken } = await chrome.storage.local.get(["scUrl", "apiToken"]);
  if (!scUrl || !apiToken) {
    console.log("[gs-sync] No scUrl/apiToken configured — skipping");
    return;
  }

  // Only fire on numeric course pages: /courses/{numericId} or /courses/{id}/anything
  const courseMatch = window.location.pathname.match(/^\/courses\/(\d+)/);
  if (!courseMatch) return;
  const gsCourseId = courseMatch[1];

  // ── Per-course debounce: skip if synced within the last hour ──────────────
  const debounceKey = `gs_synced_${gsCourseId}`;
  const stored = await chrome.storage.local.get([debounceKey]);
  const lastSynced = stored[debounceKey];
  if (lastSynced && Date.now() - lastSynced < 3_600_000) {
    console.log(`[gs-sync] course ${gsCourseId}: debounced (synced ${Math.round((Date.now() - lastSynced) / 60000)}m ago)`);
    return;
  }

  // ── Course name from page title (most reliable source) ────────────────────
  // Gradescope page titles:
  //   Assignments page: "Assignments | CHEM 1120 - Gradescope"
  //   Course dashboard: "CHEM 1120 - Gradescope"
  // Extract the course name by stripping "Assignments | " prefix and " - Gradescope" suffix.
  function courseNameFromTitle(title) {
    if (!title) return "";
    // Strip trailing " - Gradescope" or " | Gradescope"
    const stripped = title.replace(/\s*[-|]\s*Gradescope\s*$/i, "").trim();
    // If there's a " | " separator, the course name is after the last "|"
    const parts = stripped.split("|");
    return parts[parts.length - 1].trim();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function extractCourseName(doc, isLiveDocument) {
    // For the live document, use the actual page title — it's the most reliable source
    // and avoids getting the "Assignments" h1 which is the page heading, not the course name.
    const titleName = courseNameFromTitle(
      isLiveDocument ? document.title : doc.querySelector("title")?.textContent
    );
    if (titleName) return titleName;

    // DOM fallback: look for course header elements that Gradescope uses
    // Explicitly skip any h1 that just says "Assignments"
    for (const sel of [
      ".courseHeader--title h1",
      "h1.courseHeader--name",
      ".courseHeader h1",
      ".sidebar--course-info h1",
      "[class*='courseHeader'] h1",
    ]) {
      const el = doc.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text && !/^assignments$/i.test(text)) return text;
    }
    return "";
  }

  function extractAssignments(doc) {
    // Gradescope's assignments table — try multiple selector strategies
    const rows = doc.querySelectorAll(
      "table.table--assignments tbody tr, " +
      "table.js-assignmentsTable tbody tr, " +
      "table.table tbody tr, " +
      "table.js-assignmentTable tbody tr, " +
      "tbody tr"
    );
    const results = [];

    for (const row of rows) {
      // Title — Gradescope uses <th scope="row"><a> for the title cell
      const titleLink = row.querySelector("th a");
      const titleCell = row.querySelector("th");
      const title =
        titleLink?.textContent?.trim() || titleCell?.textContent?.trim();
      if (!title) continue;

      // Gradescope assignment ID — from data attribute or link href
      const gradescopeAssignmentId =
        row.dataset?.assignmentId ||
        row.id?.replace(/^assignment-/, "") ||
        (titleLink
          ? titleLink.getAttribute("href")?.match(/\/assignments\/(\d+)/)?.[1]
          : null) ||
        null;

      const cells = Array.from(row.querySelectorAll("td"));

      let score = null;
      let maxScore = null;
      let status = "unsubmitted";

      for (const cell of cells) {
        const cellText = cell.textContent?.trim() ?? "";

        // Match "18.5 / 20", "18.5/20", "18 / 20" anywhere in the cell
        const m = cellText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
        if (m) {
          score = parseFloat(m[1]);
          maxScore = parseFloat(m[2]);
          status = "graded";
          break;
        }

        const lower = cellText.toLowerCase();
        if (lower.includes("graded")) {
          if (status !== "graded") status = "graded";
        } else if (lower.includes("submitted")) {
          if (status !== "graded") status = "submitted";
        }
      }

      results.push({ title, score, maxScore, status, gradescopeAssignmentId });
    }

    return results;
  }

  // Wait for the assignments table to appear in the DOM (handles React/Stimulus hydration).
  // Resolves as soon as a <tbody tr> is found, or after the timeout (2s).
  function waitForTable(timeoutMs = 2000) {
    return new Promise((resolve) => {
      if (document.querySelector("tbody tr")) { resolve(); return; }
      const observer = new MutationObserver(() => {
        if (document.querySelector("tbody tr")) { observer.disconnect(); resolve(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(); }, timeoutMs);
    });
  }

  // ── Get assignments data ──────────────────────────────────────────────────

  let courseName = "";
  let assignments = [];

  const onAssignmentsPage = /\/courses\/\d+\/assignments($|\?)/.test(
    window.location.pathname + window.location.search
  );

  if (onAssignmentsPage) {
    // Wait for the table to render (handles both server-rendered and JS-hydrated pages)
    await waitForTable(2000);
    courseName = extractCourseName(document, true);
    assignments = extractAssignments(document);
    console.log(`[gs-sync] live DOM: courseName="${courseName}" assignments=${assignments.length}`);
  }

  // Fallback: fetch the assignments page HTML (works when student is on another course page,
  // and serves as a second chance when the live DOM parse found nothing)
  if (assignments.length === 0) {
    try {
      const resp = await fetch(`/courses/${gsCourseId}/assignments`, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
      });
      if (resp.ok) {
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        if (!courseName) courseName = extractCourseName(doc, false);
        assignments = extractAssignments(doc);
        console.log(`[gs-sync] fetched HTML: courseName="${courseName}" assignments=${assignments.length}`);
      }
    } catch (err) {
      console.warn("[gs-sync] fetch fallback failed:", err?.message);
    }
  }

  if (assignments.length === 0) {
    console.log(`[gs-sync] course ${gsCourseId}: no assignments found — skipping`);
    return;
  }

  // Final course name fallback: use gsCourseId so we still send something
  if (!courseName) {
    courseName = `GS-${gsCourseId}`;
    console.warn(`[gs-sync] course ${gsCourseId}: could not determine course name, using "${courseName}"`);
  }

  const graded = assignments.filter((a) => a.score !== null).length;
  console.log(`[gs-sync] sending: course="${courseName}" total=${assignments.length} graded=${graded}`);

  // ── Send to Study Circle ──────────────────────────────────────────────────
  try {
    const res = await fetch(`https://${scUrl}/api/gradescope/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        courses: [{ name: courseName, gradescopeCourseId: gsCourseId, assignments }],
      }),
    });
    const data = res.ok ? await res.json() : null;
    console.log(`[gs-sync] API response ${res.status}:`, data);

    // Only set debounce if we actually sent data successfully
    if (res.ok) {
      await chrome.storage.local.set({ [debounceKey]: Date.now() });
    }
  } catch (err) {
    console.warn("[gs-sync] API request failed:", err?.message);
  }
})();
