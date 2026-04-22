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
 *   - Media Gallery tab URL (used by background.js to discover Kaltura lecture
 *     transcript attachments without asking the server to scrape Canvas)
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
        // Preserve the top header chunk too so class meeting time/location text
        // ("MWF 10:00-10:50", room, instructor header block) is not lost when a
        // later schedule heading is found. This especially matters for text-only
        // Canvas syllabus pages that do not have a separate PDF.
        if (section.length > 200) {
          const headerChunk = html.slice(0, 3000);
          return `${headerChunk}\n${section}`;
        }
      }
    }
  } catch { /* DOMParser unavailable */ }
  return html.trim().length > 100 ? html : null;
}

(async function canvasSync() {
  const BASE = window.location.origin + "/api/v1";
  const AUTO_IMPORT_PDF_MAX_BYTES = 10_000_000;
  const MATERIAL_CANDIDATE_MAX_BYTES = 20_000_000;
  const SYLLABUS_LINK_SCAN_MAX_PDFS = 40;

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

  async function mapWithConcurrency(items, concurrency, mapper) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), items.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index], index);
      }
    }));

    return results;
  }

  async function fetchCanvasFileInfo(courseId, fileId) {
    try {
      const [fileInfo] = await fetchAll(`${BASE}/courses/${courseId}/files/${fileId}`);
      return fileInfo ?? null;
    } catch {
      try {
        const [fileInfo] = await fetchAll(`${BASE}/files/${fileId}`);
        return fileInfo ?? null;
      } catch {
        return null;
      }
    }
  }

  function fileLooksPdf(fileInfo, fallbackName = "") {
    const contentType = String(fileInfo?.["content-type"] ?? fileInfo?.content_type ?? "");
    const fileName = String(fileInfo?.display_name ?? fallbackName ?? "");
    return contentType.includes("pdf") || fileName.toLowerCase().endsWith(".pdf");
  }

  function resolveCanvasHref(rawHref) {
    if (!rawHref) return "";
    try {
      return new URL(rawHref, window.location.href).toString();
    } catch {
      return rawHref;
    }
  }

  function extractCanvasFileId(href) {
    const match = String(href ?? "").match(/\/(?:courses\/\d+\/)?files\/(\d+)(?:\/|$|[?#])/i);
    return match?.[1] ?? null;
  }

  function extractLinkedPdfRefs(html) {
    if (!html) return [];
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const refs = [];
      const seen = new Set();

      for (const a of doc.querySelectorAll("a[href]")) {
        const href = resolveCanvasHref(a.getAttribute("href") ?? "");
        if (!href) continue;

        const label = a.textContent?.trim() || null;
        const canvasFileId = extractCanvasFileId(href);
        if (canvasFileId) {
          const key = `canvas:${canvasFileId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push({ kind: "canvas", fileId: canvasFileId, href, label });
          continue;
        }

        if (/\.pdf(?:$|[?#])/i.test(href)) {
          const sourceKey = normalizeExternalSourceKey(href);
          const key = `external:${sourceKey}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push({ kind: "external", href, label, sourceKey });
        }
      }

      return refs;
    } catch {
      return [];
    }
  }

  function buildMaterialContextName(moduleName, pageTitle = null) {
    const normalizedModuleName = String(moduleName ?? "").trim() || "Canvas Page";
    const normalizedPageTitle = String(pageTitle ?? "").trim();
    if (!normalizedPageTitle) return normalizedModuleName;
    if (normalizedModuleName.toLowerCase() === normalizedPageTitle.toLowerCase()) {
      return normalizedModuleName;
    }
    return `${normalizedModuleName} - ${normalizedPageTitle}`;
  }

  function findCourseMediaGalleryTab(navTabs) {
    const tabs = Array.isArray(navTabs) ? navTabs : [];
    const isMyMedia = (tab) => /\bmy\s+media\b/i.test(String(tab?.label ?? ""));
    const isMediaGallery = (tab) => /\bmedia\s+gallery\b/i.test(String(tab?.label ?? ""));
    const isKalturaGallery = (tab) => {
      const label = String(tab?.label ?? "");
      return /\bkaltura\b/i.test(label) && /\bgallery\b/i.test(label);
    };

    return (
      tabs.find((tab) => isMediaGallery(tab) && !isMyMedia(tab)) ??
      tabs.find((tab) => isKalturaGallery(tab) && !isMyMedia(tab)) ??
      null
    );
  }

  function stripHtml(html) {
    if (!html) return null;
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000) || null;
  }

  function normalizeExternalSourceKey(rawUrl) {
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      parsed.hash = "";
      parsed.search = "";
      return `external:${parsed.toString()}`;
    } catch {
      return `external:${rawUrl}`;
    }
  }

  function buildMaterialStateKey(sourceKind, sourceKey) {
    return `${sourceKind}:${sourceKey}`;
  }

  function normalizeRemoteUpdatedAt(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  function isRemoteNewer(remoteUpdatedAt, knownUpdatedAt) {
    const remote = normalizeRemoteUpdatedAt(remoteUpdatedAt);
    if (!remote) return false;
    const known = normalizeRemoteUpdatedAt(knownUpdatedAt);
    if (!known) return true;
    return remote.getTime() > known.getTime() + 1000;
  }

  function createEmptyMaterialState(available = false) {
    return {
      available,
      materials: new Map(),
      candidates: new Map(),
      requestedIds: new Set(),
    };
  }

  async function fetchMaterialState(scUrl, apiToken, canvasCourseId) {
    if (!scUrl || !apiToken) return createEmptyMaterialState(false);
    try {
      const res = await fetch(
        `https://${scUrl}/api/canvas/materials/state?canvasCourseId=${canvasCourseId}`,
        { headers: { Authorization: `Bearer ${apiToken}` } }
      );
      if (!res.ok) return createEmptyMaterialState(false);

      const data = await res.json();
      const knownCourse = data?.knownCourse !== false;
      const materials = new Map(
        (data.materials ?? [])
          .filter((item) => item?.sourceKind && item?.sourceKey)
          .map((item) => [
            buildMaterialStateKey(String(item.sourceKind), String(item.sourceKey)),
            item,
          ])
      );
      const candidates = new Map(
        (data.candidates ?? [])
          .filter((item) => item?.contentId)
          .map((item) => [String(item.contentId), item])
      );
      const requestedIds = new Set(
        (data.candidates ?? [])
          .filter((item) => item?.requested)
          .map((item) => String(item.contentId))
      );

      return { available: knownCourse, materials, candidates, requestedIds };
    } catch {
      return createEmptyMaterialState(false);
    }
  }

  function hasRemoteMetadataChanged(candidateState, remoteUpdatedAt, remoteSize) {
    if (!candidateState) return false;
    if (isRemoteNewer(remoteUpdatedAt, candidateState.remoteUpdatedAt ?? candidateState.lastSeenAt ?? null)) {
      return true;
    }
    if (
      typeof remoteSize === "number" &&
      remoteSize > 0 &&
      typeof candidateState.remoteSize === "number" &&
      candidateState.remoteSize > 0 &&
      candidateState.remoteSize !== remoteSize
    ) {
      return true;
    }
    return false;
  }

  function shouldImportSource(materialState, sourceKind, sourceKey, remoteUpdatedAt, remoteSize = null, contentId = sourceKey) {
    if (!materialState.available) return !scoutMode;
    const existing = materialState.materials.get(buildMaterialStateKey(sourceKind, sourceKey));
    const candidateState = contentId ? materialState.candidates.get(String(contentId)) : null;
    if (!existing) {
      if (candidateState?.requested || candidateState?.status === "stale") return true;
      return true;
    }
    if (existing.syncStatus && existing.syncStatus !== "ready") return true;
    if (isRemoteNewer(remoteUpdatedAt, existing.sourceUpdatedAt ?? existing.lastSyncedAt ?? null)) return true;
    return hasRemoteMetadataChanged(candidateState, remoteUpdatedAt, remoteSize);
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
  const syncConfig = window.__sc_syncConfig ?? null;
  const selectedIds = syncConfig?.selectedIds ?? window.__sc_selectedIds ?? null;
  const syncMode = syncConfig?.mode ?? (selectedIds ? "manual" : "picker");
  const scoutMode = syncMode === "scout";
  delete window.__sc_syncConfig;
  delete window.__sc_selectedIds;

  // ── Phase 1: fetch course list and let user pick ──────────────────────────
  if (syncMode === "picker" && !selectedIds) {
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
    progress(10, "Fetching your courses…");

    // Include syllabus_body + enrollment grades in the bulk course fetch.
    // include[]=enrollments is required for total_scores to populate.
    const rawCourses = await fetchAll(
      `${BASE}/courses?enrollment_type=student&enrollment_state=active` +
      `&include[]=teachers&include[]=term&include[]=syllabus_body` +
      `&include[]=enrollments&include[]=total_scores&per_page=100`
    );

    const activeCourses = rawCourses.filter((c) => c.name && !c.access_restricted_by_date);
    let scopedCourses = activeCourses;
    let selectedSet = Array.isArray(selectedIds) && selectedIds.length > 0
      ? new Set(selectedIds.map(String))
      : null;

    if (selectedSet) {
      scopedCourses = activeCourses.filter((c) => selectedSet.has(String(c.id)));
      if (scoutMode && scopedCourses.length === 0 && activeCourses.length > 0) {
        console.log("[scout] stored course scope is stale; falling back to all active courses");
        selectedSet = null;
        scopedCourses = activeCourses;
        await chrome.storage.local.remove(["lastSelectedCourseIds"]);
      }
    }

    const courses = scopedCourses
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
        // Canvas's authoritative weighted grading flag
        applyGroupWeights: c.apply_assignment_group_weights ?? false,
        // Enrollment grades — from include[]=total_scores
        currentGrade: c.enrollments?.[0]?.computed_current_grade ?? c.enrollments?.[0]?.grades?.current_grade ?? null,
        currentScore: c.enrollments?.[0]?.computed_current_score ?? c.enrollments?.[0]?.grades?.current_score ?? null,
        // Populated below: metadata + download URLs for the offscreen doc to parse
        syllabusFileUrls: [],
        // Populated below: all PDF metadata from non-orientation modules
        materialCandidates: [],
        // Populated below: PDFs to actually download (1 auto/module + requested)
        materialFileUrls: [],
        // Kaltura / Media Gallery tab discovered from course navigation
        mediaGalleryTabUrl: null,
        // Term dates for classSchedule semesterStart/End
        termStartAt: c.term?.start_at ?? null,
        termEndAt: c.term?.end_at ?? null,
        // Populated below: 3-week window of Canvas calendar events (class schedule fallback)
        calendarEvents: [],
      }));

    const payload = { syncMode, courses, assignments: [], modules: [], announcements: [], assignmentGroups: [] };

    // Read extension config once — used in Source 3 to fetch requested candidates
    const { scUrl: extScUrl = null, apiToken: extApiToken = null } = await new Promise((resolve) => {
      chrome.storage.local.get(["scUrl", "apiToken"], resolve);
    });
    const total   = courses.length;

    for (let i = 0; i < courses.length; i++) {
      const course = courses[i];
      const pct = 15 + Math.floor((i / total) * 70);
      progress(pct, `Syncing ${course.name}… (${i + 1}/${total})`);

      // ── External tool tab detection (Canvas navigation sidebar) ───────────
      // The tabs API returns relative URLs — make them absolute for
      // chrome.tabs.update in background.js.
      try {
        const navTabs = await fetchAll(`${BASE}/courses/${course.id}/tabs`);
        const gsTab = navTabs.find((t) => /gradescope/i.test(t.label ?? ""));
        if (gsTab) {
          const rawUrl = gsTab.full_url || gsTab.html_url || gsTab.url || "";
          course.gradescopeTabUrl = rawUrl.startsWith("http")
            ? rawUrl
            : window.location.origin + rawUrl;
          console.log(`[scout] ${course.name}: found Gradescope tab → ${course.gradescopeTabUrl}`);
        }

        const mediaTab = findCourseMediaGalleryTab(navTabs);
        if (mediaTab) {
          const rawUrl = mediaTab.full_url || mediaTab.html_url || mediaTab.url || "";
          course.mediaGalleryTabUrl = rawUrl.startsWith("http")
            ? rawUrl
            : window.location.origin + rawUrl;
          console.log(`[scout] ${course.name}: found Media Gallery tab (${mediaTab.label ?? "unknown"}) → ${course.mediaGalleryTabUrl}`);
        }
      } catch (err) {
        console.warn(`[scout] ${course.name}: tabs API error — ${err?.message}`);
      }

      // ── Assignments ────────────────────────────────────────────────────────
      try {
        const rawAssignments = await fetchAll(
          `${BASE}/courses/${course.id}/assignments?per_page=100&order_by=due_at&include[]=submission`
        );
        for (const a of rawAssignments) {
          const ws = a.submission?.workflow_state;
          const submissionStatus =
            ws === "graded" ? "graded"
            : ws === "submitted" || ws === "pending_review" ? "submitted"
            : "not_started";
          payload.assignments.push({
            id: a.id,
            courseId: course.id,
            title: a.name,
            dueDate: a.due_at ?? null,
            availableFrom: a.unlock_at ?? null,
            availableUntil: a.lock_at ?? null,
            description: stripHtml(a.description),
            submissionType: a.submission_types?.[0] ?? "assignment",
            submissionTypes: a.submission_types ?? [],
            gradingType: a.grading_type ?? null,
            omitFromFinalGrade: a.omit_from_final_grade ?? false,
            htmlUrl: a.html_url ?? null,
            pointsPossible: a.points_possible ?? null,
            submissionStatus,
            score: a.submission?.score ?? null,
            submittedAt: a.submission?.submitted_at ?? null,
            excused: a.submission?.excused ?? false,
            late: a.submission?.late ?? false,
            missing: a.submission?.missing ?? false,
            assignmentGroupId: a.assignment_group_id ?? null,
          });
        }

        // Fallback: if no Gradescope tab found, check assignment external tool URLs
        if (!course.gradescopeTabUrl && !course.gradescopeCourseId) {
          for (const a of rawAssignments) {
            const toolUrl = a.external_tool_tag_attributes?.url ?? "";
            if (/gradescope/i.test(toolUrl)) {
              const m = toolUrl.match(/\/courses\/(\d+)/) || toolUrl.match(/[?&]course_id=(\d+)/);
              if (m) {
                course.gradescopeCourseId = m[1];
                console.log(`[scout] ${course.name}: found Gradescope course ID from assignment → ${m[1]}`);
              }
              break;
            }
          }
        }
      } catch { /* restricted — skip */ }

      const materialState = await fetchMaterialState(extScUrl, extApiToken, course.id);

      // ── Modules (fallback topic structure + source of file download URLs) ───
      // include[]=content_details gives us direct download URLs for File items —
      // much more reliable than the files endpoint which is often restricted.
      const rawModules = [];
      const modulePageUrls = new Set();
      const modulePageItems = [];
      try {
        const fetched = await fetchAll(
          `${BASE}/courses/${course.id}/modules?include[]=items&include[]=content_details&per_page=100`
        );
        rawModules.push(...fetched);
        for (const mod of rawModules) {
          const items    = mod.items ?? [];
          const topics   = items.filter((it) => ["Page", "SubHeader", "ExternalUrl"].includes(it.type)).map((it) => it.title).filter(Boolean);
          const readings = items.filter((it) => it.type === "File").map((it) => it.title).filter(Boolean);
          for (const it of items) {
            if (it.type === "Page" && it.page_url) {
              modulePageUrls.add(it.page_url);
              modulePageItems.push({
                moduleId: mod.id,
                moduleName: mod.name ?? "Canvas Module",
                pageUrl: it.page_url,
                pageTitle: it.title ?? null,
              });
            }
          }
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
              // Also update _rawSyllabusBody so Source 0 can find PDF links
              // that are embedded in Canvas Pages (not just in syllabus_body).
              course._rawSyllabusBody = (course._rawSyllabusBody ?? "") + "\n" + bodyHtml;
            }
          } catch { /* skip */ }
        }
      } catch { /* pages endpoint not available */ }

      // ── Module-linked Canvas Pages fallback (important for courses that store
      // syllabus/schedule content in module Pages rather than the syllabus tab) ──
      // We already fetched module items above; if they contain Page links, fetch the
      // top likely syllabus/schedule pages directly by page_url and append bodies.
      try {
        const pageCandidates = [...modulePageUrls].filter((u) =>
          /syllab|schedul|course.{0,10}(schedule|info|outline|overview)|office.{0,5}hours|meeting.{0,5}times/i.test(u)
        );
        let fetchedBodies = 0;
        for (const pageUrl of pageCandidates.slice(0, 5)) {
          try {
            const [pageData] = await fetchAll(`${BASE}/courses/${course.id}/pages/${pageUrl}`);
            const bodyHtml = pageData?.body?.trim();
            if (bodyHtml && bodyHtml.length > 50) {
              course.syllabusBody = (course.syllabusBody ?? "") + "\n" + bodyHtml;
              course._rawSyllabusBody = (course._rawSyllabusBody ?? "") + "\n" + bodyHtml;
              fetchedBodies++;
            }
          } catch { /* skip individual module page */ }
        }
        if (fetchedBodies > 0) {
          console.log(`[scout] ${course.name}: appended ${fetchedBodies} module-linked page bod${fetchedBodies !== 1 ? "ies" : "y"}`);
        }
      } catch { /* module-page fallback failed */ }

      // ── Announcements ──────────────────────────────────────────────────────
      try {
        const rawAnnouncements = await fetchAll(
          `${BASE}/courses/${course.id}/discussion_topics?only_announcements=true&per_page=10&order_by=recent_activity`
        );
        for (const ann of rawAnnouncements.slice(0, 10)) {
          if (!ann.title) continue;
          payload.announcements.push({
            courseId: course.id,
            canvasId: String(ann.id),
            title: ann.title,
            body: stripHtml(ann.message),
            postedAt: ann.posted_at ?? ann.created_at ?? null,
          });
        }
      } catch { /* announcements restricted or disabled */ }

      // ── Assignment Groups (grading categories with weights) ────────────────
      try {
        const rawGroups = await fetchAll(
          `${BASE}/courses/${course.id}/assignment_groups?per_page=100`
        );
        for (const g of rawGroups) {
          payload.assignmentGroups.push({
            courseId: course.id,
            canvasGroupId: String(g.id),
            name: g.name,
            weight: g.group_weight ?? 0,
            position: g.position ?? 0,
            dropLowest: g.rules?.drop_lowest ?? 0,
            dropHighest: g.rules?.drop_highest ?? 0,
            neverDrop: (g.rules?.never_drop ?? []).map(String),
          });
        }
      } catch { /* assignment groups restricted */ }

      // ── Grading Standard (letter grade cutoff table) ───────────────────────
      try {
        const [courseDetail] = await fetchAll(
          `${BASE}/courses/${course.id}?include[]=grading_standard`
        );
        if (courseDetail?.grading_standard?.grading_scheme) {
          course.gradingScheme = courseDetail.grading_standard.grading_scheme;
        }
      } catch { /* grading standard not available */ }

      // ── Canvas Calendar Events (class meeting times fallback) ─────────────
      // Fetches a 6-week window from the course calendar so the server can
      // detect recurring meeting patterns (days/times) when the syllabus PDF
      // doesn't explicitly state them. Silent on error — purely additive.
      try {
        const now = new Date();
        const termStart = course.termStartAt ? new Date(course.termStartAt) : now;
        const scanFrom = new Date(Math.max(termStart.getTime(), now.getTime() - 14 * 86400_000));
        const scanTo   = new Date(scanFrom.getTime() + 42 * 86400_000); // 6-week window
        const startStr = scanFrom.toISOString().split("T")[0];
        const endStr   = scanTo.toISOString().split("T")[0];
        const calEvents = await fetchAll(
          `${BASE}/calendar_events?context_codes[]=course_${course.id}&type=event` +
          `&start_date=${startStr}&end_date=${endStr}&per_page=100`
        );
        course.calendarEvents = calEvents
          .filter((e) => e.start_at && e.end_at)
          .map((e) => ({
            title: e.title ?? "",
            startAt: e.start_at,
            endAt: e.end_at,
            location: e.location_name ?? null,
          }));
        if (course.calendarEvents.length > 0) {
          console.log(`[scout] ${course.name} | calendarEvents: ${course.calendarEvents.length}`);
        }
      } catch { /* calendar events unavailable or restricted */ }

        // ── Syllabus PDF URLs ──────────────────────────────────────────────────
      // We collect download URLs here; the offscreen document (background.js)
      // fetches + text-extracts them via pdfjs-dist — no base64, no server PDF work.
      //
      // content_details.url is the Canvas API info endpoint, NOT a download URL.
      // Instead use content_id → GET /api/v1/files/:id to get the real download URL.
      // Fallback: course files endpoint (often restricted for students).
      // Strategy: name-match first, then peek inside unmatched ones. We keep a
      // generous cap for syllabus-page-linked PDFs because some schedules embed
      // dozens of downloadable lecture PDFs.
      {
        const SYLLABUS_NAME_RE = /syllab|schedul|course[\s._-]?(guide|outline|info|overview|pack)/i;
        const toFetch       = []; // { name, url, sourceKey, sourceKind, remoteSize, remoteUpdatedAt }
        const peekCandidates = []; // { title, content_id, url, sourceKey, remoteSize, remoteUpdatedAt }
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
            const linkedPdfRefs = extractLinkedPdfRefs(htmlToScan);
            for (const ref of linkedPdfRefs) {
              if (ref.kind === "canvas") {
                const fileId = ref.fileId;
                if (seenIds.has(fileId)) continue;
                seenIds.add(fileId);
                try {
                  const fileInfo = await fetchCanvasFileInfo(course.id, fileId);
                  if (fileInfo?.url && fileLooksPdf(fileInfo, ref.label ?? "syllabus.pdf") && (fileInfo.size ?? 0) < AUTO_IMPORT_PDF_MAX_BYTES) {
                    const name = fileInfo.display_name ?? ref.label ?? "syllabus.pdf";
                    console.log("[content] Source 0 found PDF:", name, fileInfo?.["content-type"] ?? "");
                    toFetch.push({
                      name,
                      url: fileInfo.url,
                      sourceKey: String(fileInfo.id ?? fileId),
                      sourceKind: "canvas_syllabus",
                      remoteSize: fileInfo.size ?? null,
                      remoteUpdatedAt: fileInfo.updated_at ?? null,
                    });
                  }
                } catch (err) {
                  console.warn("[content] Source 0: file API failed for fileId", fileId, err?.message ?? err);
                }
              } else {
                // Direct external PDF link
                const sourceKey = ref.sourceKey ?? normalizeExternalSourceKey(ref.href);
                if (seenIds.has(sourceKey)) continue;
                seenIds.add(sourceKey);
                const name = ref.label || "syllabus.pdf";
                toFetch.push({
                  name,
                  url: ref.href,
                  sourceKey,
                  sourceKind: "canvas_syllabus",
                  remoteSize: null,
                  remoteUpdatedAt: null,
                });
              }
              if (toFetch.length >= SYLLABUS_LINK_SCAN_MAX_PDFS) break;
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
            const contentId = String(item.content_id);
            if (seenIds.has(contentId)) continue;
            seenIds.add(contentId);
            if (SYLLABUS_NAME_RE.test(item.title ?? "")) {
              // Name match — fetch the real download URL.
              // Try the course-scoped endpoint first (more permissive for students),
              // then fall back to the global endpoint.
              try {
                let fileInfo;
                try {
                  [fileInfo] = await fetchAll(`${BASE}/courses/${course.id}/files/${item.content_id}`);
                } catch {
                  [fileInfo] = await fetchAll(`${BASE}/files/${item.content_id}`);
                }
                const ct1 = fileInfo?.["content-type"] ?? "";
                const isPdf1 = ct1.includes("pdf") || (fileInfo?.display_name ?? "").toLowerCase().endsWith(".pdf");
                if (fileInfo?.url && isPdf1 && (fileInfo.size ?? 0) < AUTO_IMPORT_PDF_MAX_BYTES) {
                  const name1 = fileInfo.display_name ?? item.title;
                  console.log("[content] Source 1 found PDF:", name1, ct1);
                  toFetch.push({
                    name: name1,
                    url: fileInfo.url,
                    sourceKey: String(fileInfo.id ?? item.content_id),
                    sourceKind: "canvas_syllabus",
                    remoteSize: fileInfo.size ?? null,
                    remoteUpdatedAt: fileInfo.updated_at ?? null,
                  });
                } else if (!fileInfo?.url) {
                  console.warn("[content] Source 1: file API returned no URL for", item.title, item.content_id);
                }
              } catch (err) {
                console.warn("[content] Source 1: file API failed for", item.title, item.content_id, err?.message ?? err);
              }
            } else {
              // No name match — save for peek phase (early modules only)
              peekCandidates.push({
                title: item.title,
                content_id: item.content_id,
                sourceKey: contentId,
                remoteSize: null,
                remoteUpdatedAt: null,
              });
            }
          }
        }

        // ── Source 2: course files endpoint (fallback) ───────────────────────
        try {
          const files = await fetchAll(
            `${BASE}/courses/${course.id}/files?content_types[]=application/pdf&per_page=100&sort=created_at&order=asc`
          );
          for (const f of files) {
            if (!f.url || (f.size ?? 0) === 0 || (f.size ?? 0) > AUTO_IMPORT_PDF_MAX_BYTES) continue;
            const fileId = String(f.id);
            if (seenIds.has(fileId)) continue;
            seenIds.add(fileId);
            if (SYLLABUS_NAME_RE.test(f.display_name ?? "")) {
              toFetch.push({
                name: f.display_name,
                url: f.url,
                sourceKey: fileId,
                sourceKind: "canvas_syllabus",
                remoteSize: f.size ?? null,
                remoteUpdatedAt: f.updated_at ?? null,
              });
            } else {
              peekCandidates.push({
                title: f.display_name,
                url: f.url,
                sourceKey: fileId,
                remoteSize: f.size ?? null,
                remoteUpdatedAt: f.updated_at ?? null,
              });
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
              let fileInfo = null;
              if (!url && candidate.content_id) {
                fileInfo = await fetchCanvasFileInfo(course.id, candidate.content_id);
                const ct2 = fileInfo?.["content-type"] ?? "";
                const isPdf2 = ct2.includes("pdf") || (fileInfo?.display_name ?? "").toLowerCase().endsWith(".pdf");
                if (!fileInfo?.url || !isPdf2) continue;
                if ((fileInfo.size ?? 0) > AUTO_IMPORT_PDF_MAX_BYTES) continue;
                url = fileInfo.url;
              }
              if (url && await peekIsSyllabus(url)) {
                toFetch.push({
                  name: candidate.title,
                  url,
                  sourceKey: candidate.sourceKey ?? String(fileInfo?.id ?? candidate.content_id ?? url),
                  sourceKind: "canvas_syllabus",
                  remoteSize: fileInfo?.size ?? candidate.remoteSize ?? null,
                  remoteUpdatedAt: fileInfo?.updated_at ?? candidate.remoteUpdatedAt ?? null,
                });
              }
            } catch { /* skip */ }
          }
        }

        // ── Collect syllabus URLs for offscreen document to fetch + extract ──
        const syllabusImports = scoutMode ? [] : toFetch;
        for (const { name, url, sourceKey, sourceKind, remoteSize, remoteUpdatedAt } of syllabusImports) {
          if (!shouldImportSource(materialState, sourceKind, sourceKey, remoteUpdatedAt, remoteSize ?? null, sourceKey)) continue;
          course.syllabusFileUrls.push({
            fileName: name,
            url,
            sourceKey,
            sourceKind,
            remoteSize,
            remoteUpdatedAt,
          });
        }

        // ── Source 3: course materials from ALL non-orientation modules ───────
        // Strategy:
        //   1. Collect ALL PDF file metadata (fileName, moduleName, contentId)
        //      across every non-orientation module → materialCandidates.
        //      Sent to canvas/import which upserts them into CanvasMaterialCandidate.
        //   2. Auto-download: first valid PDF per module (≤10 MB) → materialFileUrls.
        //   3. Requested: candidates the student clicked "Add" on are fetched too.
        //      We call GET /api/canvas/materials/pending?canvasCourseId=X to get
        //      the contentIds the user has requested since last sync.
        const materialSeenIds = new Set();

        // Step 1: fetch requested candidate contentIds from our API
        const requestedContentIds = materialState.requestedIds;
        if (requestedContentIds.size > 0) {
          console.log(`[scout] ${course.name} | requested candidates: ${requestedContentIds.size}`);
        }

        const nonOrientationModules = rawModules.filter((mod) => !SYLLABUS_MOD_RE.test(mod.name ?? ""));
        const scoutPreferredModuleIds = new Set(
          scoutMode
            ? nonOrientationModules.slice(-2).map((mod) => mod.id)
            : [],
        );

        // Step 2: scan all non-orientation module file items
        for (const mod of rawModules) {
          // Skip orientation/syllabus modules — Source 1 already covered these
          if (SYLLABUS_MOD_RE.test(mod.name ?? "")) continue;

          const items = (mod.items ?? []).filter(
            (it) => it.type === "File" && it.content_id
          );

          let moduleAutoAdded = false;
          const allowScoutAuto = !scoutMode || scoutPreferredModuleIds.has(mod.id);

          for (const item of items) {
            const cid = String(item.content_id);
            if (seenIds.has(cid) || materialSeenIds.has(cid)) continue;
            materialSeenIds.add(cid);

            // content_details is included via include[]=content_details on the modules
            // endpoint — it gives us the real filename + MIME type + size without
            // needing a separate /files/:id API call for each candidate.
            const details = item.content_details ?? {};
            // item.title = the link label in the module (often human-readable, no extension)
            // details.display_name = the actual stored filename (usually has extension)
            const candidateFileName = details.display_name ?? item.title ?? "file.pdf";
            const contentType = details.content_type ?? "";

            // Only track PDF files as candidates
            const isPdfCandidate =
              contentType.includes("pdf") ||
              candidateFileName.toLowerCase().endsWith(".pdf");
            if (!isPdfCandidate) continue;

            // Skip textbook-sized files from the candidate list (> 20 MB)
            const candidateSize = details.size ?? 0;
            if (candidateSize > MATERIAL_CANDIDATE_MAX_BYTES) continue;

            // Add to candidates list — no extra API call needed
            course.materialCandidates.push({
              fileName: candidateFileName,
              moduleName: mod.name ?? "Unknown Module",
              contentId: cid,
              sourceKind: "canvas_module",
              remoteSize: candidateSize || null,
              remoteUpdatedAt: details.updated_at ?? null,
            });

            const isRequested = requestedContentIds.has(cid);
            const isAutoSelect = !moduleAutoAdded && allowScoutAuto; // first PDF in selected module window

            if (isAutoSelect || isRequested) {
              try {
                const fileInfo = await fetchCanvasFileInfo(course.id, cid);
                const ct = fileInfo?.["content-type"] ?? "";
                const name = fileInfo?.display_name ?? candidateFileName;
                const isPdf = ct.includes("pdf") || name.toLowerCase().endsWith(".pdf");
                const size = fileInfo?.size ?? 0;
                const remoteUpdatedAt = fileInfo?.updated_at ?? details.updated_at ?? null;
                const shouldImport = isRequested || shouldImportSource(
                  materialState,
                  "canvas_module",
                  cid,
                  remoteUpdatedAt,
                  size,
                  cid,
                );
                if (fileInfo?.url && isPdf && size > 0 && size < AUTO_IMPORT_PDF_MAX_BYTES && shouldImport) {
                  course.materialFileUrls.push({
                    fileName: name,
                    url: fileInfo.url,
                    sourceKey: cid,
                    sourceKind: "canvas_module",
                    remoteSize: size,
                    remoteUpdatedAt,
                  });
                  if (isAutoSelect) moduleAutoAdded = true;
                  console.log(`[scout] ${course.name} | ${isRequested ? "requested" : "auto"}: "${name}" (${Math.round(size / 1024)}KB)`);
                }
              } catch { /* skip */ }
            }
          }
        }

        // Step 3: walk module Page items and pull in linked PDFs sitting inside
        // ordinary lecture pages (for example a Page that contains slide download
        // links rather than direct File module items).
        const pageScanTargets = [];
        const seenPageUrls = new Set();
        for (const pageItem of modulePageItems) {
          if (SYLLABUS_MOD_RE.test(pageItem.moduleName ?? "")) continue;
          if (!pageItem.pageUrl || seenPageUrls.has(pageItem.pageUrl)) continue;
          if (scoutMode && !scoutPreferredModuleIds.has(pageItem.moduleId)) continue;
          seenPageUrls.add(pageItem.pageUrl);
          pageScanTargets.push(pageItem);
        }

        if (pageScanTargets.length > 0) {
          await mapWithConcurrency(pageScanTargets, scoutMode ? 3 : 5, async (pageItem) => {
            try {
              const [pageData] = await fetchAll(`${BASE}/courses/${course.id}/pages/${pageItem.pageUrl}`);
              const bodyHtml = pageData?.body?.trim();
              if (!bodyHtml || bodyHtml.length < 25) return;

              const linkedPdfRefs = extractLinkedPdfRefs(bodyHtml);
              if (linkedPdfRefs.length === 0) return;

              let candidateCount = 0;
              let downloadCount = 0;

              for (const ref of linkedPdfRefs) {
                let sourceKey = null;
                let fileName = ref.label ?? "linked.pdf";
                let downloadUrl = null;
                let remoteSize = null;
                let remoteUpdatedAt = null;

                if (ref.kind === "canvas") {
                  sourceKey = String(ref.fileId);
                  if (materialSeenIds.has(sourceKey)) continue;

                  const fileInfo = await fetchCanvasFileInfo(course.id, ref.fileId);
                  const resolvedName = fileInfo?.display_name ?? fileName;
                  if (!fileInfo?.url || !fileLooksPdf(fileInfo, resolvedName)) continue;

                  remoteSize = fileInfo.size ?? null;
                  if (typeof remoteSize === "number" && remoteSize > MATERIAL_CANDIDATE_MAX_BYTES) continue;

                  fileName = resolvedName;
                  downloadUrl = fileInfo.url;
                  remoteUpdatedAt = fileInfo.updated_at ?? null;
                } else {
                  sourceKey = ref.sourceKey ?? normalizeExternalSourceKey(ref.href);
                  if (materialSeenIds.has(sourceKey)) continue;
                  downloadUrl = ref.href;
                }

                materialSeenIds.add(sourceKey);
                candidateCount++;

                course.materialCandidates.push({
                  fileName,
                  moduleName: buildMaterialContextName(pageItem.moduleName, pageItem.pageTitle),
                  contentId: sourceKey,
                  sourceKind: "canvas_module",
                  remoteSize,
                  remoteUpdatedAt,
                });

                const isRequested = requestedContentIds.has(sourceKey);
                const shouldImport =
                  isRequested ||
                  shouldImportSource(
                    materialState,
                    "canvas_module",
                    sourceKey,
                    remoteUpdatedAt,
                    remoteSize,
                    sourceKey,
                  );
                const withinAutoImportSize = typeof remoteSize !== "number" || remoteSize < AUTO_IMPORT_PDF_MAX_BYTES;

                if (downloadUrl && withinAutoImportSize && shouldImport) {
                  course.materialFileUrls.push({
                    fileName,
                    url: downloadUrl,
                    sourceKey,
                    sourceKind: "canvas_module",
                    remoteSize,
                    remoteUpdatedAt,
                  });
                  downloadCount++;
                }
              }

              if (candidateCount > 0) {
                console.log(
                  `[scout] ${course.name} | page "${pageItem.pageTitle ?? pageItem.pageUrl}": linkedPdfCandidates=${candidateCount} downloads=${downloadCount}`
                );
              }
            } catch (err) {
              console.warn(
                `[scout] ${course.name}: failed to inspect page "${pageItem.pageTitle ?? pageItem.pageUrl}" for linked files — ${err?.message ?? err}`
              );
            }
          });
        }

        // ── Per-course Scout diagnostic ───────────────────────────────────
        console.log(
          `[scout] ${course.name}:`,
          `syllabusBody=${course.syllabusBody?.length ?? 0}c`,
          `| rawBody=${course._rawSyllabusBody?.length ?? 0}c`,
          `| syllabusPDFs=[${course.syllabusFileUrls.map((f) => `"${f.fileName}"`).join(", ") || "none"}]`,
          `| candidates=${course.materialCandidates.length}`,
          `| materialDownloads=${course.materialFileUrls.length}`
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
