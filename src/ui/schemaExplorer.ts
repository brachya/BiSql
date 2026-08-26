import * as vscode from 'vscode';
import { ColumnInfo, DbEngine, SqlServerService, TableInfo } from '../db/connection';
import {
    compareDatabases,
    formatSchemaDiffReport,
    parseChangeLevel,
    parseDiffFilter,
    SchemaDiff
} from '../sql/schemaDiff';
import { formatQualifiedTable } from '../sql/qualifyTables';
import { tabIcon } from './media';
import { ResultsPanel } from './resultsPanel';

interface SchemaColumnDto {
    name: string;
    typeDisplay: string;
    isNullable: boolean;
    isIdentity: boolean;
    isComputed: boolean;
    isPrimaryKey: boolean;
}

interface SchemaTableDto {
    database: string;
    schema: string;
    name: string;
    qualifiedName: string;
    isView: boolean;
    columns: SchemaColumnDto[];
}

type WebviewToExt =
    | { type: 'ready' }
    | { type: 'copy'; text: string }
    | { type: 'refresh' }
    | { type: 'openLogin' }
    | { type: 'compare'; left: string; right: string }
    | { type: 'copyReport'; left: string; right: string; filter: string; query: string; depth: string }
    | { type: 'preview'; qualifiedName: string };

type ExtToWebview =
    | {
          type: 'init';
          engine: DbEngine;
          server: string;
          database: string;
          state: string;
          stale: boolean;
          fetchedAt: number;
          tableCount: number;
          tables: SchemaTableDto[];
      }
    | { type: 'status'; message: string; ok: boolean; busy?: boolean }
    | { type: 'diff'; diff: SchemaDiff };

/**
 * Browse tables and views already in the schema cache.
 * Does not query the live database until the user clicks Refresh.
 */
export class SchemaExplorer {
    public static readonly viewType = 'bisql.schemaExplorer';

    private static current: SchemaExplorer | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    public static show(db: SqlServerService, openLogin: () => void): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (SchemaExplorer.current) {
            SchemaExplorer.current.panel.reveal(column);
            void SchemaExplorer.current.postInit();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SchemaExplorer.viewType,
            'Cached Schema',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );
        panel.iconPath = tabIcon('sql-results-light.svg', 'sql-results-dark.svg');

        SchemaExplorer.current = new SchemaExplorer(panel, db, openLogin);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly db: SqlServerService,
        private readonly openLogin: () => void
    ) {
        this.panel = panel;
        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (message: WebviewToExt) => {
                void this.onMessage(message);
            },
            null,
            this.disposables
        );
        this.disposables.push(
            this.db.onDidChangeSchema(() => {
                void this.postInit();
            }),
            this.db.onDidChangeState(() => {
                void this.postInit();
            })
        );
    }

    private async onMessage(message: WebviewToExt): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.postInit();
                return;
            case 'copy':
                await vscode.env.clipboard.writeText(message.text);
                await this.panel.webview.postMessage({
                    type: 'status',
                    message: 'Copied.',
                    ok: true
                } satisfies ExtToWebview);
                return;
            case 'refresh': {
                await this.panel.webview.postMessage({
                    type: 'status',
                    message: 'Refreshing schema…',
                    ok: true,
                    busy: true
                } satisfies ExtToWebview);
                const ok = await this.db.refreshSchema();
                await this.postInit();
                await this.panel.webview.postMessage({
                    type: 'status',
                    message: ok
                        ? `Loaded ${this.db.schema.tables.length} tables and views.`
                        : (this.db.lastErrorMessage ?? 'Could not refresh schema.'),
                    ok,
                    busy: false
                } satisfies ExtToWebview);
                return;
            }
            case 'openLogin':
                this.openLogin();
                return;
            case 'compare': {
                const diff = this.buildDiff(message.left, message.right);
                await this.panel.webview.postMessage({
                    type: 'diff',
                    diff
                } satisfies ExtToWebview);
                return;
            }
            case 'copyReport': {
                const diff = this.buildDiff(message.left, message.right);
                const report = formatSchemaDiffReport(diff, {
                    filter: parseDiffFilter(message.filter),
                    query: message.query,
                    depth: parseChangeLevel(message.depth)
                });
                await vscode.env.clipboard.writeText(report);
                await this.panel.webview.postMessage({
                    type: 'status',
                    message: 'Copied.',
                    ok: true
                } satisfies ExtToWebview);
                return;
            }
            case 'preview':
                await this.previewTable(message.qualifiedName);
                return;
        }
    }

    private buildDiff(left: string, right: string): SchemaDiff {
        return compareDatabases(
            this.db.schema.tables,
            left,
            right,
            this.db.getConfig().engine
        );
    }

    private async previewTable(qualifiedName: string): Promise<void> {
        const table = this.db.findTable(qualifiedName);
        if (!table) {
            await this.panel.webview.postMessage({
                type: 'status',
                message: `Unknown table '${qualifiedName}'.`,
                ok: false
            } satisfies ExtToWebview);
            return;
        }
        const engine = this.db.getConfig().engine;
        const sql = `SELECT * FROM ${formatQualifiedTable(table, engine)}`;
        await this.panel.webview.postMessage({
            type: 'status',
            message: `Opening ${table.qualifiedName}…`,
            ok: true,
            busy: true
        } satisfies ExtToWebview);
        const view = ResultsPanel.showRunning(this.db, sql, {});
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Loading ${table.name}…`,
                cancellable: true
            },
            async (_progress, token) => {
                const abort = new AbortController();
                const sub = token.onCancellationRequested(() => abort.abort());
                try {
                    return await this.db.executeQuery(sql, {}, { signal: abort.signal });
                } finally {
                    sub.dispose();
                }
            }
        );
        view.setResult(result);
        await this.panel.webview.postMessage({
            type: 'status',
            message: result.ok
                ? `Opened ${table.qualifiedName}.`
                : (result.error ?? 'The query failed.'),
            ok: result.ok,
            busy: false
        } satisfies ExtToWebview);
        if (!result.ok) {
            vscode.window.showErrorMessage(result.error ?? 'The query failed.');
        }
    }

    private async postInit(): Promise<void> {
        const config = this.db.getConfig();
        const payload: ExtToWebview = {
            type: 'init',
            engine: config.engine,
            server: config.server,
            database: config.database,
            state: this.db.connectionState,
            stale: this.db.schema.stale,
            fetchedAt: this.db.schema.fetchedAt,
            tableCount: this.db.schema.tables.length,
            tables: this.db.schema.tables.map(toDto)
        };
        await this.panel.webview.postMessage(payload);
    }

    private dispose(): void {
        SchemaExplorer.current = undefined;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }

    private getHtml(): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Cached Schema</title>
<style nonce="${nonce}">
  :root { --radius: 8px; --pad: 18px; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    position: relative;
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .top {
    flex: none;
    padding: 16px var(--pad) 12px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
  }
  .top-row {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  }
  h1 { margin: 0; font-size: 1.2rem; font-weight: 600; letter-spacing: -0.02em; }
  .sub { margin: 4px 0 0; font-size: 0.8rem; opacity: 0.7; line-height: 1.4; }
  .top-actions { display: flex; gap: 8px; flex: none; }
  button {
    font: inherit; padding: 6px 12px; border-radius: 4px;
    border: 1px solid transparent; cursor: pointer;
  }
  button:disabled { opacity: 0.55; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .metrics {
    display: flex; flex-wrap: wrap; gap: 22px;
    margin-top: 14px;
  }
  .metric .n {
    font-size: 1.15rem; font-weight: 600; font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }
  .metric .l { display: block; margin-top: 1px; font-size: 0.72rem; opacity: 0.62; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .chip {
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    background: var(--vscode-input-background);
    color: inherit; padding: 4px 9px; border-radius: 999px; font-size: 0.75rem;
  }
  .chip:hover:not(:disabled) { border-color: var(--vscode-focusBorder); }
  .chip[aria-pressed="true"] {
    border-color: var(--vscode-focusBorder);
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .filters {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    padding: 10px var(--pad);
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
  }
  .filters input[type="search"] {
    flex: 1; min-width: 160px; padding: 6px 10px; border-radius: 4px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    font: inherit; outline: none;
  }
  .filters input:focus { border-color: var(--vscode-focusBorder); }
  .seg { display: inline-flex; border-radius: 4px; overflow: hidden;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); }
  .seg button {
    padding: 5px 10px; border-radius: 0; background: var(--vscode-input-background); color: inherit;
  }
  .seg button[aria-pressed="true"] {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(220px, 300px) 1fr; }
  .list {
    overflow: auto;
    border-right: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
  }
  .group {
    position: sticky; top: 0; z-index: 1;
    padding: 8px 14px 6px;
    font-size: 0.7rem; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.62;
    background: var(--vscode-editor-background);
  }
  .item {
    display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center;
    width: 100%; padding: 7px 14px; text-align: left; background: transparent; color: inherit;
    border: none; border-radius: 0; user-select: none;
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item[aria-selected="true"] {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .meta { font-size: 0.72rem; opacity: 0.55; font-variant-numeric: tabular-nums; }
  .kind-wrap { display: inline-flex; align-items: center; gap: 2px; flex: none; }
  .kind-icon { width: 14px; height: 14px; display: block; opacity: 0.72; }
  .item[aria-selected="true"] .kind-icon { opacity: 1; }
  .title-row { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .title-row h2 { margin: 0; }
  .title-row .kind-icon { width: 16px; height: 16px; opacity: 0.85; }
  .item .kind { font-size: 0.68rem; letter-spacing: 0.03em; text-transform: uppercase; opacity: 0.55; }
  .detail { overflow: auto; padding: 18px var(--pad) 32px; }
  .empty {
    margin: 48px auto; max-width: 360px; text-align: center; opacity: 0.8;
  }
  .empty p { margin: 0 0 14px; line-height: 1.45; }
  .detail-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
  .detail-head h2 { margin: 0; font-size: 1.05rem; font-weight: 600; word-break: break-all; }
  .qualified { margin: 6px 0 0; font-size: 0.8rem; opacity: 0.65;
    font-family: var(--vscode-editor-font-family, monospace); }
  .flags { margin: 10px 0 16px; font-size: 0.8rem; opacity: 0.75; }
  table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  th, td { padding: 6px 8px; text-align: left; vertical-align: top;
    border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  th { font-size: 0.72rem; font-weight: 600; opacity: 0.65; }
  td.code { font-family: var(--vscode-editor-font-family, monospace); }
  .muted { opacity: 0.55; }
  .pk { font-size: 0.68rem; font-weight: 650; letter-spacing: 0.03em; }
  .note {
    position: absolute; right: var(--pad); bottom: 12px;
    font-size: 0.75rem; opacity: 0; pointer-events: none; transition: opacity 0.15s;
  }
  .note.show { opacity: 0.85; }
  .hidden { display: none !important; }
  .compare-bar {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: end;
    margin-top: 14px;
  }
  .compare-bar label {
    display: flex; flex-direction: column; gap: 4px;
    font-size: 0.72rem; opacity: 0.72;
  }
  .compare-bar select {
    min-width: 180px; padding: 6px 8px; border-radius: 4px;
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, transparent));
    font: inherit;
  }
  .summary { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .summary button {
    display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
    padding: 8px 12px; min-width: 92px; text-align: left;
    background: var(--vscode-input-background);
    color: inherit;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
  }
  .summary button[aria-pressed="true"] {
    border-color: var(--vscode-focusBorder);
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .summary .n { font-size: 1.05rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .summary .l { font-size: 0.7rem; opacity: 0.65; }
  .tag {
    font-size: 0.68rem; letter-spacing: 0.03em; text-transform: uppercase; opacity: 0.7;
  }
  tr.diff-left td {
    background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f85149) 12%, transparent);
  }
  tr.diff-right td {
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #3fb950) 12%, transparent);
  }
  tr.diff-changed td {
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d29922) 12%, transparent);
  }
  .mark { width: 1.2rem; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.8; }
  .cell-stack { display: flex; flex-direction: column; gap: 2px; }
  @media (max-width: 720px) {
    .body { grid-template-columns: 1fr; }
    .list { max-height: 40%; border-right: none;
      border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  }
</style>
</head>
<body>
  <header class="top">
    <div class="top-row">
      <div>
        <h1>Cached schema</h1>
        <p class="sub" id="subtitle">Tables BiSql already knows. Double-click a table or view to preview rows.</p>
      </div>
      <div class="top-actions">
        <div class="seg" role="group" aria-label="Mode">
          <button type="button" id="modeBrowse" aria-pressed="true">Browse</button>
          <button type="button" id="modeCompare" aria-pressed="false">Compare</button>
        </div>
        <button type="button" class="secondary" id="loginBtn">Login</button>
        <button type="button" class="primary" id="refreshBtn">Refresh</button>
      </div>
    </div>
    <div class="metrics" id="metrics"></div>
    <div class="chips" id="dbChips"></div>
    <div class="compare-bar hidden" id="compareBar">
      <label>Left
        <select id="leftDb"></select>
      </label>
      <button type="button" class="secondary" id="swapBtn">Swap</button>
      <label>Right
        <select id="rightDb"></select>
      </label>
      <button type="button" class="secondary" id="copyReportBtn">Copy report</button>
    </div>
    <div class="summary hidden" id="summary"></div>
  </header>
  <div class="filters" id="filters">
    <input type="search" id="search" placeholder="Search tables or columns" autocomplete="off" />
    <div class="seg" role="group" aria-label="Kind" id="kindSeg">
      <button type="button" id="kindAll" aria-pressed="true">All</button>
      <button type="button" id="kindTables" aria-pressed="false">Tables</button>
      <button type="button" id="kindViews" aria-pressed="false">Views</button>
    </div>
    <div class="seg hidden" role="group" aria-label="How deep" id="depthSeg">
      <button type="button" id="depthTable" aria-pressed="false" title="Only missing tables">Table</button>
      <button type="button" id="depthColumn" aria-pressed="false" title="Missing tables and missing columns">Columns</button>
      <button type="button" id="depthType" aria-pressed="false" title="Also different types, like varchar vs int">Type</button>
      <button type="button" id="depthSize" aria-pressed="true" title="Also length, like varchar(8) vs varchar(7)">Size</button>
    </div>
    <div class="seg hidden" role="group" aria-label="Differences" id="diffSeg">
      <button type="button" id="diffAll" aria-pressed="false">All</button>
      <button type="button" id="diffDiffs" aria-pressed="true">Differences</button>
      <button type="button" id="diffChanged" aria-pressed="false">Changed</button>
      <button type="button" id="diffLeft" aria-pressed="false">Only left</button>
      <button type="button" id="diffRight" aria-pressed="false">Only right</button>
    </div>
  </div>
  <div class="body" id="body">
    <nav class="list" id="list" aria-label="Tables"></nav>
    <section class="detail" id="detail"></section>
  </div>
  <div class="empty" id="empty"></div>
  <div class="note" id="note" role="status"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const els = {
    subtitle: document.getElementById('subtitle'),
    metrics: document.getElementById('metrics'),
    dbChips: document.getElementById('dbChips'),
    filters: document.getElementById('filters'),
    body: document.getElementById('body'),
    list: document.getElementById('list'),
    detail: document.getElementById('detail'),
    empty: document.getElementById('empty'),
    search: document.getElementById('search'),
    kindAll: document.getElementById('kindAll'),
    kindTables: document.getElementById('kindTables'),
    kindViews: document.getElementById('kindViews'),
    refreshBtn: document.getElementById('refreshBtn'),
    loginBtn: document.getElementById('loginBtn'),
    note: document.getElementById('note'),
    modeBrowse: document.getElementById('modeBrowse'),
    modeCompare: document.getElementById('modeCompare'),
    compareBar: document.getElementById('compareBar'),
    leftDb: document.getElementById('leftDb'),
    rightDb: document.getElementById('rightDb'),
    swapBtn: document.getElementById('swapBtn'),
    copyReportBtn: document.getElementById('copyReportBtn'),
    summary: document.getElementById('summary'),
    kindSeg: document.getElementById('kindSeg'),
    depthSeg: document.getElementById('depthSeg'),
    depthTable: document.getElementById('depthTable'),
    depthColumn: document.getElementById('depthColumn'),
    depthType: document.getElementById('depthType'),
    depthSize: document.getElementById('depthSize'),
    diffSeg: document.getElementById('diffSeg'),
    diffAll: document.getElementById('diffAll'),
    diffDiffs: document.getElementById('diffDiffs'),
    diffChanged: document.getElementById('diffChanged'),
    diffLeft: document.getElementById('diffLeft'),
    diffRight: document.getElementById('diffRight')
  };

  let tables = [];
  let engine = 'mssql';
  let defaultDb = '';
  let lastInit = null;
  let selectedKey = '';
  let dbFilter = '';
  let kind = 'all';
  let query = '';
  let noteTimer;
  let mode = 'browse';
  let diff = null;
  let diffFilter = 'diff';
  let depth = 'size';
  let selectedDiffKey = '';

  const DEPTH_RANK = { table: 1, column: 2, type: 3, size: 4, flags: 4, none: 9 };

  function depthRank(level) {
    return DEPTH_RANK[level] || 9;
  }

  function isChangeVisible(level) {
    return depthRank(level) <= depthRank(depth);
  }

  function effectiveStatus(table) {
    if (table.status === 'leftOnly' || table.status === 'rightOnly' || table.status === 'identical') {
      return table.status;
    }
    return isChangeVisible(table.changeLevel) ? 'changed' : 'identical';
  }

  function setKind(next) {
    kind = next;
    els.kindAll.setAttribute('aria-pressed', next === 'all' ? 'true' : 'false');
    els.kindTables.setAttribute('aria-pressed', next === 'tables' ? 'true' : 'false');
    els.kindViews.setAttribute('aria-pressed', next === 'views' ? 'true' : 'false');
    renderList();
  }

  els.kindAll.addEventListener('click', () => setKind('all'));
  els.kindTables.addEventListener('click', () => setKind('tables'));
  els.kindViews.addEventListener('click', () => setKind('views'));
  els.search.addEventListener('input', () => {
    query = els.search.value.trim().toLowerCase();
    if (mode === 'compare') renderCompare();
    else renderList();
  });
  els.refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  els.loginBtn.addEventListener('click', () => vscode.postMessage({ type: 'openLogin' }));
  els.modeBrowse.addEventListener('click', () => setMode('browse'));
  els.modeCompare.addEventListener('click', () => setMode('compare'));
  els.swapBtn.addEventListener('click', () => {
    const left = els.leftDb.value;
    els.leftDb.value = els.rightDb.value;
    els.rightDb.value = left;
    requestCompare();
  });
  els.leftDb.addEventListener('change', requestCompare);
  els.rightDb.addEventListener('change', requestCompare);
  els.copyReportBtn.addEventListener('click', () => {
    const left = els.leftDb.value;
    const right = els.rightDb.value;
    if (!left || !right || left === right) return;
    vscode.postMessage({
      type: 'copyReport',
      left,
      right,
      filter: diffFilter,
      query: els.search.value.trim(),
      depth
    });
  });
  els.diffAll.addEventListener('click', () => setDiffFilter('all'));
  els.diffDiffs.addEventListener('click', () => setDiffFilter('diff'));
  els.diffChanged.addEventListener('click', () => setDiffFilter('changed'));
  els.diffLeft.addEventListener('click', () => setDiffFilter('left'));
  els.diffRight.addEventListener('click', () => setDiffFilter('right'));
  els.depthTable.addEventListener('click', () => setDepth('table'));
  els.depthColumn.addEventListener('click', () => setDepth('column'));
  els.depthType.addEventListener('click', () => setDepth('type'));
  els.depthSize.addEventListener('click', () => setDepth('size'));

  function setMode(next) {
    mode = next;
    els.modeBrowse.setAttribute('aria-pressed', next === 'browse' ? 'true' : 'false');
    els.modeCompare.setAttribute('aria-pressed', next === 'compare' ? 'true' : 'false');
    els.compareBar.classList.toggle('hidden', next !== 'compare');
    els.summary.classList.toggle('hidden', next !== 'compare');
    els.kindSeg.classList.toggle('hidden', next === 'compare');
    els.depthSeg.classList.toggle('hidden', next !== 'compare');
    els.diffSeg.classList.toggle('hidden', next !== 'compare');
    els.dbChips.classList.toggle('hidden', next === 'compare');
    els.metrics.classList.toggle('hidden', next === 'compare');
    els.search.placeholder = next === 'compare' ? 'Search compared tables' : 'Search tables or columns';
    if (next === 'compare') {
      els.subtitle.textContent = 'Table = missing tables. Columns = missing columns. Type = varchar vs int. Size = varchar(8) vs varchar(7).';
      fillDbSelects();
      requestCompare();
    } else if (lastInit) {
      renderOverview(lastInit);
      renderList();
    }
  }

  function setDiffFilter(next) {
    diffFilter = next;
    els.diffAll.setAttribute('aria-pressed', next === 'all' ? 'true' : 'false');
    els.diffDiffs.setAttribute('aria-pressed', next === 'diff' ? 'true' : 'false');
    els.diffChanged.setAttribute('aria-pressed', next === 'changed' ? 'true' : 'false');
    els.diffLeft.setAttribute('aria-pressed', next === 'left' ? 'true' : 'false');
    els.diffRight.setAttribute('aria-pressed', next === 'right' ? 'true' : 'false');
    renderCompare();
  }

  function setDepth(next) {
    depth = next;
    els.depthTable.setAttribute('aria-pressed', next === 'table' ? 'true' : 'false');
    els.depthColumn.setAttribute('aria-pressed', next === 'column' ? 'true' : 'false');
    els.depthType.setAttribute('aria-pressed', next === 'type' ? 'true' : 'false');
    els.depthSize.setAttribute('aria-pressed', next === 'size' ? 'true' : 'false');
    renderCompare();
  }

  function dbNames() {
    return dbCounts().map((entry) => entry[0]);
  }

  function fillDbSelects() {
    const names = dbNames();
    const keepLeft = els.leftDb.value;
    const keepRight = els.rightDb.value;
    els.leftDb.replaceChildren();
    els.rightDb.replaceChildren();
    for (const name of names) {
      els.leftDb.appendChild(new Option(name, name));
      els.rightDb.appendChild(new Option(name, name));
    }
    const leftPick = names.find((name) => name === keepLeft)
      || names.find((name) => name.toLowerCase() === defaultDb.toLowerCase())
      || names[0]
      || '';
    const rightPick = names.find((name) => name === keepRight && name !== leftPick)
      || names.find((name) => name !== leftPick)
      || names[0]
      || '';
    els.leftDb.value = leftPick;
    els.rightDb.value = rightPick;
    els.copyReportBtn.disabled = names.length < 2;
    els.swapBtn.disabled = names.length < 2;
  }

  function requestCompare() {
    if (mode !== 'compare') return;
    const left = els.leftDb.value;
    const right = els.rightDb.value;
    if (!left || !right || left === right) {
      diff = null;
      renderCompare();
      return;
    }
    vscode.postMessage({ type: 'compare', left, right });
  }

  function showNote(text) {
    els.note.textContent = text;
    els.note.classList.add('show');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => els.note.classList.remove('show'), 1600);
  }

  function relativeTime(ms) {
    if (!ms) return 'never';
    const delta = Date.now() - ms;
    const minutes = Math.round(delta / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + ' hr ago';
    return Math.round(hours / 24) + ' days ago';
  }

  function displayName(table) {
    return engine === 'mysql' ? table.name : table.schema + '.' + table.name;
  }

  function kindIconSvg(isView) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'kind-icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (isView) {
      svg.innerHTML =
        '<rect x="1.8" y="2.2" width="9.6" height="8.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
        '<rect x="4.6" y="5.4" width="9.6" height="8.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/>';
    } else {
      svg.innerHTML =
        '<rect x="1.4" y="2.4" width="13.2" height="11.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
        '<path d="M1.4 5.8h13.2M5.8 5.8v7.8M10.2 5.8v7.8M1.4 9.3h13.2" fill="none" stroke="currentColor" stroke-width="1.1"/>';
    }
    return svg;
  }

  function kindIcon(isView) {
    const wrap = document.createElement('span');
    wrap.className = 'kind-wrap';
    wrap.title = isView ? 'View' : 'Table';
    wrap.appendChild(kindIconSvg(isView));
    return wrap;
  }

  function kindIcons(leftView, rightView, kindChanged) {
    if (kindChanged && leftView !== rightView) {
      const wrap = document.createElement('span');
      wrap.className = 'kind-wrap';
      wrap.title = 'Table and view';
      wrap.appendChild(kindIconSvg(false));
      wrap.appendChild(kindIconSvg(true));
      return wrap;
    }
    return kindIcon(!!(rightView || leftView));
  }

  function previewQualified(name) {
    if (!name) return;
    vscode.postMessage({ type: 'preview', qualifiedName: name });
  }

  function qualifiedForDiff(tableDiff) {
    if (!diff) return '';
    const db = tableDiff.left ? diff.left : diff.right;
    return (tables.find((t) => {
      if (t.database.toLowerCase() !== db.toLowerCase()) return false;
      const match = engine === 'mysql' ? t.name : t.schema + '.' + t.name;
      return match.toLowerCase() === tableDiff.key;
    }) || {}).qualifiedName || '';
  }

  function groupKey(table) {
    return engine === 'postgres' ? table.schema : table.database;
  }

  function dbCounts() {
    const map = new Map();
    for (const table of tables) {
      const key = groupKey(table);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function matches(table) {
    if (dbFilter && groupKey(table).toLowerCase() !== dbFilter) return false;
    if (kind === 'tables' && table.isView) return false;
    if (kind === 'views' && !table.isView) return false;
    if (!query) return true;
    if (table.name.toLowerCase().includes(query)) return true;
    if (table.qualifiedName.toLowerCase().includes(query)) return true;
    return table.columns.some((col) => col.name.toLowerCase().includes(query));
  }

  function filtered() {
    return tables.filter(matches);
  }

  function metric(parent, n, label) {
    const wrap = document.createElement('div');
    wrap.className = 'metric';
    const num = document.createElement('div');
    num.className = 'n';
    num.textContent = String(n);
    const lab = document.createElement('span');
    lab.className = 'l';
    lab.textContent = label;
    wrap.appendChild(num);
    wrap.appendChild(lab);
    parent.appendChild(wrap);
  }

  function renderOverview(msg) {
    const views = tables.filter((t) => t.isView).length;
    const tableCount = tables.length - views;
    const cols = tables.reduce((sum, t) => sum + t.columns.length, 0);
    const dbs = dbCounts();
    const groupNoun =
      engine === 'postgres'
        ? (dbs.length === 1 ? 'schema' : 'schemas')
        : (dbs.length === 1 ? 'database' : 'databases');
    els.metrics.replaceChildren();
    metric(els.metrics, tableCount, 'tables');
    metric(els.metrics, views, 'views');
    metric(els.metrics, dbs.length, groupNoun);
    metric(els.metrics, cols, 'columns');

    const engineLabel =
      msg.engine === 'mysql' ? 'MySQL' : msg.engine === 'postgres' ? 'PostgreSQL' : 'SQL Server';
    const host = msg.server || 'not connected';
    const age = relativeTime(msg.fetchedAt);
    const stale = msg.stale ? 'disk cache' : 'live fetch';
    els.subtitle.textContent = engineLabel + ' · ' + host + ' · ' + stale + ' · ' + age;

    els.dbChips.replaceChildren();
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip';
    all.textContent = engine === 'postgres' ? 'All schemas' : 'All databases';
    all.setAttribute('aria-pressed', dbFilter ? 'false' : 'true');
    all.addEventListener('click', () => {
      dbFilter = '';
      renderOverview(msg);
      renderList();
    });
    els.dbChips.appendChild(all);
    for (const [name, count] of dbs) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = name + ' · ' + count;
      chip.setAttribute('aria-pressed', dbFilter === name.toLowerCase() ? 'true' : 'false');
      chip.addEventListener('click', () => {
        dbFilter = name.toLowerCase();
        renderOverview(msg);
        renderList();
      });
      els.dbChips.appendChild(chip);
    }
  }

  function renderEmptyCache() {
    els.filters.classList.add('hidden');
    els.body.classList.add('hidden');
    els.compareBar.classList.add('hidden');
    els.summary.classList.add('hidden');
    els.depthSeg.classList.add('hidden');
    els.empty.classList.remove('hidden');
    els.empty.replaceChildren();
    const p = document.createElement('p');
    p.textContent = 'No schema in cache yet. Connect once to load tables. After that, this page works offline.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = 'Open login';
    btn.addEventListener('click', () => vscode.postMessage({ type: 'openLogin' }));
    els.empty.appendChild(p);
    els.empty.appendChild(btn);
  }

  function renderList() {
    const rows = filtered();
    els.list.replaceChildren();
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '16px';
      p.textContent = 'No tables match.';
      els.list.appendChild(p);
      if (!rows.some((t) => t.qualifiedName === selectedKey)) {
        renderDetail(undefined);
      }
      return;
    }
    if (!rows.some((t) => t.qualifiedName === selectedKey)) {
      selectedKey = rows[0].qualifiedName;
    }
    let lastGroup = '';
    for (const table of rows) {
      const groupName = table.database;
      if (groupName !== lastGroup) {
        lastGroup = groupName;
        const g = document.createElement('div');
        g.className = 'group';
        g.textContent = groupName;
        els.list.appendChild(g);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item';
      btn.dataset.key = table.qualifiedName;
      btn.setAttribute('aria-selected', table.qualifiedName === selectedKey ? 'true' : 'false');
      btn.appendChild(kindIcon(table.isView));
      btn.title = 'Double-click to preview rows';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = displayName(table);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = String(table.columns.length);
      btn.appendChild(name);
      btn.appendChild(meta);
      btn.addEventListener('click', () => {
        selectedKey = table.qualifiedName;
        for (const el of els.list.querySelectorAll('.item')) {
          el.setAttribute('aria-selected', el.dataset.key === selectedKey ? 'true' : 'false');
        }
        renderDetail(table);
      });
      btn.addEventListener('dblclick', () => previewQualified(table.qualifiedName));
      els.list.appendChild(btn);
    }
    renderDetail(tables.find((t) => t.qualifiedName === selectedKey));
  }

  function renderDetail(table) {
    els.detail.replaceChildren();
    if (!table) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Select a table.';
      els.detail.appendChild(p);
      return;
    }
    const head = document.createElement('div');
    head.className = 'detail-head';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title-row';
    title.appendChild(kindIcon(table.isView));
    title.title = 'Double-click to preview rows';
    title.addEventListener('dblclick', () => previewQualified(table.qualifiedName));
    const h2 = document.createElement('h2');
    h2.textContent = displayName(table);
    title.appendChild(h2);
    const q = document.createElement('p');
    q.className = 'qualified';
    q.textContent = table.qualifiedName;
    left.appendChild(title);
    left.appendChild(q);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary';
    copy.textContent = 'Copy name';
    copy.addEventListener('click', () => {
      vscode.postMessage({ type: 'copy', text: table.qualifiedName });
    });
    head.appendChild(left);
    head.appendChild(copy);
    els.detail.appendChild(head);

    const flags = document.createElement('p');
    flags.className = 'flags';
    const pk = table.columns.filter((c) => c.isPrimaryKey).length;
    flags.textContent =
      (table.isView ? 'View' : 'Table') +
      ' · ' + table.columns.length + ' columns' +
      (pk ? ' · ' + pk + ' primary key' + (pk === 1 ? '' : 's') : '');
    els.detail.appendChild(flags);

    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['', 'Column', 'Type', 'Null']) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const col of table.columns) {
      const tr = document.createElement('tr');
      const pkCell = document.createElement('td');
      pkCell.className = 'pk';
      pkCell.textContent = col.isPrimaryKey ? 'PK' : '';
      const name = document.createElement('td');
      name.className = 'code';
      name.textContent = col.name;
      const extra = [];
      if (col.isIdentity) extra.push('identity');
      if (col.isComputed) extra.push('computed');
      if (extra.length) {
        const hint = document.createElement('div');
        hint.className = 'muted';
        hint.textContent = extra.join(' · ');
        name.appendChild(hint);
      }
      const type = document.createElement('td');
      type.className = 'code muted';
      type.textContent = col.typeDisplay;
      const nul = document.createElement('td');
      nul.className = col.isNullable ? 'muted' : '';
      nul.textContent = col.isNullable ? 'YES' : 'NO';
      tr.appendChild(pkCell);
      tr.appendChild(name);
      tr.appendChild(type);
      tr.appendChild(nul);
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    els.detail.appendChild(tbl);
  }

  function statusLabel(status) {
    if (status === 'identical') return 'same';
    if (status === 'changed') return 'changed';
    if (status === 'leftOnly') return 'only left';
    return 'only right';
  }

  function changeLevelLabel(level) {
    if (level === 'table') return 'table';
    if (level === 'column') return 'columns';
    if (level === 'type') return 'type';
    if (level === 'flags') return 'flags';
    return 'size';
  }

  function compareTag(table) {
    const status = effectiveStatus(table);
    if (status !== 'changed') return statusLabel(status);
    return changeLevelLabel(table.changeLevel);
  }

  function columnLine(col) {
    if (!col) return '—';
    const bits = [col.typeDisplay];
    if (col.isPrimaryKey) bits.push('PK');
    bits.push(col.isNullable ? 'NULL' : 'NOT NULL');
    if (col.isIdentity) bits.push('identity');
    if (col.isComputed) bits.push('computed');
    return bits.join(' · ');
  }

  function diffMatches(table) {
    const status = effectiveStatus(table);
    if (diffFilter === 'diff' && status === 'identical') return false;
    if (diffFilter === 'changed' && status !== 'changed') return false;
    if (diffFilter === 'left' && status !== 'leftOnly') return false;
    if (diffFilter === 'right' && status !== 'rightOnly') return false;
    if (diffFilter === 'identical' && status !== 'identical') return false;
    if (!query) return true;
    if (table.displayName.toLowerCase().includes(query)) return true;
    return table.columns.some((col) => col.name.toLowerCase().includes(query));
  }

  function countsAtDepth() {
    const counts = { identical: 0, changed: 0, leftOnly: 0, rightOnly: 0 };
    if (!diff) return counts;
    for (const table of diff.tables) {
      counts[effectiveStatus(table)] += 1;
    }
    return counts;
  }

  function renderSummary() {
    els.summary.replaceChildren();
    if (!diff) return;
    const counts = countsAtDepth();
    const items = [
      ['all', String(diff.tables.length), 'objects'],
      ['changed', String(counts.changed), 'different'],
      ['left', String(counts.leftOnly), 'only left'],
      ['right', String(counts.rightOnly), 'only right'],
      ['diff', String(counts.changed + counts.leftOnly + counts.rightOnly), 'differences'],
      ['identical', String(counts.identical), 'identical']
    ];
    for (const [key, n, label] of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', diffFilter === key ? 'true' : 'false');
      const num = document.createElement('span');
      num.className = 'n';
      num.textContent = n;
      const lab = document.createElement('span');
      lab.className = 'l';
      lab.textContent = label;
      btn.appendChild(num);
      btn.appendChild(lab);
      btn.addEventListener('click', () => setDiffFilter(key));
      els.summary.appendChild(btn);
    }
  }

  function renderCompare() {
    renderSummary();
    els.list.replaceChildren();
    const names = dbNames();
    if (names.length < 2) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '16px';
      p.textContent = 'Load at least two databases in Login, then refresh.';
      els.list.appendChild(p);
      els.detail.replaceChildren();
      const d = document.createElement('p');
      d.className = 'muted';
      d.textContent = 'Compare needs two cached databases.';
      els.detail.appendChild(d);
      return;
    }
    if (!diff || els.leftDb.value === els.rightDb.value) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '16px';
      p.textContent = 'Pick two different databases.';
      els.list.appendChild(p);
      els.detail.replaceChildren();
      return;
    }
    const rows = diff.tables.filter(diffMatches);
    const groupOrder = ['leftOnly', 'rightOnly', 'table', 'column', 'type', 'size', 'flags', 'identical'];
    const labels = {
      leftOnly: 'Only in ' + diff.left,
      rightOnly: 'Only in ' + diff.right,
      table: 'Table / view',
      column: 'Columns',
      type: 'Type',
      size: 'Size',
      flags: 'Flags',
      identical: 'Identical'
    };
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '16px';
      p.textContent = 'No tables match.';
      els.list.appendChild(p);
      renderCompareDetail(undefined);
      return;
    }
    if (!rows.some((row) => row.key === selectedDiffKey)) {
      selectedDiffKey = rows[0].key;
    }
    function groupKey(table) {
      const status = effectiveStatus(table);
      if (status !== 'changed') return status;
      return table.changeLevel || 'size';
    }
    for (const key of groupOrder) {
      const groupRows = rows.filter((row) => groupKey(row) === key);
      if (groupRows.length === 0) continue;
      const g = document.createElement('div');
      g.className = 'group';
      g.textContent = labels[key] + ' · ' + groupRows.length;
      els.list.appendChild(g);
      for (const table of groupRows) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'item';
        btn.dataset.key = table.key;
        btn.setAttribute('aria-selected', table.key === selectedDiffKey ? 'true' : 'false');
        btn.appendChild(kindIcons(
          table.left && table.left.isView,
          table.right && table.right.isView,
          table.kindChanged
        ));
        btn.title = 'Double-click to preview rows';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = table.displayName;
        const meta = document.createElement('span');
        meta.className = 'meta tag';
        meta.textContent = compareTag(table);
        btn.appendChild(name);
        btn.appendChild(meta);
        btn.addEventListener('click', () => {
          selectedDiffKey = table.key;
          for (const el of els.list.querySelectorAll('.item')) {
            el.setAttribute('aria-selected', el.dataset.key === selectedDiffKey ? 'true' : 'false');
          }
          renderCompareDetail(table);
        });
        btn.addEventListener('dblclick', () => previewQualified(qualifiedForDiff(table)));
        els.list.appendChild(btn);
      }
    }
    renderCompareDetail(diff.tables.find((row) => row.key === selectedDiffKey));
  }

  function renderCompareDetail(table) {
    els.detail.replaceChildren();
    if (!diff || !table) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Select a table.';
      els.detail.appendChild(p);
      return;
    }
    const head = document.createElement('div');
    head.className = 'detail-head';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title-row';
    title.appendChild(kindIcons(
      table.left && table.left.isView,
      table.right && table.right.isView,
      table.kindChanged
    ));
    title.title = 'Double-click to preview rows';
    title.addEventListener('dblclick', () => previewQualified(qualifiedForDiff(table)));
    const h2 = document.createElement('h2');
    h2.textContent = table.displayName;
    title.appendChild(h2);
    const q = document.createElement('p');
    q.className = 'qualified';
    q.textContent = diff.left + '  →  ' + diff.right;
    left.appendChild(title);
    left.appendChild(q);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary';
    copy.textContent = 'Copy name';
    copy.addEventListener('click', () => {
      vscode.postMessage({ type: 'copy', text: table.displayName });
    });
    head.appendChild(left);
    head.appendChild(copy);
    els.detail.appendChild(head);

    const flags = document.createElement('p');
    flags.className = 'flags';
    const shownStatus = effectiveStatus(table);
    const parts = [shownStatus === 'changed' ? changeLevelLabel(table.changeLevel) : statusLabel(shownStatus)];
    if (table.kindChanged) {
      parts.push(
        (table.left && table.left.isView ? 'view' : 'table') +
        ' vs ' +
        (table.right && table.right.isView ? 'view' : 'table')
      );
    }
    if (table.left) parts.push(table.left.columnCount + ' cols left');
    if (table.right) parts.push(table.right.columnCount + ' cols right');
    flags.textContent = parts.join(' · ');
    els.detail.appendChild(flags);

    if (shownStatus === 'identical') {
      const p = document.createElement('p');
      p.className = 'muted';
      if (table.status === 'changed') {
        p.textContent = 'Same at this depth. Go deeper to see type or size changes.';
      } else {
        p.textContent = 'Same columns in both databases.';
      }
      els.detail.appendChild(p);
    }

    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['', 'Column', diff.left, diff.right]) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    const showAsDiff = shownStatus !== 'identical';
    const showCols = showAsDiff
      ? table.columns.filter((col) => col.status !== 'identical' && isChangeVisible(col.changeLevel))
      : table.columns;
    if (showCols.length === 0) {
      return;
    }
    for (const col of showCols) {
      const tr = document.createElement('tr');
      const colDiff = showAsDiff && isChangeVisible(col.changeLevel);
      if (colDiff && col.status === 'leftOnly') tr.className = 'diff-left';
      else if (colDiff && col.status === 'rightOnly') tr.className = 'diff-right';
      else if (colDiff && col.status === 'changed') tr.className = 'diff-changed';
      const mark = document.createElement('td');
      mark.className = 'mark';
      mark.textContent = !colDiff ? '' : col.status === 'leftOnly' ? '−' : col.status === 'rightOnly' ? '+' : col.status === 'changed' ? '~' : '';
      const name = document.createElement('td');
      name.className = 'code';
      name.textContent = col.name;
      if (colDiff && col.changes.length) {
        const hint = document.createElement('div');
        hint.className = 'muted';
        hint.textContent = col.changes.join(' · ');
        name.appendChild(hint);
      }
      const leftCell = document.createElement('td');
      leftCell.className = 'code' + (col.left ? '' : ' muted');
      leftCell.textContent = columnLine(col.left);
      const rightCell = document.createElement('td');
      rightCell.className = 'code' + (col.right ? '' : ' muted');
      rightCell.textContent = columnLine(col.right);
      tr.appendChild(mark);
      tr.appendChild(name);
      tr.appendChild(leftCell);
      tr.appendChild(rightCell);
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    els.detail.appendChild(tbl);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      engine = msg.engine;
      defaultDb = msg.database || '';
      lastInit = msg;
      tables = msg.tables || [];
      tables.sort((a, b) => {
        const db = a.database.localeCompare(b.database);
        if (db) return db;
        const schema = a.schema.localeCompare(b.schema);
        if (schema) return schema;
        return a.name.localeCompare(b.name);
      });
      if (tables.length === 0) {
        els.metrics.replaceChildren();
        els.dbChips.replaceChildren();
        renderEmptyCache();
        return;
      }
      els.empty.classList.add('hidden');
      els.filters.classList.remove('hidden');
      els.body.classList.remove('hidden');
      if (dbFilter && !tables.some((t) => groupKey(t).toLowerCase() === dbFilter)) {
        dbFilter = '';
      }
      if (mode === 'compare') {
        els.compareBar.classList.remove('hidden');
        els.summary.classList.remove('hidden');
        els.kindSeg.classList.add('hidden');
        els.depthSeg.classList.remove('hidden');
        els.diffSeg.classList.remove('hidden');
        els.dbChips.classList.add('hidden');
        els.metrics.classList.add('hidden');
        els.subtitle.textContent = 'Table = missing tables. Columns = missing columns. Type = varchar vs int. Size = varchar(8) vs varchar(7).';
        fillDbSelects();
        requestCompare();
      } else {
        renderOverview(msg);
        renderList();
      }
    } else if (msg.type === 'diff') {
      diff = msg.diff;
      renderCompare();
    } else if (msg.type === 'status') {
      els.refreshBtn.disabled = !!msg.busy;
      if (msg.message) showNote(msg.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}

function toDto(table: TableInfo): SchemaTableDto {
    return {
        database: table.database,
        schema: table.schema,
        name: table.name,
        qualifiedName: table.qualifiedName,
        isView: table.isView,
        columns: table.columns.map(toColumnDto)
    };
}

function toColumnDto(column: ColumnInfo): SchemaColumnDto {
    return {
        name: column.name,
        typeDisplay: column.typeDisplay,
        isNullable: column.isNullable,
        isIdentity: column.isIdentity,
        isComputed: column.isComputed,
        isPrimaryKey: column.isPrimaryKey
    };
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i++) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}
