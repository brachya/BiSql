---
name: webview-pages
description: >-
  Builds VS Code webview UIs as HTML/CSS/JS files that load once and update
  with postMessage. Use when adding or changing a webview, results panel,
  connection panel, schema explorer, or any extension HTML/CSS/JS UI.
---

# Webview pages

This repo builds webviews as a small web app the extension talks to, not as HTML baked into TypeScript strings.

Canonical example: `media/results.html` + host `src/ui/resultsPanel.ts`.
Same layout: `media/connection.*` / `src/ui/connectionPanel.ts`, `media/schema.*` / `src/ui/schemaExplorer.ts`.
Fill the HTML with `fillWebviewPage()` from `src/ui/media.ts`.

## Rule

1. **Files, not strings.** Markup in `media/<name>.html`, styles in `media/<name>.css`, page logic in `media/<name>.js`. Host TypeScript only fills placeholders and owns data/SQL.
2. **Set the page once.** `webview.html = …` only when the panel is created. Sort, refresh, paging, and new data must not replace the document.
3. **Update with messages.** Host → page: one snapshot (`setResult` or equivalent). Page → host: user actions (`sortBy`, `editCell`, `page`). Cell patches stay small (`applied`).
4. **No UI framework.** No React, Vue, Lit, or Webview UI Toolkit. Plain HTML + VS Code CSS variables. `postMessage` is the pipe; do not wrap it in extra libraries.

## Host checklist

- `localResourceRoots: [mediaRoot()]` (see `src/ui/media.ts`).
- CSP: `style-src` and `script-src` include `webview.cspSource` and the nonce.
- Load CSS/JS with `webview.asWebviewUri(mediaFile(...))`.
- Read the HTML file, replace only `{{csp}}`, `{{nonce}}`, `{{css}}`, `{{js}}`, `{{boot}}`. Do not re-scan after inserting JSON (`{{boot}}` may contain `{{` from SQL).
- Register `onDidReceiveMessage` **before** setting `webview.html`.
- First paint: bootstrap JSON in the shell. Later: `postMessage` only. Page posts `ready`; host re-sends current state so a fast query is not lost.

## Page checklist

- Vanilla JS. `acquireVsCodeApi()` once.
- Fill chrome and the grid from the snapshot. Keep the scroll box; do not destroy `.table-wrap` on a normal redraw.
- Same query (same SQL + columns): keep scroll. Different query: top-left.

## Do not

- Put CSS or a full page script inside a TypeScript template string.
- Copy an old TypeScript HTML string as a pattern. Connection and Schema already live in `media/`.
- Add a second bundler for webview JS unless the page cannot stay as plain files.
