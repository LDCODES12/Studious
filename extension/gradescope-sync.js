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

  // Direct-to-server logging so we can debug without opening the tab's console.
  // Reads the server URL from chrome.storage.local (set during extension setup).
  let _serverUrl = null;
  let _apiToken = null;
  try {
    const s = await chrome.storage.local.get(["scUrl", "apiToken"]);
    _serverUrl = s.scUrl;
    _apiToken = s.apiToken;
  } catch { /* best-effort */ }

  const _gsLogs = [];
  function gsLog(step, detail) {
    const entry = { t: Date.now(), step, ...detail };
    _gsLogs.push(entry);
    console.log(`${LOG} ${step}`, detail || "");
  }

  async function flushGsLogs() {
    if (!_serverUrl || _gsLogs.length === 0) return;
    try {
      await fetch(`https://${_serverUrl}/api/extension-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ..._apiToken ? { Authorization: `Bearer ${_apiToken}` } : {} },
        body: JSON.stringify(_gsLogs.map(e => ({ source: "gs-sync", ...e }))),
      });
    } catch { /* best-effort */ }
  }

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
    gsLog("script_started", { url: location.href });

    // ── Step 1: Fetch the Gradescope dashboard ──────────────────────────────
    const dashResp = await fetch("https://www.gradescope.com/", {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });

    gsLog("dashboard_fetched", { status: dashResp.status, ok: dashResp.ok, url: dashResp.url });

    if (!dashResp.ok) {
      gsLog("dashboard_fail", { status: dashResp.status });
      await flushGsLogs();
      chrome.runtime.sendMessage({ type: "GS_SYNC_DATA", courses: [] });
      return;
    }

    const dashHtml = await dashResp.text();
    gsLog("dashboard_html", { length: dashHtml.length, snippet: dashHtml.slice(0, 200) });
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

    gsLog("courses_discovered", { count: courseMap.size, ids: [...courseMap.keys()] });

    if (courseMap.size === 0) {
      gsLog("no_courses");
      await flushGsLogs();
      chrome.runtime.sendMessage({ type: "GS_SYNC_DATA", courses: [] });
      return;
    }

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

    gsLog("scraping_done", { courseCount: courses.length });
    await flushGsLogs();
    chrome.runtime.sendMessage({ type: "GS_SYNC_DATA", courses });

  } catch (err) {
    gsLog("fatal_error", { error: err?.message ?? String(err), stack: err?.stack?.slice(0, 300) });
    await flushGsLogs();
    try {
      chrome.runtime.sendMessage({ type: "GS_SYNC_DATA", courses: [] });
    } catch { /* sendMessage itself failed */ }
  }
})();
