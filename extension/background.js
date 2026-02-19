/**
 * background.js — Manifest V3 service worker.
 * Orchestrates the sync: gets settings, injects content.js into a Canvas tab,
 * receives the Canvas data, posts it to the Study Circle API.
 */

// ── Alarm for auto-sync ───────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "autoSync") {
    runSync();
  }
});

// ── Message from popup ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SYNC_START") {
    sendResponse({ ok: true });
    runSync();
  }

  // Messages relayed from content.js
  if (msg.type === "SYNC_PROGRESS") {
    broadcastToPopup(msg);
  }

  if (msg.type === "CANVAS_DATA") {
    handleCanvasData(msg.payload);
  }

  if (msg.type === "SYNC_ERROR") {
    handleError(msg.error);
  }

  return false; // synchronous response
});

// ── Main sync orchestrator ────────────────────────────────────────────────────
async function runSync() {
  await chrome.storage.session.set({ syncRunning: true });

  try {
    const { canvasUrl, scUrl, apiToken } =
      await chrome.storage.local.get(["canvasUrl", "scUrl", "apiToken"]);

    if (!canvasUrl || !scUrl || !apiToken) {
      throw new Error("Extension not fully configured. Open the popup and fill in Settings.");
    }

    // Find or create a Canvas tab
    const canvasOrigin = `https://${canvasUrl}`;
    const tabs = await chrome.tabs.query({ url: `${canvasOrigin}/*` });

    let tabId;
    if (tabs.length > 0) {
      tabId = tabs[0].id;
    } else {
      // Open Canvas in a new tab (background)
      broadcastToPopup({ type: "SYNC_PROGRESS", percent: 5, label: "Opening Canvas…" });
      const tab = await chrome.tabs.create({ url: canvasOrigin, active: false });
      tabId = tab.id;

      // Wait for tab to finish loading
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Canvas took too long to load")), 30000);
        chrome.tabs.onUpdated.addListener(function listener(id, info) {
          if (id === tabId && info.status === "complete") {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        });
      });
    }

    // Inject content script
    broadcastToPopup({ type: "SYNC_PROGRESS", percent: 8, label: "Connecting to Canvas…" });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    // content.js will send CANVAS_DATA or SYNC_ERROR messages back
    // (handled in the message listener above)

  } catch (err) {
    await chrome.storage.session.set({ syncRunning: false });
    handleError(err.message ?? String(err));
  }
}

// ── Handle Canvas data returned from content.js ───────────────────────────────
async function handleCanvasData(payload) {
  try {
    const { scUrl, apiToken } =
      await chrome.storage.local.get(["scUrl", "apiToken"]);

    const res = await fetch(`https://${scUrl}/api/canvas/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Study Circle API error (${res.status})`);
    }

    const result = await res.json();

    await chrome.storage.session.set({ syncRunning: false });
    broadcastToPopup({ type: "SYNC_COMPLETE", result });

  } catch (err) {
    await chrome.storage.session.set({ syncRunning: false });
    handleError(err.message ?? String(err));
  }
}

function handleError(message) {
  chrome.storage.session.set({ syncRunning: false });
  broadcastToPopup({ type: "SYNC_ERROR", error: message });
}

// ── Broadcast to popup (if open) ──────────────────────────────────────────────
function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Popup may be closed — that's fine
  });
}
