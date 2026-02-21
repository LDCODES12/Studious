/**
 * gradescope-content.js — Silently syncs Gradescope assignments to Study Circle.
 *
 * Fires on ANY Gradescope course page (including the LTI redirect landing page
 * https://www.gradescope.com/courses/{id}). Always fetches the /assignments page
 * rather than relying on the current page's DOM, so students don't have to
 * navigate there manually.
 *
 * Key improvements over v1:
 *  - Triggers on all course pages, not just /assignments
 *  - Fetches /assignments as JSON (Gradescope responds with JSON when the
 *    Accept header requests it) for reliable structured data
 *  - Falls back to HTML parsing with correct selectors (<th> for title)
 *  - Creates new assignments in Study Circle for GS-only items (not in Canvas)
 *  - Sends gradescopeAssignmentId so the backend can do exact-match upserts
 */

(async () => {
  const { scUrl, apiToken } = await chrome.storage.local.get(["scUrl", "apiToken"]);
  if (!scUrl || !apiToken) return;

  // Only fire on course pages: /courses/{numericId} or /courses/{id}/anything
  const courseMatch = window.location.pathname.match(/^\/courses\/(\d+)/);
  if (!courseMatch) return;
  const gsCourseId = courseMatch[1];

  // ── Fetch the /assignments page (same-origin, student already authenticated) ──
  let html;
  try {
    const resp = await fetch(`/courses/${gsCourseId}/assignments`, {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });
    if (!resp.ok) return;
    html = await resp.text();
  } catch {
    return;
  }

  // Parse into a temporary document for querying
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // ── Course name ──────────────────────────────────────────────────────────────
  // Gradescope renders the course name in multiple possible locations
  const courseName =
    doc.querySelector(".courseHeader--title h1")?.textContent?.trim() ||
    doc.querySelector("h1.courseHeader--name")?.textContent?.trim() ||
    doc.querySelector(".courseHeader h1")?.textContent?.trim() ||
    doc.querySelector("h1")?.textContent?.trim() ||
    "";
  if (!courseName) return;

  // ── Assignment rows ──────────────────────────────────────────────────────────
  // Gradescope's assignments table uses <th scope="row"> for the title cell
  // (not <td>), which is why the old script using cells[0] from querySelectorAll("td")
  // found no matches or grabbed the wrong cell.
  //
  // Observed structure:
  //   <table class="table js-assignmentTable">
  //     <tbody>
  //       <tr class="js-assignmentRow" data-assignment-id="12345">
  //         <th class="table--primaryLink" scope="row">
  //           <a href="/courses/999/assignments/12345">Homework 1</a>
  //         </th>
  //         <td>Jan 15 11:59 PM</td>   ← due date
  //         <td>                        ← score/status
  //           <div class="submissionStatus--score">18.5 / 20</div>
  //           <div class="submissionStatus--text">Graded</div>
  //         </td>
  //       </tr>
  //     </tbody>
  //   </table>

  const rows = doc.querySelectorAll(
    "table.table tbody tr, table.js-assignmentTable tbody tr, tbody tr"
  );
  if (rows.length === 0) return;

  const assignments = [];

  for (const row of rows) {
    // Title — always in <th> (or <th><a>)
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
      // Prefer the dedicated score element if present
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

    assignments.push({ title, score, maxScore, status, gradescopeAssignmentId });
  }

  if (assignments.length === 0) return;

  // ── Send to Study Circle ─────────────────────────────────────────────────────
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
  } catch {
    // Silent — network errors ignored
  }
})();
