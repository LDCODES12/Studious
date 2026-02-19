// ── DOM refs ──────────────────────────────────────────────────────────────────
const syncBtn        = document.getElementById("syncBtn");
const canvasStatus   = document.getElementById("canvasStatus");
const scStatus       = document.getElementById("scStatus");
const lastSyncEl     = document.getElementById("lastSync");
const progressSection = document.getElementById("progressSection");
const progressFill   = document.getElementById("progressFill");
const progressLabel  = document.getElementById("progressLabel");
const resultSection  = document.getElementById("resultSection");
const rCourses       = document.getElementById("rCourses");
const rAssignments   = document.getElementById("rAssignments");
const rModules       = document.getElementById("rModules");
const resultNote     = document.getElementById("resultNote");
const errorSection   = document.getElementById("errorSection");
const errorText      = document.getElementById("errorText");
const settingsToggle = document.getElementById("settingsToggle");
const settingsArrow  = document.getElementById("settingsArrow");
const settingsPanel  = document.getElementById("settingsPanel");
const canvasUrlInput = document.getElementById("canvasUrl");
const scUrlInput     = document.getElementById("scUrl");
const apiTokenInput  = document.getElementById("apiToken");
const autoSyncInput  = document.getElementById("autoSync");
const saveSettings   = document.getElementById("saveSettings");
const saveConfirm    = document.getElementById("saveConfirm");

// ── State ─────────────────────────────────────────────────────────────────────
let syncing = false;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const { canvasUrl, scUrl, apiToken, autoSync, lastSync, lastResult, lastError } =
    await chrome.storage.local.get(["canvasUrl", "scUrl", "apiToken", "autoSync", "lastSync", "lastResult", "lastError"]);

  // Populate settings fields
  if (canvasUrl) canvasUrlInput.value = canvasUrl;
  if (scUrl)     scUrlInput.value     = scUrl;
  if (apiToken)  apiTokenInput.value  = apiToken;
  if (autoSync)  autoSyncInput.checked = true;

  // Status dots
  updateStatus(canvasUrl, scUrl, apiToken);

  // Last sync time
  if (lastSync) {
    lastSyncEl.textContent = "Last synced: " + timeAgo(lastSync);
  }

  // Restore last result or error
  if (lastError) {
    showError(lastError);
  } else if (lastResult) {
    showResult(lastResult);
  }

  // Check if a sync is currently running
  const { syncRunning } = await chrome.storage.session.get(["syncRunning"]).catch(() => ({}));
  if (syncRunning) {
    setSyncing(true);
  }
}

function updateStatus(canvasUrl, scUrl, apiToken) {
  if (canvasUrl) {
    canvasStatus.textContent = canvasUrl;
    canvasStatus.className = "status-value ok";
  } else {
    canvasStatus.textContent = "Not configured";
    canvasStatus.className = "status-value warn";
  }

  if (scUrl && apiToken) {
    scStatus.textContent = scUrl;
    scStatus.className = "status-value ok";
  } else if (scUrl) {
    scStatus.textContent = "Token missing";
    scStatus.className = "status-value warn";
  } else {
    scStatus.textContent = "Not configured";
    scStatus.className = "status-value warn";
  }

  syncBtn.disabled = !(canvasUrl && scUrl && apiToken);
}

// ── Settings panel ────────────────────────────────────────────────────────────
settingsToggle.addEventListener("click", () => {
  const open = !settingsPanel.hidden;
  settingsPanel.hidden = open;
  settingsArrow.textContent = open ? "▸" : "▾";
});

saveSettings.addEventListener("click", async () => {
  const canvasUrl = canvasUrlInput.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const scUrl     = scUrlInput.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const apiToken  = apiTokenInput.value.trim();
  const autoSync  = autoSyncInput.checked;

  await chrome.storage.local.set({ canvasUrl, scUrl, apiToken, autoSync });

  // Register or clear auto-sync alarm
  await chrome.alarms.clear("autoSync");
  if (autoSync) {
    chrome.alarms.create("autoSync", { periodInMinutes: 1440 }); // once per day
  }

  updateStatus(canvasUrl, scUrl, apiToken);
  saveConfirm.hidden = false;
  setTimeout(() => { saveConfirm.hidden = true; }, 2000);
});

// ── Sync ──────────────────────────────────────────────────────────────────────
syncBtn.addEventListener("click", startSync);

async function startSync() {
  if (syncing) return;
  setSyncing(true);
  hideAll();

  chrome.runtime.sendMessage({ type: "SYNC_START" }, (response) => {
    if (chrome.runtime.lastError) {
      setSyncing(false);
      showError("Could not reach background service. Try reloading the extension.");
    }
  });
}

// ── Message listener (from background) ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SYNC_PROGRESS") {
    progressFill.style.width = msg.percent + "%";
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
  syncing = active;
  syncBtn.disabled = active;
  syncBtn.textContent = active ? "Syncing…" : "Sync Now";
  progressSection.hidden = !active;
  if (active) {
    progressFill.style.width = "5%";
    progressLabel.textContent = "Connecting to Canvas…";
  }
}

function hideAll() {
  resultSection.hidden = true;
  errorSection.hidden = true;
}

function showResult(result) {
  hideAll();
  const s = result.summary;
  rCourses.textContent    = (s.courses.new + s.courses.updated);
  rAssignments.textContent = (s.assignments.new + s.assignments.updated);
  rModules.textContent    = (s.modules.new + s.modules.updated);
  resultNote.textContent  =
    `${s.courses.new} new course${s.courses.new !== 1 ? "s" : ""} · ` +
    `${s.assignments.new} new assignment${s.assignments.new !== 1 ? "s" : ""}`;
  resultSection.hidden = false;
}

function showError(message) {
  hideAll();
  errorText.textContent = message;
  errorSection.hidden = false;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) !== 1 ? "s" : ""} ago`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
