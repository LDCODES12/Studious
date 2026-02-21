/**
 * gradescope-content.js — Runs silently on Gradescope assignment pages.
 *
 * When the student visits https://www.gradescope.com/courses/{id}/assignments,
 * this script scrapes visible assignment grades and posts them to the Study
 * Circle backend. Grades appear here before professors move them to Canvas,
 * so this fills the gap between Gradescope grading and Canvas grade sync.
 *
 * No UI — completely silent. Fires once per page load.
 */

(async () => {
  const { scUrl, apiToken } = await chrome.storage.local.get(["scUrl", "apiToken"]);
  if (!scUrl || !apiToken) return; // extension not configured

  // Extract course name from the page heading
  const courseName =
    document.querySelector(".courseHeader--title h1")?.textContent?.trim() ||
    document.querySelector("h1")?.textContent?.trim() ||
    "";
  if (!courseName) return;

  // Parse each row of the assignments table
  const rows = document.querySelectorAll("table.table tbody tr, .js-assignmentTable tbody tr");
  if (rows.length === 0) return;

  const assignments = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 2) continue;

    // Title — first cell, strip whitespace
    const title = cells[0]?.textContent?.trim();
    if (!title) continue;

    // Score — look for a cell containing "X / Y" or "X/Y"
    let score = null;
    let maxScore = null;
    let status = "unsubmitted";

    for (const cell of cells) {
      const text = cell.textContent?.trim() ?? "";

      // Match "18.5 / 20" or "18.5/20" or "18 / 20"
      const scoreMatch = text.match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
      if (scoreMatch) {
        score = parseFloat(scoreMatch[1]);
        maxScore = parseFloat(scoreMatch[2]);
        status = "graded";
        break;
      }

      // Status indicators
      const lower = text.toLowerCase();
      if (lower === "submitted" || lower === "graded") {
        status = "submitted";
      }
    }

    assignments.push({ title, score, maxScore, status });
  }

  if (assignments.length === 0) return;

  // Post to Study Circle backend
  try {
    await fetch(`https://${scUrl}/api/gradescope/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        courses: [{ name: courseName, assignments }],
      }),
    });
  } catch {
    // Silently ignore network errors
  }
})();
