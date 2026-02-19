/**
 * content.js — injected into Canvas pages by the background service worker.
 * Makes authenticated Canvas API calls (session cookies included automatically).
 * Sends structured data back via chrome.runtime.sendMessage.
 */

(async function canvasSync() {
  const BASE = window.location.origin + "/api/v1";

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Follow Canvas Link-header pagination and collect all results */
  async function fetchAll(url, onProgress) {
    const results = [];
    let next = url;
    while (next) {
      const res = await fetch(next, { credentials: "include" });
      if (!res.ok) throw new Error(`Canvas API ${res.status}: ${next}`);
      const page = await res.json();
      if (!Array.isArray(page)) {
        // Single object response — wrap it
        results.push(page);
        break;
      }
      results.push(...page);
      if (onProgress) onProgress(results.length);

      // Parse Link header for next page
      const link = res.headers.get("Link") ?? "";
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      next = match ? match[1] : null;
    }
    return results;
  }

  function stripHtml(html) {
    if (!html) return null;
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000) || null;
  }

  function progress(percent, label) {
    chrome.runtime.sendMessage({ type: "SYNC_PROGRESS", percent, label });
  }

  // ── Step 1: Active courses ────────────────────────────────────────────────
  progress(10, "Fetching your courses…");

  const rawCourses = await fetchAll(
    `${BASE}/courses?enrollment_type=student&enrollment_state=active` +
    `&include[]=teachers&include[]=term&per_page=100`
  );

  const courses = rawCourses
    .filter((c) => c.name && !c.access_restricted_by_date)
    .map((c) => ({
      id: c.id,
      name: c.name,
      courseCode: c.course_code ?? null,
      term: c.enrollment_term_id ? (c.term?.name ?? null) : null,
      instructor: c.teachers?.[0]?.display_name ?? null,
    }));

  if (courses.length === 0) {
    chrome.runtime.sendMessage({ type: "SYNC_ERROR", error: "No active Canvas courses found. Make sure you are enrolled in courses this term." });
    return;
  }

  const payload = { courses, assignments: [], modules: [] };
  const total = courses.length;

  // ── Step 2: Assignments + Modules per course ──────────────────────────────
  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const pct = 15 + Math.floor((i / total) * 70);
    progress(pct, `Syncing ${course.name}… (${i + 1}/${total})`);

    // Assignments
    try {
      const rawAssignments = await fetchAll(
        `${BASE}/courses/${course.id}/assignments?per_page=100&order_by=due_at&include[]=submission`
      );

      for (const a of rawAssignments) {
        if (!a.due_at) continue; // skip undated
        if (a.locked_for_user && !a.due_at) continue;

        payload.assignments.push({
          id: a.id,
          courseId: course.id,
          title: a.name,
          dueDate: a.due_at,
          description: stripHtml(a.description),
          submissionType: a.submission_types?.[0] ?? "assignment",
          htmlUrl: a.html_url ?? null,
          pointsPossible: a.points_possible ?? null,
        });
      }
    } catch {
      // Assignments may be restricted — skip gracefully
    }

    // Modules (weekly content structure)
    try {
      const rawModules = await fetchAll(
        `${BASE}/courses/${course.id}/modules?include[]=items&per_page=100`
      );

      for (const mod of rawModules) {
        const items = mod.items ?? [];

        // Content items → topics (Pages, SubHeaders, ExternalUrls)
        const topics = items
          .filter((it) => ["Page", "SubHeader", "ExternalUrl"].includes(it.type))
          .map((it) => it.title)
          .filter(Boolean);

        // File and reading items → readings
        const readings = items
          .filter((it) => it.type === "File")
          .map((it) => it.title)
          .filter(Boolean);

        payload.modules.push({
          courseId: course.id,
          moduleId: mod.id,
          position: mod.position,
          name: mod.name,
          topics,
          readings,
        });
      }
    } catch {
      // Modules may not be enabled for this course — skip
    }
  }

  // ── Done — return payload to background ──────────────────────────────────
  progress(90, "Saving to Study Circle…");
  chrome.runtime.sendMessage({ type: "CANVAS_DATA", payload });
})();
