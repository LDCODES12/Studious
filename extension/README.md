# Study Circle — Canvas Sync Extension

A Chrome extension that pulls your entire Canvas course load into Study Circle with one click.

## What it syncs

| Data | Study Circle location |
|------|-----------------------|
| Active courses (name, code, instructor, term) | Sidebar + Dashboard |
| All assignments with due dates | Course → Deadlines tab |
| Weekly modules (content, files, URLs) | Course → Content tab |

Progress on Content tab topics is **never overwritten** — checking off a topic persists across syncs.

## Install (Developer mode)

1. Clone or download the Study Circle repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `extension/` folder
5. The Study Circle icon appears in your toolbar

## First-time setup

1. Go to Study Circle → **Settings** → click **Generate Token**
2. Copy the token (shown once)
3. Click the extension icon → **Settings**
4. Fill in:
   - **Canvas URL**: your school's Canvas domain, e.g. `canvas.cornell.edu`
   - **Study Circle URL**: your deployed app, e.g. `studycircle.vercel.app`
   - **API Token**: paste the token from Step 2
5. Click **Save Settings**
6. Click **Sync Now** — done

## How it works

```
[Extension popup]
      │ SYNC_START
      ▼
[Background service worker]
      │ finds/opens Canvas tab
      │ injects content.js
      ▼
[Content script on Canvas page]
      │ fetch("/api/v1/courses")   ← Canvas session cookie auto-included
      │ fetch("/api/v1/.../assignments")
      │ fetch("/api/v1/.../modules")
      │ CANVAS_DATA → background
      ▼
[Background service worker]
      │ POST /api/canvas/import   ← Bearer token auth
      ▼
[Study Circle API]
      │ upserts courses, assignments, modules
      │ returns summary
      ▼
[Popup] shows result card
```

The content script runs on your Canvas domain so the browser automatically includes your Canvas session cookies. Study Circle never sees your Canvas password or session — only the structured data your extension sends.

## Auto-sync

Enable **Auto-sync** in Settings to trigger a sync once per day whenever you have Canvas open.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "No active Canvas courses found" | Make sure you are enrolled in courses for the current term |
| "Invalid or revoked token" | Regenerate your token in Study Circle → Settings |
| "Canvas API 401" | Log back into Canvas, then sync again |
| Popup shows nothing after sync | Re-open the popup — results persist in storage |
