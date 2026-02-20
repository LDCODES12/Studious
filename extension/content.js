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
 *   - Syllabus PDF URLs (auto-detected by name + peek; URLs sent to background
 *     which routes them through an offscreen document for text extraction)
 *
 * PDF text extraction is handled entirely in the browser via pdfjs-dist
 * running in an offscreen document — the server receives plain text, not binary.
 */

/**
 * Given a Canvas syllabus_body HTML string, try to extract just the section
 * that contains the weekly schedule. If we find a heading like
 * "Week-by-Week Schedule" or "Course Schedule", return the HTML from that
 * heading to the end of the document. Otherwise return the full HTML.
 * Returns null if the input is empty/short.
 */
function extractScheduleSection(html) {
  if (!html || html.trim().length < 100) return null;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const SCHEDULE_RE = /week.{0,15}(schedule|topic|lecture|class)|course\s+(schedule|outline|calendar)|lecture\s+schedule/i;
    const headings = doc.querySelectorAll("h1,h2,h3,h4,h5,h6");
    for (const h of headings) {
      if (SCHEDULE_RE.test(h.textContent ?? "")) {
        // Collect all sibling/following content after this heading
        const parts = [h.outerHTML];
        let el = h.nextElementSibling;
        while (el) {
          parts.push(el.outerHTML);
          el = el.nextElementSibling;
        }
        const section = parts.join("\n");
        // Return just the schedule section — smaller, more focused for AI
        if (section.length > 200) return section;
      }
    }
  } catch { /* DOMParser unavailable */ }
  return html.trim().length > 100 ? html : null;
}

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

  /**
   * Peek at the first 64 KB of a PDF via an HTTP Range request and return
   * true if it looks like a syllabus. PDFs embed text as semi-readable byte
   * sequences — enough to detect keywords like "syllabus", "week 1", etc.
   * without downloading the full file.
   */
  async function peekIsSyllabus(url) {
    try {
      const res = await fetch(url, {
        credentials: "include",
        headers: { Range: "bytes=0-65535" },
      });
      if (!res.ok) return false;
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let raw = "";
      for (let i = 0; i < bytes.byteLength; i += 1024) {
        raw += String.fromCharCode(...bytes.subarray(i, Math.min(i + 1024, bytes.byteLength)));
      }
      // Strip null bytes (common in PDF UTF-16 text encoding)
      const text = raw.replace(/\0/g, "");
      return /syllab|course\s{0,3}schedul|week\s{0,3}\d|lecture\s{0,3}\d|course\s{0,3}outline/i.test(text);
    } catch { return false; }
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
        // Syllabus HTML sent to the server — extract just the schedule section
        // when possible so the AI receives focused signal, not a policy dump.
        syllabusBody: extractScheduleSection(c.syllabus_body),
        // Keep the FULL original HTML locally for PDF link discovery (Source 0).
        // PDF links are often in a "Useful Links" section that gets stripped by
        // extractScheduleSection. Never sent to the server.
        _rawSyllabusBody: c.syllabus_body ?? null,
        // Populated below: { fileName, url } entries for the offscreen doc to parse
        syllabusFileUrls: [],
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

      // ── Modules (fallback topic structure + source of file download URLs) ───
      // include[]=content_details gives us direct download URLs for File items —
      // much more reliable than the files endpoint which is often restricted.
      const rawModules = [];
      try {
        const fetched = await fetchAll(
          `${BASE}/courses/${course.id}/modules?include[]=items&include[]=content_details&per_page=100`
        );
        rawModules.push(...fetched);
        for (const mod of rawModules) {
          const items    = mod.items ?? [];
          const topics   = items.filter((it) => ["Page", "SubHeader", "ExternalUrl"].includes(it.type)).map((it) => it.title).filter(Boolean);
          const readings = items.filter((it) => it.type === "File").map((it) => it.title).filter(Boolean);
          payload.modules.push({ courseId: course.id, moduleId: mod.id, position: mod.position, name: mod.name, topics, readings });
        }
      } catch { /* modules disabled — skip */ }

      // ── Canvas Pages — look for syllabus/schedule pages ───────────────────
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
              course.syllabusBody = (course.syllabusBody ?? "") + "\n" + bodyHtml;
            }
          } catch { /* skip */ }
        }
      } catch { /* pages endpoint not available */ }

      // ── Syllabus PDF URLs ──────────────────────────────────────────────────
      // We collect download URLs here; the offscreen document (background.js)
      // fetches + text-extracts them via pdfjs-dist — no base64, no server PDF work.
      //
      // content_details.url is the Canvas API info endpoint, NOT a download URL.
      // Instead use content_id → GET /api/v1/files/:id to get the real download URL.
      // Fallback: course files endpoint (often restricted for students).
      // Strategy: name-match first, then peek inside unmatched ones. Cap at 3.
      {
        const SYLLABUS_NAME_RE = /syllab|schedul|course[\s._-]?(guide|outline|info|overview|pack)/i;
        const toFetch       = []; // { name, url } — URLs to send for text extraction
        const peekCandidates = []; // { title, content_id } — resolve later if needed
        const seenIds       = new Set();

        // ── Source 0: PDF links embedded in the syllabus HTML body ───────────
        // Professors often link directly to their PDF syllabus from the Canvas
        // syllabus page (e.g. "Math 2130 Syllabus (Spring 2026).pdf ↓").
        // These never appear in the Files API — only in the HTML body.
        // IMPORTANT: scan _rawSyllabusBody (full original HTML), NOT syllabusBody
        // (which may be just the extracted schedule section and could be missing
        // the "Useful Links" or header area where PDF links often live).
        const htmlToScan = course._rawSyllabusBody ?? course.syllabusBody;
        if (htmlToScan) {
          try {
            const doc = new DOMParser().parseFromString(htmlToScan, "text/html");
            for (const a of doc.querySelectorAll("a[href]")) {
              const href = a.href; // absolute URL (DOMParser resolves relative to page)
              if (!href) continue;
              // Canvas inline file: /courses/:id/files/:fileId[/download]
              const canvasMatch = href.match(/\/courses\/\d+\/files\/(\d+)/);
              if (canvasMatch) {
                const fileId = canvasMatch[1];
                if (seenIds.has(fileId)) continue;
                seenIds.add(fileId);
                try {
                  const [fileInfo] = await fetchAll(`${BASE}/files/${fileId}`);
                  // Canvas returns various content-type values for PDFs:
                  // "application/pdf", "application/pdf; charset=binary",
                  // "application/octet-stream", or sometimes nothing.
                  // Fall back to checking the filename extension.
                  const ct = fileInfo?.["content-type"] ?? "";
                  const isPdf = ct.includes("pdf") || (fileInfo?.display_name ?? "").toLowerCase().endsWith(".pdf");
                  if (fileInfo?.url && isPdf && (fileInfo.size ?? 0) < 5_000_000) {
                    const name = fileInfo.display_name ?? a.textContent?.trim() ?? "syllabus.pdf";
                    console.log("[content] Source 0 found PDF:", name, ct);
                    toFetch.push({ name, url: fileInfo.url });
                  }
                } catch { /* restricted — skip */ }
              } else if (/\.pdf(\?|$)/i.test(href) && !seenIds.has(href)) {
                // Direct external PDF link
                seenIds.add(href);
                const name = a.textContent?.trim() || "syllabus.pdf";
                toFetch.push({ name, url: href });
              }
              if (toFetch.length >= 3) break;
            }
          } catch { /* DOMParser failure — skip */ }
        }

        // ── Source 1: module file items — resolve download URL via files API ──
        // Only scan early/orientation modules — syllabi live there, not in weekly
        // lecture modules. Scanning all modules = too many API calls per course.
        const SYLLABUS_MOD_RE = /syllab|orient|welcome|getting.started|course.info|overview/i;
        const earlyMods = rawModules.filter((m, i) => i === 0 || SYLLABUS_MOD_RE.test(m.name ?? ""));
        for (const mod of earlyMods) {
          for (const item of (mod.items ?? [])) {
            if (item.type !== "File" || !item.content_id) continue;
            if (seenIds.has(item.content_id)) continue;
            seenIds.add(item.content_id);
            if (SYLLABUS_NAME_RE.test(item.title ?? "")) {
              // Name match — fetch the real download URL now
              try {
                const [fileInfo] = await fetchAll(`${BASE}/files/${item.content_id}`);
                if (fileInfo?.url && (fileInfo.size ?? 0) < 5_000_000) {
                  toFetch.push({ name: fileInfo.display_name ?? item.title, url: fileInfo.url });
                }
              } catch { /* skip */ }
            } else {
              // No name match — save for peek phase (early modules only)
              peekCandidates.push({ title: item.title, content_id: item.content_id });
            }
          }
        }

        // ── Source 2: course files endpoint (fallback) ───────────────────────
        try {
          const files = await fetchAll(
            `${BASE}/courses/${course.id}/files?content_types[]=application/pdf&per_page=100&sort=created_at&order=asc`
          );
          for (const f of files) {
            if (!f.url || (f.size ?? 0) === 0 || (f.size ?? 0) > 5_000_000) continue;
            if (seenIds.has(f.id)) continue;
            seenIds.add(f.id);
            if (SYLLABUS_NAME_RE.test(f.display_name ?? "")) {
              toFetch.push({ name: f.display_name, url: f.url });
            } else {
              peekCandidates.push({ title: f.display_name, url: f.url });
            }
          }
        } catch { /* files endpoint restricted */ }

        // ── Peek inside unmatched candidates if still under limit ────────────
        if (toFetch.length < 3) {
          for (const candidate of peekCandidates) {
            if (toFetch.length >= 3) break;
            try {
              // Resolve download URL if we only have content_id
              let url = candidate.url;
              if (!url && candidate.content_id) {
                const [fileInfo] = await fetchAll(`${BASE}/files/${candidate.content_id}`);
                const ct2 = fileInfo?.["content-type"] ?? "";
                const isPdf2 = ct2.includes("pdf") || (fileInfo?.display_name ?? "").toLowerCase().endsWith(".pdf");
                if (!fileInfo?.url || !isPdf2) continue;
                if ((fileInfo.size ?? 0) > 5_000_000) continue;
                url = fileInfo.url;
              }
              if (url && await peekIsSyllabus(url)) {
                toFetch.push({ name: candidate.title, url });
              }
            } catch { /* skip */ }
          }
        }

        // ── Collect URLs for offscreen document to fetch + extract ───────────
        // The actual downloading and PDF parsing is done by the offscreen document
        // in background.js — we just pass the pre-signed URLs along.
        for (const { name, url } of toFetch.slice(0, 3)) {
          course.syllabusFileUrls.push({ fileName: name, url });
        }

        // ── Per-course Scout diagnostic ───────────────────────────────────
        console.log(
          `[scout] ${course.name}:`,
          `syllabusBody=${course.syllabusBody?.length ?? 0}c`,
          `| rawBody=${course._rawSyllabusBody?.length ?? 0}c`,
          `| PDFs queued=[${course.syllabusFileUrls.map((f) => `"${f.fileName}"`).join(", ") || "none"}]`
        );
      }
    }

    // Strip local-only fields before sending to server
    for (const c of courses) delete c._rawSyllabusBody;

    progress(90, "Saving to Study Circle…");
    chrome.runtime.sendMessage({ type: "CANVAS_DATA", payload });
  } catch (err) {
    chrome.runtime.sendMessage({ type: "SYNC_ERROR", error: `Sync failed: ${err.message}` });
  }
})();
