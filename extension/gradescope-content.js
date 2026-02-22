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
 */

(async () => {
  const { scUrl, apiToken } = await chrome.storage.local.get(["scUrl", "apiToken"]);
  if (!scUrl || !apiToken) return;

  // Only fire on numeric course pages: /courses/{numericId} or /courses/{id}/anything
  const courseMatch = window.location.pathname.match(/^\/courses\/(\d+)/);
  if (!courseMatch) return;
  const gsCourseId = courseMatch[1];

  // ── Per-course debounce: skip if synced within the last hour ──────────────
  const debounceKey = `gs_synced_${gsCourseId}`;
  const stored = await chrome.storage.local.get([debounceKey]);
  const lastSynced = stored[debounceKey];
  if (lastSynced && Date.now() - lastSynced < 3_600_000) return;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function extractCourseName(doc) {
    return (
      doc.querySelector(".courseHeader--title h1")?.textContent?.trim() ||
      doc.querySelector("h1.courseHeader--name")?.textContent?.trim() ||
      doc.querySelector(".courseHeader h1")?.textContent?.trim() ||
      doc.querySelector("h1")?.textContent?.trim() ||
      ""
    );
  }

  function extractAssignments(doc) {
    const rows = doc.querySelectorAll(
      "table.table tbody tr, table.js-assignmentTable tbody tr, tbody tr"
    );
    const results = [];

    for (const row of rows) {
      // Title — Gradescope uses <th scope="row"> for the title cell
      const titleLink = row.querySelector("th a");
      const titleCell = row.querySelector("th");
      const title =
        titleLink?.textContent?.trim() || titleCell?.textContent?.trim();
      if (!title) continue;

      // Gradescope assignment ID — from data attribute or link href
      const gradescopeAssignmentId =
        row.dataset?.assignmentId ||
        (titleLink
          ? titleLink.getAttribute("href")?.match(/\/assignments\/(\d+)/)?.[1]
          : null) ||
        null;

      const cells = Array.from(row.querySelectorAll("td"));

      let score = null;
      let maxScore = null;
      let status = "unsubmitted";

      for (const cell of cells) {
        const scoreEl = cell.querySelector(
          ".submissionStatus--score, [class*='score']"
        );
        const scoreText = scoreEl
          ? scoreEl.textContent?.trim()
          : cell.textContent?.trim();

        if (!scoreText) continue;

        // Match "18.5 / 20", "18.5/20", "18 / 20"
        const m = scoreText.match(/([\d.]+)\s*\/\s*([\d.]+)/);
        if (m) {
          score = parseFloat(m[1]);
          maxScore = parseFloat(m[2]);
          status = "graded";
          break;
        }

        // Status text fallback
        const statusEl = cell.querySelector(
          ".submissionStatus--text, [class*='status']"
        );
        const statusText = (
          statusEl?.textContent ||
          cell.textContent ||
          ""
        )
          .trim()
          .toLowerCase();

        if (
          statusText.includes("submitted") ||
          statusText.includes("graded") ||
          statusText === "submitted"
        ) {
          if (status !== "graded") status = "submitted";
        }
      }

      results.push({ title, score, maxScore, status, gradescopeAssignmentId });
    }

    return results;
  }

  // ── Get assignments data ──────────────────────────────────────────────────

  let courseName = "";
  let assignments = [];

  const onAssignmentsPage = /\/courses\/\d+\/assignments($|\?)/.test(
    window.location.pathname + window.location.search
  );

  if (onAssignmentsPage) {
    // Already on the assignments page — the live DOM is fully rendered.
    // Wait briefly for any client-side hydration to complete.
    await new Promise((r) => setTimeout(r, 800));
    courseName = extractCourseName(document);
    assignments = extractAssignments(document);
  }

  // Fallback: fetch the assignments page HTML (works when student is on another course page)
  if (assignments.length === 0) {
    try {
      const resp = await fetch(`/courses/${gsCourseId}/assignments`, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
      });
      if (resp.ok) {
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        if (!courseName) courseName = extractCourseName(doc);
        assignments = extractAssignments(doc);
      }
    } catch {
      // Silent — network errors ignored
    }
  }

  if (assignments.length === 0) return;

  // Course name fallback: use the page title if no h1 matched
  if (!courseName) {
    courseName =
      document.title?.replace(/\s*[-|].*$/, "").trim() || `GS-${gsCourseId}`;
  }

  // ── Send to Study Circle ──────────────────────────────────────────────────
  try {
    await fetch(`https://${scUrl}/api/gradescope/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        courses: [
          {
            name: courseName,
            gradescopeCourseId: gsCourseId,
            assignments,
          },
        ],
      }),
    });

    // Record successful sync timestamp for this course
    await chrome.storage.local.set({ [debounceKey]: Date.now() });
  } catch {
    // Silent — network errors ignored
  }
})();
