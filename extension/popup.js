// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusArea      = document.getElementById("statusArea");
const syncBtn         = document.getElementById("syncBtn");
const lastSyncEl      = document.getElementById("lastSync");
const progressSection = document.getElementById("progressSection");
const progressFill    = document.getElementById("progressFill");
const progressLabel   = document.getElementById("progressLabel");
const resultSection   = document.getElementById("resultSection");
const rCourses        = document.getElementById("rCourses");
const rAssignments    = document.getElementById("rAssignments");
const rModules        = document.getElementById("rModules");
const resultNote      = document.getElementById("resultNote");
const errorSection    = document.getElementById("errorSection");
const errorText       = document.getElementById("errorText");

const coursePicker    = document.getElementById("coursePicker");
const courseList      = document.getElementById("courseList");
const selectAllBtn    = document.getElementById("selectAllBtn");
const selectNoneBtn   = document.getElementById("selectNoneBtn");
const importBtn       = document.getElementById("importBtn");
const cancelPickerBtn = document.getElementById("cancelPickerBtn");

const gearBtn         = document.getElementById("gearBtn");
const settingsPanel   = document.getElementById("settingsPanel");
const closeSettings   = document.getElementById("closeSettings");
const canvasUrlInput  = document.getElementById("canvasUrl");
const scUrlInput      = document.getElementById("scUrl");
const apiTokenInput   = document.getElementById("apiToken");
const tokenField      = document.getElementById("tokenField");
const tokenSetRow     = document.getElementById("tokenSetRow");
const replaceTokenBtn = document.getElementById("replaceTokenBtn");
const autoSyncInput   = document.getElementById("autoSync");
const saveSettings    = document.getElementById("saveSettings");
const saveConfirm     = document.getElementById("saveConfirm");
const revokeBtn       = document.getElementById("revokeBtn");

// ── Render ────────────────────────────────────────────────────────────────────

/**
 * The single source of truth. Reads storage, updates every element.
 * No hidden sections to flip — just updates statusArea HTML and syncBtn state.
 */
async function render() {
  const data = await chrome.storage.local.get([
    "canvasUrl", "scUrl", "apiToken", "autoSync", "lastSync", "lastResult", "lastError",
  ]);

  const { canvasUrl, scUrl, apiToken } = data;
  const ready = !!(canvasUrl && scUrl && apiToken);

  // ── Status area ──────────────────────────────────────────────────────────
  if (ready) {
    statusArea.innerHTML = `
      <div class="status-section">
        <div class="status-row">
          <span class="status-label">Canvas</span>
          <span class="status-value ok">${canvasUrl}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Study Circle</span>
          <span class="status-value ok">${scUrl}</span>
        </div>
      </div>`;
  } else {
    const check = (val, label, hint) =>
      `<div class="setup-check ${val ? "done" : ""}">
        <span class="check-dot"></span>
        <span class="check-label">${val ? label + ": " + val : hint}</span>
      </div>`;
    statusArea.innerHTML = `
      <div class="setup-card">
        <p class="setup-title">Almost ready</p>
        <div class="setup-checklist">
          ${check(canvasUrl, "Canvas", "Canvas URL — open ⚙ Settings")}
          ${check(scUrl,     "Study Circle", "Study Circle URL — open ⚙ Settings")}
          ${check(apiToken ? "set" : "", "Token", "API Token — Study Circle → Settings → Generate Token")}
        </div>
        <button class="btn-secondary full-width" id="rescanBtn">⟳ Detect from open tabs</button>
      </div>`;

    // Re-attach rescan listener (innerHTML replaces the node)
    document.getElementById("rescanBtn").addEventListener("click", rescan);
  }

  // ── Sync button ──────────────────────────────────────────────────────────
  syncBtn.disabled = !ready;

  // ── Last sync / results ──────────────────────────────────────────────────
  if (data.lastSync) lastSyncEl.textContent = "Last synced: " + timeAgo(data.lastSync);
  if (data.lastError)       showError(data.lastError);
  else if (data.lastResult) showResult(data.lastResult);

  // ── Settings panel fields ────────────────────────────────────────────────
  canvasUrlInput.value  = canvasUrl || "";
  scUrlInput.value      = scUrl    || "";
  apiTokenInput.value   = "";
  tokenField.style.display    = apiToken ? "none" : "";
  tokenSetRow.style.display   = apiToken ? "flex" : "none";
  autoSyncInput.checked       = !!data.autoSync;
  revokeBtn.hidden            = !apiToken;
}

// ── Auto-detection ────────────────────────────────────────────────────────────

async function detectStudyCircle() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url?.startsWith("http")) continue;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const el = document.getElementById("sc-extension-bridge");
          if (!el) return null;
          return { token: el.dataset.token, scUrl: el.dataset.scurl || window.location.origin };
        },
      });
      if (result?.token) {
        const scUrl = result.scUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
        await chrome.storage.local.set({ apiToken: result.token, scUrl });
        return true;
      }
    } catch { /* skip non-scriptable tabs */ }
  }
  return false;
}

async function detectCanvasUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return false;
  try {
    const { hostname } = new URL(tab.url);
    if (hostname.includes("canvas") || hostname.includes("instructure")) {
      await chrome.storage.local.set({ canvasUrl: hostname });
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function rescan() {
  const btn = document.getElementById("rescanBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
  await detectCanvasUrl();
  await detectStudyCircle();
  await render();
}

// ── Course picker ─────────────────────────────────────────────────────────────

function termSortKey(term) {
  if (!term) return 0;
  const lower = term.toLowerCase();
  const yearMatch = lower.match(/\d{4}/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : 0;
  const season = lower.includes("fall") || lower.includes("autumn") ? 3
               : lower.includes("summer") ? 2
               : lower.includes("spring") ? 1
               : lower.includes("winter") ? 0 : -1;
  return year * 10 + (season >= 0 ? season : -1);
}

function showCoursePicker(courses) {
  // Stop the spinning state — we're waiting for user input
  setSyncing(false);

  // Group courses by term, sort terms newest-first
  const termMap = new Map();
  for (const c of courses) {
    const key = c.term || "Other";
    if (!termMap.has(key)) termMap.set(key, []);
    termMap.get(key).push(c);
  }
  const sortedTerms = [...termMap.keys()].sort(
    (a, b) => termSortKey(b) - termSortKey(a)
  );

  // Render
  courseList.innerHTML = "";
  const showTermHeaders = sortedTerms.length > 1 || sortedTerms[0] !== "Other";

  for (const term of sortedTerms) {
    const group = document.createElement("div");
    group.className = "term-group";

    if (showTermHeaders) {
      const lbl = document.createElement("div");
      lbl.className = "term-label";
      lbl.textContent = term;
      group.appendChild(lbl);
    }

    for (const c of termMap.get(term)) {
      const label = document.createElement("label");
      label.className = "course-row";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.value = String(c.id);
      check.checked = true;

      const info = document.createElement("div");
      info.className = "course-info";

      const name = document.createElement("span");
      name.className = "course-name";
      name.textContent = c.name;
      info.appendChild(name);

      const meta = [];
      if (c.courseCode) meta.push(c.courseCode);
      if (c.instructor) meta.push(c.instructor);
      if (meta.length) {
        const m = document.createElement("span");
        m.className = "course-meta";
        m.textContent = meta.join(" · ");
        info.appendChild(m);
      }

      label.appendChild(check);
      label.appendChild(info);
      group.appendChild(label);
    }

    courseList.appendChild(group);
  }

  updateImportBtn();
  coursePicker.style.display = "flex";
}

function getCheckedBoxes() {
  return [...courseList.querySelectorAll("input[type=checkbox]")];
}

function updateImportBtn() {
  const count = getCheckedBoxes().filter((cb) => cb.checked).length;
  importBtn.disabled = count === 0;
  importBtn.textContent = count > 0 ? `Import ${count} Course${count !== 1 ? "s" : ""}` : "Import Selected";
}

courseList.addEventListener("change", updateImportBtn);

selectAllBtn.addEventListener("click", () => {
  getCheckedBoxes().forEach((cb) => { cb.checked = true; });
  updateImportBtn();
});

selectNoneBtn.addEventListener("click", () => {
  getCheckedBoxes().forEach((cb) => { cb.checked = false; });
  updateImportBtn();
});

importBtn.addEventListener("click", () => {
  const selectedIds = getCheckedBoxes()
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  if (selectedIds.length === 0) return;

  coursePicker.style.display = "none";
  setSyncing(true);
  progressFill.style.width = "5%";
  progressLabel.textContent = "Syncing selected courses…";

  chrome.runtime.sendMessage({ type: "SYNC_SELECTED", selectedIds });
});

cancelPickerBtn.addEventListener("click", () => {
  coursePicker.style.display = "none";
  chrome.storage.session.set({ syncRunning: false });
});

// ── Settings panel ────────────────────────────────────────────────────────────

gearBtn.addEventListener("click",     () => { settingsPanel.style.display = "flex"; });
closeSettings.addEventListener("click", () => { settingsPanel.style.display = "none"; });

replaceTokenBtn.addEventListener("click", () => {
  tokenSetRow.style.display = "none";
  tokenField.style.display  = "";
  apiTokenInput.focus();
});

saveSettings.addEventListener("click", async () => {
  const canvasUrl = canvasUrlInput.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const scUrl     = scUrlInput.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const newToken  = apiTokenInput.value.trim();
  const autoSync  = autoSyncInput.checked;

  // Only set keys that have values — never overwrite with empty string
  const update = { autoSync };
  if (canvasUrl) update.canvasUrl = canvasUrl;
  if (scUrl)     update.scUrl     = scUrl;
  if (newToken)  update.apiToken  = newToken;

  await chrome.storage.local.set(update);
  await chrome.alarms.clear("autoSync");
  if (autoSync) chrome.alarms.create("autoSync", { periodInMinutes: 1440 });

  settingsPanel.style.display = "none";
  saveConfirm.hidden   = false;
  setTimeout(() => { saveConfirm.hidden = true; }, 2000);

  await render();
});

revokeBtn.addEventListener("click", async () => {
  if (!confirm("Disconnect? You can reconnect by generating a new token.")) return;
  await chrome.storage.local.remove(["apiToken", "scUrl"]);
  settingsPanel.style.display = "none";
  await render();
});

// ── Sync ──────────────────────────────────────────────────────────────────────

syncBtn.addEventListener("click", () => {
  setSyncing(true);
  hideResults();
  chrome.runtime.sendMessage({ type: "SYNC_START" }, () => {
    if (chrome.runtime.lastError) {
      setSyncing(false);
      showError("Could not reach background service — try reloading the extension.");
    }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "COURSE_SELECTION") {
    showCoursePicker(msg.courses);
  }
  if (msg.type === "SYNC_PROGRESS") {
    progressFill.style.width  = msg.percent + "%";
    progressLabel.textContent = msg.label;
  }
  if (msg.type === "SYNC_COMPLETE") {
    setSyncing(false);
    showResult(msg.result);
    lastSyncEl.textContent = "Last synced: just now";
    chrome.storage.local.set({ lastSync: Date.now(), lastResult: msg.result, lastError: null });
  }
  if (msg.type === "SYNC_ERROR") {
    setSyncing(false);
    showError(msg.error);
    chrome.storage.local.set({ lastError: msg.error, lastResult: null });
  }
});

// ── UI helpers ────────────────────────────────────────────────────────────────

function setSyncing(active) {
  syncBtn.disabled       = active;
  syncBtn.textContent    = active ? "Syncing…" : "Sync Now";
  progressSection.hidden = !active;
  if (active) { progressFill.style.width = "5%"; progressLabel.textContent = "Connecting to Canvas…"; }
}

function hideResults() {
  resultSection.hidden = true;
  errorSection.hidden  = true;
}

function showResult(result) {
  hideResults();
  const s = result.summary;
  rCourses.textContent     = s.courses.new     + s.courses.updated;
  rAssignments.textContent = s.assignments.new + s.assignments.updated;
  rModules.textContent     = s.modules.new     + s.modules.updated;
  resultNote.textContent   =
    `${s.courses.new} new course${s.courses.new !== 1 ? "s" : ""} · ` +
    `${s.assignments.new} new assignment${s.assignments.new !== 1 ? "s" : ""}`;
  resultSection.hidden = false;
}

function showError(message) {
  hideResults();
  errorText.textContent = message;
  errorSection.hidden   = false;
}

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) !== 1 ? "s" : ""} ago`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
render();
