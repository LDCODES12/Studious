/**
 * content.js — injected into Canvas pages by the background service worker.
 *
 * Two-phase sync:
 *   Phase 1 (window.__sc_selectedIds not set) → fetch course list only
 *   Phase 2 (window.__sc_selectedIds set by background before injection) → fetch full data
 *
 * Phase info is passed via a window variable set by an inline executeScript call
 * immediately before this file is injected — avoids any chrome.storage.session
 * dependency inside the content script.
 *
 * Phase 2 collects per course:
 *   - Assignments (with due dates)
 *   - Canvas modules (fallback topic structure)
 *   - syllabus_body HTML (Canvas's built-in syllabus page)
 *   - Syllabus PDF files (auto-detected by name, downloaded if < 3 MB)
 *
 * The import API uses syllabus content to run AI topic extraction,
 * producing a proper weekly schedule rather than just module names.
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

  /** Convert an ArrayBuffer to a base64 string (safe for large files). */
  function bufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    // 1 KB chunks — safe for call stack regardless of file size
    for (let i = 0; i < bytes.byteLength; i += 1024) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 1024, bytes.byteLength)));
    }
    return btoa(binary);
  }

  function progress(percent, label) {
    chrome.runtime.sendMessage({ type: "SYNC_PROGRESS", percent, label });
  }

  // ── Check phase via window variable (set by background before injection) ──
  const selectedIds = window.__sc_selectedIds ?? null;
  delete window.__sc_selectedIds;

  // ── Phase 1: fetch course list and let user pick ──────────────────────────
  if (!selectedIds) {
    try {
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
    } catch (err) {
      chrome.runtime.sendMessage({ type: "SYNC_ERROR", error: `Could not fetch courses: ${err.message}` });
    }
    return;
  }

  // ── Phase 2: fetch full data for selected courses only ────────────────────
  try {
    const selectedSet = new Set(selectedIds.map(String));

    progress(10, "Fetching your courses…");

    // Include syllabus_body in the bulk course fetch — one call, no extra round-trips
    const rawCourses = await fetchAll(
      `${BASE}/courses?enrollment_type=student&enrollment_state=active` +
      `&include[]=teachers&include[]=term&include[]=syllabus_body&per_page=100`
    );

    const courses = rawCourses
      .filter((c) => c.name && !c.access_restricted_by_date && selectedSet.has(String(c.id)))
      .map((c) => ({
        id: c.id,
        name: c.name,
        courseCode: c.course_code ?? null,
        term: c.term?.name ?? null,
        instructor: c.teachers?.[0]?.display_name ?? null,
        // Syllabus HTML — may be null, empty, or rich HTML with the full schedule
        syllabusBody: (c.syllabus_body && c.syllabus_body.trim().length > 100)
          ? c.syllabus_body
          : null,
        // Will be populated below
        syllabusFiles: [],
      }));

    const payload = { courses, assignments: [], modules: [] };
    const total   = courses.length;

    for (let i = 0; i < courses.length; i++) {
      const course = courses[i];
      const pct = 15 + Math.floor((i / total) * 70);
      progress(pct, `Syncing ${course.name}… (${i + 1}/${total})`);

      // ── Assignments ────────────────────────────────────────────────────────
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

      // ── Modules (fallback topic structure if no syllabus content) ──────────
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

      // ── Canvas Pages — look for syllabus/schedule pages ───────────────────
      // Professors often create a Canvas Page titled "Syllabus" instead of using
      // the built-in syllabus field (which is why syllabus_body is often empty).
      try {
        const allPages = await fetchAll(
          `${BASE}/courses/${course.id}/pages?per_page=50&sort=updated_at&order=desc`
        );
        const syllabusPages = allPages.filter((p) =>
          /syllab|schedul|course.{0,10}info|course.{0,10}guide|course.{0,10}outline|course.{0,10}overview/i.test(p.title || "")
        );
        for (const p of syllabusPages.slice(0, 3)) {
          try {
            const [pageData] = await fetchAll(`${BASE}/courses/${course.id}/pages/${p.url}`);
            const bodyHtml = pageData?.body?.trim();
            if (bodyHtml && bodyHtml.length > 200) {
              // Append to syllabusBody — server-side htmlToText will strip tags
              course.syllabusBody = (course.syllabusBody ?? "") + "\n" + bodyHtml;
            }
          } catch { /* skip individual page fetch failures */ }
        }
      } catch { /* pages endpoint not available */ }

      // ── Syllabus PDF files ─────────────────────────────────────────────────
      // Two strategies to find the syllabus PDF:
      //   1. Filename match (broad regex)
      //   2. Chronological: first 3 PDFs uploaded to the course (syllabi are
      //      uploaded at semester start; weekly lecture PDFs come later)
      // Cap at 3 PDFs total to avoid downloading lecture slides.
      try {
        const files = await fetchAll(
          `${BASE}/courses/${course.id}/files?content_types[]=application/pdf&per_page=100&sort=created_at&order=asc`
        );

        // Score each file: name match = high priority, else use upload order
        const SYLLABUS_RE = /syllab|schedul|course[\s._-]?(guide|outline|info|overview|pack)|course\s*\d/i;
        const scored = files
          .filter((f) => (f.size ?? 0) > 0 && (f.size ?? 0) < 5_000_000)
          .map((f, idx) => ({ file: f, score: SYLLABUS_RE.test(f.display_name ?? "") ? 1000 - idx : -idx }))
          .sort((a, b) => b.score - a.score);

        for (const { file } of scored.slice(0, 3)) {
          try {
            const fileRes = await fetch(file.url, { credentials: "include" });
            if (!fileRes.ok) continue;
            const buf = await fileRes.arrayBuffer();
            course.syllabusFiles.push({
              fileName: file.display_name,
              base64: bufferToBase64(buf),
            });
          } catch { /* skip individual download failures */ }
        }
      } catch { /* files endpoint not available for this course */ }
    }

    progress(90, "Saving to Study Circle…");
    chrome.runtime.sendMessage({ type: "CANVAS_DATA", payload });
  } catch (err) {
    chrome.runtime.sendMessage({ type: "SYNC_ERROR", error: `Sync failed: ${err.message}` });
  }
})();
