/**
 * gradescope-sync.js — Injected into a Gradescope tab by background.js during sync.
 *
 * Unlike gradescope-content.js (passive, single course, auto-fires on page visit),
 * this script scrapes ALL of the student's Gradescope courses in one shot.
 *
 * Flow:
 *   1. Fetch the Gradescope dashboard (same-origin) → find all course links
 *   2. For each course, fetch /courses/:id/assignments → parse the assignments table
 *   3. Send { type: "GS_SYNC_DATA", courses: [...] } back to the background
 *
 * If the user isn't logged into Gradescope, the dashboard fetch returns a login
 * page with no course links → courses=[] → background skips gracefully.
 */

(async () => {
  const LOG = "[gs-full-sync]";

  function courseNameFromTitle(title) {
    if (!title) return "";
    const stripped = title.replace(/\s*[-|]\s*Gradescope\s*$/i, "").trim();
    const parts = stripped.split("|");
    return parts[parts.length - 1].trim();
  }

  function extractAssignments(doc) {
    const rows = doc.querySelectorAll(
      "table.table--assignments tbody tr, " +
      "table.js-assignmentsTable tbody tr, " +
      "table.table tbody tr, " +
      "table.js-assignmentTable tbody tr, " +
      "tbody tr"
    );
    const results = [];

    for (const row of rows) {
      const titleLink = row.querySelector("th a");
      const titleCell = row.querySelector("th");
      const title =
        titleLink?.textContent?.trim() || titleCell?.textContent?.trim();
      if (!title) continue;

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

  try {
    // ── Step 1: Fetch the Gradescope dashboard ──────────────────────────────
    // Same-origin fetch uses the user's session cookies automatically.
    const dashResp = await fetch("https://www.gradescope.com/", {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });

    if (!dashResp.ok) {
      console.warn(`${LOG} dashboard fetch failed: ${dashResp.status}`);
      chrome.runtime.sendMessage({ type: "GS_SYNC_DATA", courses: [] });
      return;
    }

    const dashHtml = await dashResp.text();
    const dashDoc = new DOMParser().parseFromString(dashHtml, "text/html");

    // ── Step 2: Discover all courses ────────────────────────────────────────
    // Gradescope's dashboard lists courses as links to /courses/:numericId.
    // We collect unique course IDs and a preliminary name from the link text.
    const courseMap = new Map();

    for (const a of dashDoc.querySelectorAll('a[href*="/courses/"]')) {
      const href = a.getAttribute("href") ?? "";
      const match = href.match(/\/courses\/(\d+)/);
      if (!match) continue;
      const courseId = match[1];
      if (courseMap.has(courseId)) continue;
      const name = a.textContent?.trim();
      if (name && name.length > 1) courseMap.set(courseId, name);
    }

    if (courseMap.size === 0) {
      console.log(`${LOG} no courses found on dashboard (not logged in?)`);
      chrome.runtime.sendMessage({ type: "GS_SYNC_DATA", courses: [] });
      return;
    }

    console.log(`${LOG} found ${courseMap.size} courses on dashboard`);

    // ── Step 3: Scrape assignments for each course ──────────────────────────
    const courses = [];

    for (const [courseId, dashName] of courseMap) {
      try {
        const resp = await fetch(`/courses/${courseId}/assignments`, {
          credentials: "same-origin",
          headers: { Accept: "text/html" },
        });
        if (!resp.ok) {
          console.warn(`${LOG} course ${courseId}: assignments fetch ${resp.status}`);
          continue;
        }

        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, "text/html");

        // Course name: prefer the <title> tag (most reliable), fall back to dashboard text
        const titleName = courseNameFromTitle(doc.querySelector("title")?.textContent);
        const courseName = titleName || dashName;

        const assignments = extractAssignments(doc);

        const graded = assignments.filter((a) => a.score !== null).length;
        console.log(`${LOG} "${courseName}" (${courseId}): ${assignments.length} assignments, ${graded} graded`);

        courses.push({
          name: courseName,
          gradescopeCourseId: courseId,
          assignments,
        });
      } catch (err) {
        console.warn(`${LOG} course ${courseId}: error —`, err?.message);
      }
    }

    console.log(`${LOG} done: ${courses.length} courses with assignments`);
    chrome.runtime.sendMessage({ type: "GS_SYNC_DATA", courses });

  } catch (err) {
    console.error(`${LOG} fatal error:`, err);
    chrome.runtime.sendMessage({ type: "GS_SYNC_DATA", courses: [] });
  }
})();
