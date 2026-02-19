"use client";

import { useState, useEffect } from "react";

export function ApiTokenSection() {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/user/api-token")
      .then((r) => r.json())
      .then((d) => setHasToken(d.hasToken))
      .catch(() => setHasToken(false));
  }, []);

  const generate = async () => {
    setLoading(true);
    setNewToken(null);
    try {
      const res = await fetch("/api/user/api-token", { method: "POST" });
      const data = await res.json();
      setNewToken(data.token);
      setHasToken(true);
    } finally {
      setLoading(false);
    }
  };

  const revoke = async () => {
    if (!confirm("Revoke your token? The extension will stop working until you generate a new one.")) return;
    setLoading(true);
    try {
      await fetch("/api/user/api-token", { method: "DELETE" });
      setHasToken(false);
      setNewToken(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-6 space-y-5">
      {/* Hidden bridge — extension content script reads this automatically */}
      {newToken && (
        <div
          id="sc-extension-bridge"
          data-token={newToken}
          data-scurl={origin}
          style={{ display: "none" }}
          aria-hidden="true"
        />
      )}

      <div>
        <h2 className="text-[15px] font-semibold">Canvas Extension</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Connect the Study Circle Chrome extension to sync your Canvas courses,
          assignments, and modules automatically.
        </p>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2 text-[13px]">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            hasToken === null ? "bg-gray-300" : hasToken ? "bg-green-500" : "bg-gray-300"
          }`}
        />
        <span className="text-muted-foreground">
          {hasToken === null ? "Checking…" : hasToken ? "Token active" : "No token generated"}
        </span>
      </div>

      {/* Auto-detect success banner */}
      {newToken && (
        <div className="rounded-md bg-green-50 border border-green-200 p-4 space-y-1">
          <p className="text-[13px] font-medium text-green-800">
            Token generated — extension will auto-detect it
          </p>
          <p className="text-[12px] text-green-700">
            Open the extension popup and it will configure itself automatically.
            No copy/paste needed.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={generate}
          disabled={loading}
          className="rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Generating…" : hasToken ? "Regenerate Token" : "Generate Token"}
        </button>
        {hasToken && !newToken && (
          <button
            onClick={revoke}
            disabled={loading}
            className="rounded-md border border-border px-4 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-red-600 hover:border-red-300 disabled:opacity-50"
          >
            Revoke
          </button>
        )}
      </div>

      {/* Install instructions — two steps only */}
      <div className="rounded-md bg-muted/40 border border-border p-4 space-y-3">
        <p className="text-[13px] font-medium">Setup — 2 steps</p>
        <ol className="space-y-3 text-[12px] text-muted-foreground">
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-background text-[10px] font-bold">1</span>
            <span>
              Install the extension:{" "}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">chrome://extensions</code>{" "}
              → Enable <strong>Developer mode</strong> → <strong>Load unpacked</strong> → select the{" "}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">extension/</code> folder from the repo
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-background text-[10px] font-bold">2</span>
            <span>
              Click <strong>Generate Token</strong> above, then open the extension popup —
              it auto-detects your token and Study Circle URL instantly.
              Then go to any Canvas page and hit <strong>Sync Now</strong>.
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}
