/**
 * content.js — injected into Canvas pages by the background service worker.
 *
 * Two-phase sync:
 *   Phase 1 (no selectedCourseIds in session) → fetch course list only
 *   Phase 2 (selectedCourseIds set)           → fetch full data for chosen courses
 */

(async function canvasSync() {
  const BASE = window.location.origin + "/api/v1";

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function fetchAll(url) {
    const results = [];
    let next = url;
    while (next) {
      const res = await fetch(next, { credentials: "include" });
      if (!res.ok) throw new Error(`Canvas API ${res.status}: ${next}`);
      const page = await res.json();
      if (!Array.isArray(page)) { results.push(page); break; }
      results.push(...page);
      const link  = res.headers.get("Link") ?? "";
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

  // ── Check phase ───────────────────────────────────────────────────────────
  const session = await chrome.storage.session.get(["selectedCourseIds"]);
  const selectedIds = session.selectedCourseIds ?? null;

  // ── Phase 1: fetch course list and let user pick ──────────────────────────
  if (!selectedIds) {
    progress(30, "Fetching your courses…");

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
        term: c.term?.name ?? null,
        instructor: c.teachers?.[0]?.display_name ?? null,
      }));

    if (courses.length === 0) {
      chrome.runtime.sendMessage({ type: "SYNC_ERROR", error: "No active Canvas courses found." });
      return;
    }

    chrome.runtime.sendMessage({ type: "CANVAS_COURSES", courses });
    return;
  }

  // ── Phase 2: fetch full data for selected courses only ────────────────────
  const selectedSet = new Set(selectedIds.map(String));

  progress(10, "Fetching your courses…");
  const rawCourses = await fetchAll(
    `${BASE}/courses?enrollment_type=student&enrollment_state=active` +
    `&include[]=teachers&include[]=term&per_page=100`
  );

  const courses = rawCourses
    .filter((c) => c.name && !c.access_restricted_by_date && selectedSet.has(String(c.id)))
    .map((c) => ({
      id: c.id,
      name: c.name,
      courseCode: c.course_code ?? null,
      term: c.term?.name ?? null,
      instructor: c.teachers?.[0]?.display_name ?? null,
    }));

  const payload = { courses, assignments: [], modules: [] };
  const total   = courses.length;

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
        if (!a.due_at) continue;
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
    } catch { /* restricted — skip */ }

    // Modules
    try {
      const rawModules = await fetchAll(
        `${BASE}/courses/${course.id}/modules?include[]=items&per_page=100`
      );
      for (const mod of rawModules) {
        const items    = mod.items ?? [];
        const topics   = items.filter((it) => ["Page", "SubHeader", "ExternalUrl"].includes(it.type)).map((it) => it.title).filter(Boolean);
        const readings = items.filter((it) => it.type === "File").map((it) => it.title).filter(Boolean);
        payload.modules.push({ courseId: course.id, moduleId: mod.id, position: mod.position, name: mod.name, topics, readings });
      }
    } catch { /* modules disabled — skip */ }
  }

  progress(90, "Saving to Study Circle…");
  chrome.runtime.sendMessage({ type: "CANVAS_DATA", payload });
})();
