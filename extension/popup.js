// ── DOM refs ──────────────────────────────────────────────────────────────────
const setupView       = document.getElementById("setupView");
const readyView       = document.getElementById("readyView");
const settingsPanel   = document.getElementById("settingsPanel");

const canvasStatus    = document.getElementById("canvasStatus");
const scStatus        = document.getElementById("scStatus");
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

const gearBtn         = document.getElementById("gearBtn");
const closeSettings   = document.getElementById("closeSettings");
const rescanBtn       = document.getElementById("rescanBtn");
const canvasField     = document.getElementById("canvasField");
const canvasUrlSetup  = document.getElementById("canvasUrlSetup");
const saveCanvasBtn   = document.getElementById("saveCanvasBtn");

const canvasUrlInput  = document.getElementById("canvasUrl");
const scUrlInput      = document.getElementById("scUrl");
const apiTokenInput   = document.getElementById("apiToken");
const autoSyncInput   = document.getElementById("autoSync");
const saveSettings    = document.getElementById("saveSettings");
const saveConfirm     = document.getElementById("saveConfirm");
const revokeBtn       = document.getElementById("revokeBtn");
const tokenField      = document.getElementById("tokenField");
const tokenSetRow     = document.getElementById("tokenSetRow");
const replaceTokenBtn = document.getElementById("replaceTokenBtn");

// ── Auto-detection ────────────────────────────────────────────────────────────

/**
 * Scan all open tabs for the Study Circle bridge element.
 * The Settings page renders <div id="sc-extension-bridge" data-token="..." data-scurl="...">
 * when a token is generated — reads it without any user action.
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
      // Tab not scriptable (chrome:// pages etc) — skip silently
    }
  }
  return null;
}

/** Detect Canvas URL from the active tab hostname */
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

// ── Core view logic ───────────────────────────────────────────────────────────

/** Read storage + optionally run auto-detect, then show the right view */
async function init({ autoDetect = true } = {}) {
  const stored = await chrome.storage.local.get([
    "canvasUrl", "scUrl", "apiToken", "autoSync",
    "lastSync", "lastResult", "lastError",
  ]);

  let { canvasUrl, scUrl, apiToken } = stored;

  if (autoDetect) {
    if (!canvasUrl) {
      canvasUrl = await detectCanvasUrl();
    }
    if (!scUrl || !apiToken) {
      const detected = await detectStudyCircle();
      if (detected) {
        scUrl    = detected.scUrl;
        apiToken = detected.token;
      }
    }
  }

  // Populate settings panel (always, so it's current when opened)
  canvasUrlInput.value = canvasUrl || "";
  scUrlInput.value     = scUrl    || "";
  // Show token status row if token exists; show input field only if no token
  apiTokenInput.value = "";
  if (apiToken) {
    tokenField.hidden   = true;
    tokenSetRow.hidden  = false;
  } else {
    tokenField.hidden   = false;
    tokenSetRow.hidden  = true;
  }
  autoSyncInput.checked = !!stored.autoSync;
  revokeBtn.hidden      = !apiToken;

  const fullyConfigured = !!(canvasUrl && scUrl && apiToken);

  if (fullyConfigured) {
    setupView.hidden = true;
    readyView.hidden = false;

    canvasStatus.textContent = canvasUrl;
    scStatus.textContent     = scUrl;

    if (stored.lastSync) lastSyncEl.textContent = "Last synced: " + timeAgo(stored.lastSync);
    if (stored.lastError)       showError(stored.lastError);
    else if (stored.lastResult) showResult(stored.lastResult);
  } else {
    setupView.hidden = false;
    readyView.hidden = true;
    canvasField.hidden = !!canvasUrl;

    // Checklist — show exactly what's missing
    const checkCanvas = document.getElementById("checkCanvas");
    const checkSC     = document.getElementById("checkSC");
    const checkToken  = document.getElementById("checkToken");

    checkCanvas.className = "setup-check" + (canvasUrl ? " done" : "");
    document.getElementById("checkCanvasLabel").textContent =
      canvasUrl ? "Canvas: " + canvasUrl : "Canvas URL — enter below or open Canvas tab first";

    checkSC.className = "setup-check" + (scUrl ? " done" : "");
    document.getElementById("checkSCLabel").textContent =
      scUrl ? "Study Circle: " + scUrl : "Study Circle URL — open the gear menu ⚙";

    checkToken.className = "setup-check" + (apiToken ? " done" : "");
    document.getElementById("checkTokenLabel").textContent =
      apiToken ? "Token connected" : "API Token — go to Study Circle → Settings → Generate Token";
  }

  // Restore syncing state
  const { syncRunning } = await chrome.storage.session.get(["syncRunning"]).catch(() => ({}));
  if (syncRunning && fullyConfigured) setSyncing(true);
}

// ── Settings panel ────────────────────────────────────────────────────────────

gearBtn.addEventListener("click", () => {
  settingsPanel.hidden = false;
});

closeSettings.addEventListener("click", () => {
  settingsPanel.hidden = true;
});

saveSettings.addEventListener("click", async () => {
  const canvasUrl = canvasUrlInput.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const scUrl     = scUrlInput.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const newToken  = apiTokenInput.value.trim();
  const autoSync  = autoSyncInput.checked;

  const update = { autoSync };
  if (canvasUrl) update.canvasUrl = canvasUrl;
  if (scUrl)     update.scUrl     = scUrl;
  if (newToken)  update.apiToken  = newToken; // only update if something was typed

  await chrome.storage.local.set(update);

  await chrome.alarms.clear("autoSync");
  if (autoSync) chrome.alarms.create("autoSync", { periodInMinutes: 1440 });

  // Read back exactly what's now in storage — don't trust local vars
  const saved = await chrome.storage.local.get(["canvasUrl", "scUrl", "apiToken"]);

  saveConfirm.hidden = false;
  setTimeout(() => { saveConfirm.hidden = true; }, 2000);
  settingsPanel.hidden = true;

  if (saved.canvasUrl && saved.scUrl && saved.apiToken) {
    // All three present — go straight to ready view
    setupView.hidden = true;
    readyView.hidden = false;
    canvasStatus.textContent = saved.canvasUrl;
    scStatus.textContent     = saved.scUrl;
  } else {
    // Something still missing — show setup with checklist
    await init({ autoDetect: false });
  }
});

replaceTokenBtn.addEventListener("click", () => {
  tokenSetRow.hidden = true;
  tokenField.hidden  = false;
  apiTokenInput.focus();
});

revokeBtn.addEventListener("click", async () => {
  if (!confirm("Disconnect the extension? You can reconnect by regenerating a token.")) return;
  await chrome.storage.local.remove(["apiToken", "scUrl"]);
  settingsPanel.hidden = true;
  await init({ autoDetect: false });
});

// ── Re-scan button (setup view) ───────────────────────────────────────────────

rescanBtn.addEventListener("click", async () => {
  rescanBtn.disabled    = true;
  rescanBtn.textContent = "Scanning…";
  await init({ autoDetect: true });
  rescanBtn.disabled    = false;
  rescanBtn.innerHTML   = "<span>⟳</span> Detect from open tabs";
});

// Manual Canvas URL (setup view)
saveCanvasBtn.addEventListener("click", async () => {
  const val = canvasUrlSetup.value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!val) return;
  await chrome.storage.local.set({ canvasUrl: val });
  await init({ autoDetect: false });
});
canvasUrlSetup.addEventListener("keydown", (e) => { if (e.key === "Enter") saveCanvasBtn.click(); });

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

// ── Messages from background ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
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
  syncBtn.disabled      = active;
  syncBtn.textContent   = active ? "Syncing…" : "Sync Now";
  progressSection.hidden = !active;
  if (active) {
    progressFill.style.width  = "5%";
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
init();
