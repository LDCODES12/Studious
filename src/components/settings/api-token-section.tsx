"use client";

import { useState, useEffect } from "react";

export function ApiTokenSection() {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
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
    if (!confirm("Revoke your API token? The extension will stop working until you generate a new one.")) return;
    setLoading(true);
    try {
      await fetch("/api/user/api-token", { method: "DELETE" });
      setHasToken(false);
      setNewToken(null);
    } finally {
      setLoading(false);
    }
  };

  const copy = () => {
    if (!newToken) return;
    navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-border p-6 space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">Canvas Extension Token</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Generate a token to connect the Study Circle Chrome extension. The extension
          uses this token to sync your Canvas courses, assignments, and modules automatically.
        </p>
      </div>

      {/* Current status */}
      <div className="flex items-center gap-2 text-[13px]">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            hasToken === null ? "bg-gray-300" : hasToken ? "bg-green-500" : "bg-gray-300"
          }`}
        />
        <span className="text-muted-foreground">
          {hasToken === null ? "Checking..." : hasToken ? "Token active" : "No token generated"}
        </span>
      </div>

      {/* Newly generated token — shown once */}
      {newToken && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-4 space-y-2">
          <p className="text-[12px] font-medium text-amber-800">
            Copy this token now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-white border border-amber-200 px-3 py-2 text-[12px] font-mono break-all select-all">
              {newToken}
            </code>
            <button
              onClick={copy}
              className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-2 text-[12px] font-medium text-amber-800 hover:bg-amber-50 transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-[11px] text-amber-700">
            Paste this into the extension popup → Settings → API Token.
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
          {loading ? "Generating..." : hasToken ? "Regenerate Token" : "Generate Token"}
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

      {/* Extension install instructions */}
      <div className="rounded-md bg-muted/40 border border-border p-4 space-y-2 text-[13px]">
        <p className="font-medium">How to install the extension</p>
        <ol className="list-decimal list-inside space-y-1 text-muted-foreground text-[12px]">
          <li>Download the <code className="text-[11px] bg-muted px-1 py-0.5 rounded">extension/</code> folder from the Study Circle repo</li>
          <li>Open Chrome → <code className="text-[11px] bg-muted px-1 py-0.5 rounded">chrome://extensions</code></li>
          <li>Enable <strong>Developer mode</strong> (top right toggle)</li>
          <li>Click <strong>Load unpacked</strong> → select the <code className="text-[11px] bg-muted px-1 py-0.5 rounded">extension/</code> folder</li>
          <li>Click the extension icon → Settings → paste your token and Study Circle URL</li>
          <li>Click <strong>Sync Now</strong> on any Canvas page</li>
        </ol>
      </div>
    </div>
  );
}
