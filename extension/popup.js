// ── DOM refs ──────────────────────────────────────────────────────────────────
const setupView      = document.getElementById("setupView");
const readyView      = document.getElementById("readyView");
const settingsPanel  = document.getElementById("settingsPanel");

const canvasStatus   = document.getElementById("canvasStatus");
const scStatus       = document.getElementById("scStatus");
const syncBtn        = document.getElementById("syncBtn");
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

const gearBtn        = document.getElementById("gearBtn");
const closeSettings  = document.getElementById("closeSettings");
const rescanBtn      = document.getElementById("rescanBtn");
const canvasField    = document.getElementById("canvasField");
const canvasUrlSetup = document.getElementById("canvasUrlSetup");
const saveCanvasBtn  = document.getElementById("saveCanvasBtn");

// Settings panel fields
const canvasUrlInput = document.getElementById("canvasUrl");
const scUrlInput     = document.getElementById("scUrl");
const apiTokenInput  = document.getElementById("apiToken");
const autoSyncInput  = document.getElementById("autoSync");
const saveSettings   = document.getElementById("saveSettings");
const saveConfirm    = document.getElementById("saveConfirm");
const revokeBtn      = document.getElementById("revokeBtn");

// ── Auto-detection ────────────────────────────────────────────────────────────

/**
 * Scan all open tabs for the Study Circle extension bridge element.
 * The Settings page renders <div id="sc-extension-bridge" data-token="..." data-scurl="...">
 * when a token is generated — we read it without the user doing anything.
 */
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
          return {
            token: el.getAttribute("data-token"),
            scUrl: el.getAttribute("data-scurl") || window.location.origin,
          };
        },
      });
      if (result?.token) {
        const scUrl = result.scUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
        await chrome.storage.local.set({ apiToken: result.token, scUrl });
        return { token: result.token, scUrl };
      }
    } catch {
      // Tab not scriptable (e.g. chrome:// pages) — skip silently
    }
  }
  return null;
}

/**
 * Detect Canvas URL from the currently active tab.
 * If the active tab looks like Canvas, store and return the hostname.
 */
async function detectCanvasUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const { hostname } = new URL(tab.url);
    if (hostname.includes("canvas") || hostname.includes("instructure")) {
      await chrome.storage.local.set({ canvasUrl: hostname });
      return hostname;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Initialise popup ──────────────────────────────────────────────────────────

async function init() {
  // 1. Load persisted config
  const stored = await chrome.storage.local.get([
    "canvasUrl", "scUrl", "apiToken", "autoSync",
    "lastSync", "lastResult", "lastError",
  ]);

  // 2. Try to auto-detect anything missing
  let { canvasUrl, scUrl, apiToken } = stored;

  // Auto-detect Canvas from current tab (fast, no network)
  if (!canvasUrl) {
    canvasUrl = await detectCanvasUrl();
  }

  // Auto-detect SC config from open tabs (scans for bridge element)
  if (!scUrl || !apiToken) {
    const detected = await detectStudyCircle();
    if (detected) {
      scUrl    = detected.scUrl;
      apiToken = detected.token;
    }
  }

  // 3. Decide which view to show
  const fullyConfigured = !!(canvasUrl && scUrl && apiToken);

  if (fullyConfigured) {
    showReadyView(canvasUrl, scUrl, stored);
  } else {
    showSetupView(canvasUrl);
  }

  // 4. Populate settings panel fields
  canvasUrlInput.value = canvasUrl || "";
  scUrlInput.value     = scUrl    || "";
  apiTokenInput.value  = apiToken ? "••••••••••••••••" : "";
  if (stored.autoSync) autoSyncInput.checked = true;
  if (apiToken) revokeBtn.hidden = false;

  // 5. Check if sync is running
  const { syncRunning } = await chrome.storage.session.get(["syncRunning"]).catch(() => ({}));
  if (syncRunning && fullyConfigured) setSyncing(true);
}

function showReadyView(canvasUrl, scUrl, stored) {
  setupView.hidden = true;
  readyView.hidden = false;

  canvasStatus.textContent = canvasUrl;
  scStatus.textContent     = scUrl;

  if (stored.lastSync) {
    lastSyncEl.textContent = "Last synced: " + timeAgo(stored.lastSync);
  }
  if (stored.lastError) {
    showError(stored.lastError);
  } else if (stored.lastResult) {
    showResult(stored.lastResult);
  }
}

function showSetupView(detectedCanvasUrl) {
  setupView.hidden = false;
  readyView.hidden = true;

  // If Canvas URL was auto-detected, pre-fill the manual field and hide it
  if (detectedCanvasUrl) {
    canvasField.hidden = true; // Canvas detected, no manual entry needed
  } else {
    canvasField.hidden = false;
  }
}

// ── Gear / Settings panel ─────────────────────────────────────────────────────

gearBtn.addEventListener("click", () => {
  settingsPanel.hidden = false;
});

closeSettings.addEventListener("click", () => {
  settingsPanel.hidden = true;
});

saveSettings.addEventListener("click", async () => {
  const canvasUrl = canvasUrlInput.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const scUrl     = scUrlInput.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const typed     = apiTokenInput.value.trim();
  const autoSync  = autoSyncInput.checked;

  // Only overwrite token if user actually typed something new (not the masked placeholder)
  const update = { canvasUrl, scUrl, autoSync };
  if (typed && !typed.startsWith("•")) update.apiToken = typed;

  await chrome.storage.local.set(update);

  // Re-register auto-sync alarm
  await chrome.alarms.clear("autoSync");
  if (autoSync) chrome.alarms.create("autoSync", { periodInMinutes: 1440 });

  saveConfirm.hidden = false;
  setTimeout(() => { saveConfirm.hidden = true; }, 2000);

  // Re-init to reflect new config
  settingsPanel.hidden = true;
  await init();
});

revokeBtn.addEventListener("click", async () => {
  if (!confirm("Disconnect the extension? You can reconnect by regenerating a token.")) return;
  await chrome.storage.local.remove(["apiToken", "scUrl"]);
  revokeBtn.hidden = true;
  settingsPanel.hidden = true;
  await init();
});

// ── Re-scan button (setup view) ───────────────────────────────────────────────

rescanBtn.addEventListener("click", async () => {
  rescanBtn.disabled = true;
  rescanBtn.textContent = "Scanning…";

  const detected = await detectStudyCircle();
  const canvasUrl = (await chrome.storage.local.get(["canvasUrl"])).canvasUrl || await detectCanvasUrl();

  if (detected) {
    await chrome.storage.local.set({ apiToken: detected.token, scUrl: detected.scUrl });
  }

  rescanBtn.disabled = false;
  rescanBtn.innerHTML = '<span>⟳</span> Detect from open tabs';

  await init();
});

// Manual Canvas URL save (setup view)
saveCanvasBtn.addEventListener("click", async () => {
  const val = canvasUrlSetup.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!val) return;
  await chrome.storage.local.set({ canvasUrl: val });
  canvasField.hidden = true;
  await init();
});
canvasUrlSetup.addEventListener("keydown", (e) => { if (e.key === "Enter") saveCanvasBtn.click(); });

// ── Sync ──────────────────────────────────────────────────────────────────────

syncBtn.addEventListener("click", startSync);

async function startSync() {
  setSyncing(true);
  hideResults();
  chrome.runtime.sendMessage({ type: "SYNC_START" }, (response) => {
    if (chrome.runtime.lastError) {
      setSyncing(false);
      showError("Could not reach background service — try reloading the extension.");
    }
  });
}

// ── Messages from background ──────────────────────────────────────────────────

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
  syncBtn.disabled = active;
  syncBtn.textContent = active ? "Syncing…" : "Sync Now";
  progressSection.hidden = !active;
  if (active) {
    progressFill.style.width = "5%";
    progressLabel.textContent = "Connecting to Canvas…";
  }
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
  errorSection.hidden = false;
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
init();
