# Chrome Web Store — Publishing Checklist

When ready to make the extension publicly installable (no developer mode required).

## One-time setup
- [ ] Pay $5 Google Developer account fee at https://chrome.google.com/webstore/devconsole

## Technical changes (a few hours)
- [ ] Replace `"host_permissions": ["<all_urls>"]` in `manifest.json` with `"optional_host_permissions"` — Chrome will ask the user to approve their Canvas domain on first sync
- [ ] Once published, the extension ID becomes stable — update `manifest.json` with `"externally_connectable"` pointing to the Study Circle domain so the Settings page can push the token directly (no DOM scanning needed)
- [ ] Replace placeholder icons in `icons/` with real branded PNGs (16×16, 48×48, 128×128)

## Store listing assets
- [ ] Short description (132 chars max)
- [ ] Detailed description
- [ ] 3–5 screenshots of the popup (1280×800 or 640×400)
- [ ] Promo image (440×280)

## Required pages on the web app
- [ ] Privacy policy page — just needs to explain that the extension reads Canvas data using the student's own session, sends it to their own Study Circle account, and nothing is shared with third parties

## Submission
- [ ] Zip the `extension/` folder and upload to the Developer Dashboard
- [ ] Submit for review (usually 1–3 days for new extensions)
- [ ] Replace install instructions in `src/components/settings/api-token-section.tsx` with a Chrome Web Store link
