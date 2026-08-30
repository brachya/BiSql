/** Live schema/status belong to the active login only. A new or other row stays blank. */
export function panelStatsForSelection(input: {
    selectedId: string;
    activeId: string;
    hasServer: boolean;
    liveState: string;
    lastError?: string;
    tableCount: number;
    stale: boolean;
}): { state: string; lastError?: string; tableCount: number; stale: boolean } {
    if (!input.hasServer) {
        return { state: 'unconfigured', tableCount: 0, stale: false };
    }
    if (input.selectedId && input.selectedId === input.activeId) {
        return {
            state: input.liveState,
            lastError: input.lastError,
            tableCount: input.tableCount,
            stale: input.stale
        };
    }
    return { state: 'disconnected', tableCount: 0, stale: false };
}

/** Webview HTML for the focused four-kind login page. */

const ICON_MSSQL = `<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7" ry="2.4"/><path d="M5 5.5v4.2c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4V5.5"/><path d="M5 9.7v4.2c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4V9.7"/><path d="M5 13.9v4.2c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4v-4.2"/></svg>`;
const ICON_MYSQL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.2 14.2c2.8-5.6 8.6-7.6 13.8-5 1.8.9 3 2.1 3.6 3.3-1.6-.1-2.8.1-3.8.5 1.8 1 2.8 2.4 2.8 4 0 .8-.4 1.5-1.1 1.9-1.5-2.2-4.4-3.3-8.2-3.3-2.5 0-4.4.6-5.7 1.6-.5-1.1-1.4-2.3-2.4-3zm8 1.1c2.9 0 5.1.7 6 2.1-.9 1.5-3.2 2.4-6.1 2.4-1.6 0-3-.2-4-.7.6-2.1 1.9-3.8 4.1-3.8zm-1.5 1.8a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9zM6.8 18c.6 1.2.3 2.3-.7 3.1.2-1.4-.3-2.2-1.3-2.9.7-.2 1.4 0 2-.2z"/></svg>`;
const ICON_POSTGRES = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.1 6.4c2.3-2 6.6-2 8.6.5 1.1 1.4 1.1 3.2.1 4.4-.2 1.8-1.5 3.2-3.3 3.8v2.1c0 .8-.7 1.5-1.5 1.5s-1.5-.7-1.5-1.5v-2c-2.2-.6-3.8-2.2-4.2-4.4-1.3 1.1-2.3 2.4-3.1 3.8-.4.6-1.3.2-1.2-.5.4-2.5 2.2-4.5 4.4-5.3.5-.3 1.1-.5 1.7-.7zm8.5 1.1c1.4.3 2.6 1.4 2.6 2.8 0 1-.5 1.8-1.4 2.2.2-1.6-.2-3.2-1.2-4.4v-.6zM9.7 9.3a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3z"/></svg>`;
const ICON_SUPABASE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.4 2.1 4.4 14.6h7.2l-1.1 7.3 9.3-13.4h-7.2l.8-6.4z"/></svg>`;

const PWD_TOGGLE = `<button type="button" class="pwd-toggle" title="Show password" aria-label="Show password"><svg class="icon-eye" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/><circle cx="12" cy="12" r="2.2"/></svg><svg class="icon-eye-off" viewBox="0 0 24 24" aria-hidden="true" hidden><path d="M2 4.3 3.3 3l18 18-1.3 1.3-3.2-3.2A12.6 12.6 0 0 1 12 19c-7 0-10-7-10-7a21.4 21.4 0 0 1 5.1-5.4L2 4.3zm7.1 7.1A3.9 3.9 0 0 0 12 16a4 4 0 0 0 4-4 3.9 3.9 0 0 0-.6-2.1l-6.3 6.5zM12 5c7 0 10 7 10 7a21 21 0 0 1-3.7 4.3l-1.5-1.5A12.5 12.5 0 0 0 20.5 12S17.7 7 12 7c-.7 0-1.3.1-1.9.2L8.6 5.7C9.7 5.3 10.8 5 12 5z"/></svg></button>`;

/** One native &lt;details&gt; block. Reuse this for every section on the login page. */
export function expansionPanel(
    id: string,
    title: string,
    hint: string,
    body: string,
    open = false
): string {
    return `<details class="xp" id="${id}"${open ? ' open' : ''}>
    <summary class="xp-head">
      <span class="xp-chevron" aria-hidden="true"></span>
      <span class="xp-copy">
        <span class="xp-title">${title}</span>
        <span class="xp-hint" id="${id}Hint">${hint}</span>
      </span>
    </summary>
    <div class="xp-body">${body}</div>
  </details>`;
}

function hostPortRow(idPrefix: string, serverPlaceholder: string, port: string): string {
    return `<div class="row-2">
            <label>Server <input id="${idPrefix}Server" type="text" placeholder="${serverPlaceholder}" /></label>
            <label>Port <input id="${idPrefix}Port" type="number" min="1" max="65535" value="${port}" /></label>
          </div>`;
}

function userField(id: string): string {
    return `<label>Username <input id="${id}" type="text" placeholder="readonly_user" autocomplete="username" /></label>`;
}

function passwordField(id: string, placeholder: string): string {
    return `<label>Password <div class="pwd-wrap"><input id="${id}" type="password" placeholder="${placeholder}" autocomplete="current-password" />${PWD_TOGGLE}</div></label>`;
}

function securityChecks(
    encryptId: string,
    trustId: string,
    encryptLabel: string,
    trustLabel: string
): string {
    return `<div class="checks">
            <label class="check"><input id="${encryptId}" type="checkbox" checked /><span>${encryptLabel}</span></label>
            <label class="check"><input id="${trustId}" type="checkbox" /><span>${trustLabel}</span></label>
          </div>`;
}

function kindCard(
    id: string,
    value: string,
    icon: string,
    title: string,
    hint: string,
    checked = false
): string {
    return `<label class="engine-option">
              <input type="radio" name="loginKind" id="${id}" value="${value}"${checked ? ' checked' : ''} />
              <div class="engine-card">
                <span class="kind-icon">${icon}</span>
                <span class="kind-copy"><strong>${title}</strong><span>${hint}</span></span>
              </div>
            </label>`;
}

export function connectionPanelHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Database Login</title>
<style nonce="${nonce}">
  :root { --gap: 12px; --radius: 8px; --btn-col: 6.75rem; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 20px 36px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.02em; }
  .sub { margin: 0 0 16px; opacity: 0.75; line-height: 1.45; }
  .form { display: grid; gap: 10px; }
  .row-2 { display: grid; grid-template-columns: minmax(0, 1fr) 88px; gap: var(--gap); }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; opacity: 0.92; }
  label span.hint { font-size: 0.75rem; opacity: 0.65; font-weight: 400; }
  input[type="text"], input[type="password"], input[type="number"], textarea {
    width: 100%; padding: 8px 10px; border-radius: 4px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    font: inherit; outline: none;
  }
  textarea { min-height: 88px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82rem; }
  input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  .checks { display: flex; flex-direction: column; gap: 10px; }
  .check { display: flex; flex-direction: row; align-items: flex-start; gap: 8px; font-size: 0.9rem; cursor: pointer; }
  .check input { margin-top: 3px; flex-shrink: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  button {
    font: inherit; padding: 8px 14px; border-radius: 4px; border: 1px solid transparent; cursor: pointer;
    white-space: nowrap;
  }
  button:disabled { opacity: 0.55; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .status {
    margin-top: 4px; padding: 10px 12px; border-radius: 4px; line-height: 1.4;
    display: none; white-space: pre-wrap;
  }
  .status.show { display: block; }
  .status.ok {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 18%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 45%, transparent);
  }
  .status.err {
    background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f85149) 40%, transparent);
  }
  .status.busy {
    background: var(--vscode-inputValidation-infoBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-infoBorder, transparent);
  }
  .badge {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: fit-content; max-width: 100%;
    margin-bottom: 14px; padding: 6px 10px; border-radius: 8px; font-size: 0.78rem; line-height: 1.4;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .pwd-note { font-size: 0.78rem; opacity: 0.7; margin: 0; }
  .pwd-wrap { position: relative; display: flex; align-items: stretch; }
  .pwd-wrap input { padding-right: 42px; }
  .pwd-toggle {
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    width: 34px; height: 28px; padding: 0; border: none; border-radius: 4px;
    background: transparent; color: var(--vscode-foreground); opacity: 0.7;
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  }
  .pwd-toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, transparent); }
  .pwd-toggle svg { width: 16px; height: 16px; fill: currentColor; }
  .engine-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .engine-option { position: relative; display: block; cursor: pointer; min-width: 0; }
  .engine-option input { position: absolute; opacity: 0; pointer-events: none; }
  .engine-card {
    display: flex; align-items: center; gap: 8px;
    padding: 10px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
  }
  .engine-option input:focus-visible + .engine-card { outline: 1px solid var(--vscode-focusBorder); }
  .engine-option input:checked + .engine-card {
    border-color: var(--vscode-focusBorder);
    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
  }
  .kind-icon { width: 22px; height: 22px; flex-shrink: 0; opacity: 0.9; }
  .kind-icon svg { width: 22px; height: 22px; fill: currentColor; display: block; }
  .kind-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .engine-card strong { font-size: 0.88rem; }
  .engine-card span { font-size: 0.72rem; opacity: 0.7; line-height: 1.3; }
  .kind-body { display: grid; gap: 10px; }
  .kind-body[hidden] { display: none !important; }
  .xp {
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-radius: var(--radius);
    min-width: 0;
  }
  .xp-head {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 14px; cursor: pointer; list-style: none;
  }
  .xp-head::-webkit-details-marker, .xp-head::marker { display: none; }
  .xp-chevron {
    width: 7px; height: 7px; flex-shrink: 0; opacity: 0.55;
    border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
    transform: rotate(-45deg); margin-top: -2px;
  }
  .xp[open] > .xp-head .xp-chevron { transform: rotate(45deg); margin-top: 0; }
  .xp-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .xp-title { font-weight: 600; font-size: 0.9rem; }
  .xp-hint { font-size: 0.75rem; opacity: 0.65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .xp-body { display: grid; gap: var(--gap); padding: 0 14px 14px; min-width: 0; }
  .sb-summary, .sb-hint, .pg-list {
    padding: 10px 12px; border-radius: 6px; font-size: 0.82rem; line-height: 1.45;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  .sb-summary[hidden], .sb-hint[hidden], .pg-list[hidden] { display: none !important; }
  .sb-summary code { font-size: 0.78rem; word-break: break-all; }
  .db-picker {
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
    border-radius: 8px; overflow: hidden; background: var(--vscode-input-background);
    min-width: 0;
  }
  .db-search {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
  }
  .db-search svg { width: 16px; height: 16px; fill: currentColor; opacity: 0.55; flex-shrink: 0; }
  .db-search input[type="text"] { border: none; background: transparent; padding: 4px 0; box-shadow: none; }
  .db-search input[type="text"]:focus { border-color: transparent; }
  .db-list { max-height: 220px; overflow: auto; margin: 0; padding: 6px; border: none; background: transparent; }
  .db-empty { padding: 18px 12px; text-align: center; opacity: 0.62; font-size: 0.82rem; line-height: 1.45; }
  .db-row {
    display: grid; grid-template-columns: minmax(0, 1fr) var(--btn-col); align-items: center; gap: 8px;
    width: 100%; padding: 7px 8px; border-radius: 6px; border: 1px solid transparent;
    background: transparent; color: inherit; text-align: left; font: inherit; appearance: none;
  }
  .db-row:hover { background: var(--vscode-list-hoverBackground, transparent); }
  .db-row.is-selected:not(.is-default) {
    background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground, transparent));
  }
  .db-row.is-default {
    border-color: var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
  }
  .db-row.db-custom, .db-row.db-pick { grid-template-columns: minmax(0, 1fr); cursor: pointer; }
  .db-check { display: flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }
  .db-name {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 0.88rem;
  }
  .db-default-btn, .db-pill {
    width: var(--btn-col); justify-self: end; font-size: 0.72rem; padding: 4px 6px; border-radius: 999px;
    border: 1px solid var(--vscode-input-border, transparent); background: transparent;
    color: inherit; opacity: 0.8; appearance: none; text-align: center;
  }
  .db-default-btn:hover { opacity: 1; }
  .db-default-btn[aria-pressed="true"], .db-pill {
    opacity: 1; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-color: transparent; font-weight: 600;
  }
  .db-footer {
    display: grid; grid-template-columns: auto auto; justify-content: start; gap: 8px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .db-footer button { padding: 6px 12px; }
  .db-summary { grid-column: 1 / -1; font-size: 0.75rem; opacity: 0.75; line-height: 1.35; }
  .pg-load { display: flex; gap: 8px; align-items: center; }
  .conn-toolbar { display: flex; justify-content: flex-end; }
  .conn-list { display: grid; gap: 6px; }
  .conn-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center;
    padding: 4px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
  }
  .conn-row.is-selected {
    border-color: var(--vscode-focusBorder);
    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
  }
  .conn-row.is-active .conn-name { font-weight: 600; }
  .conn-main {
    display: flex; align-items: center; gap: 8px; min-width: 0;
    padding: 6px 8px; border: none; border-radius: 4px;
    background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit;
  }
  .conn-main:hover { background: var(--vscode-list-hoverBackground, transparent); }
  .conn-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .conn-name, .conn-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conn-name { font-size: 0.88rem; }
  .conn-host { font-size: 0.72rem; opacity: 0.65; }
  .conn-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; padding-right: 4px; }
  .conn-actions button { padding: 4px 10px; font-size: 0.72rem; }
  .conn-pill {
    flex-shrink: 0; font-size: 0.68rem; padding: 2px 7px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  @media (max-width: 520px) {
    .engine-grid { grid-template-columns: 1fr; }
    .conn-row { grid-template-columns: 1fr; }
    .conn-actions { justify-content: flex-start; padding: 0 8px 6px; }
    .row-2 { grid-template-columns: 1fr 88px; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Database Login</h1>
    <p class="sub">Save a few logins. One is active. Switching reconnects.</p>
    <div class="badge" id="badge">Checking…</div>

    <form class="form" id="form" autocomplete="off">
      <input type="hidden" id="connectionId" />
      ${expansionPanel(
          'connPanel',
          'Connections',
          'Click a row to edit it',
          `<div class="conn-toolbar"><button type="button" class="secondary" id="addConnBtn">Add</button></div>
          <div class="conn-list" id="connList"></div>`,
          true
      )}
      ${expansionPanel(
          'typePanel',
          'Login type',
          'SQL Server',
          `<label>Name <input id="connName" type="text" placeholder="SQL Server · localhost" /></label>
          <div class="engine-grid" role="radiogroup" aria-label="Login kind">
            ${kindCard('kindMssql', 'mssql', ICON_MSSQL, 'SQL Server', 'Host or instance · port 1433', true)}
            ${kindCard('kindMysql', 'mysql', ICON_MYSQL, 'MySQL', 'MySQL / MariaDB · port 3306')}
            ${kindCard('kindPostgres', 'postgres', ICON_POSTGRES, 'PostgreSQL', 'One database · port 5432')}
            ${kindCard('kindSupabase', 'supabase', ICON_SUPABASE, 'Supabase', 'Paste the dashboard URL')}
          </div>`,
          true
      )}

      <div id="bodyMssql" class="kind-body">
        ${expansionPanel('mssqlServerPanel', 'Server', 'Host and port', hostPortRow('mssql', 'localhost or host\\\\INSTANCE', '1433'), true)}
        ${expansionPanel('mssqlDbPanel', 'Databases', 'Pick a default, then check extras', '<div id="mssqlPickerMount"></div>', true)}
        ${expansionPanel('mssqlAuthPanel', 'Sign in', 'Username and password', userField('mssqlUser') + passwordField('mssqlPassword', '••••••••'), true)}
        ${expansionPanel(
            'mssqlSecPanel',
            'Security',
            'TLS',
            securityChecks(
                'mssqlEncrypt',
                'mssqlTrust',
                'Encrypt connection <span class="hint">(TLS)</span>',
                'Trust server certificate <span class="hint">(local / self-signed)</span>'
            ),
            false
        )}
      </div>

      <div id="bodyMysql" class="kind-body" hidden>
        ${expansionPanel('mysqlServerPanel', 'Server', 'Host and port', hostPortRow('mysql', 'localhost', '3306'), true)}
        ${expansionPanel('mysqlDbPanel', 'Databases', 'Pick a default, then check extras', '<div id="mysqlPickerMount"></div>', true)}
        ${expansionPanel('mysqlAuthPanel', 'Sign in', 'Username and password', userField('mysqlUser') + passwordField('mysqlPassword', '••••••••'), true)}
        ${expansionPanel(
            'mysqlSecPanel',
            'Security',
            'TLS',
            securityChecks('mysqlEncrypt', 'mysqlTrust', 'Use TLS', 'Allow self-signed certificate'),
            false
        )}
      </div>

      <div id="bodyPostgres" class="kind-body" hidden>
        ${expansionPanel('pgServerPanel', 'Server', 'Host and port', hostPortRow('pg', 'localhost', '5432'), true)}
        ${expansionPanel(
            'pgDbPanel',
            'Database',
            'One database per connection',
            `<label>Database <input id="pgDatabase" type="text" placeholder="postgres" /></label>
          <div class="pg-load"><button type="button" class="secondary" id="pgLoadDbsBtn">Load from server</button></div>
          <div class="pg-list" id="pgDbList" hidden></div>`,
            true
        )}
        ${expansionPanel('pgAuthPanel', 'Sign in', 'Username and password', userField('pgUser') + passwordField('pgPassword', '••••••••'), true)}
        ${expansionPanel(
            'pgSecPanel',
            'Security',
            'TLS',
            securityChecks('pgEncrypt', 'pgTrust', 'Use TLS', 'Allow self-signed certificate'),
            false
        )}
      </div>

      <div id="bodySupabase" class="kind-body" hidden>
        ${expansionPanel(
            'sbUrlPanel',
            'Connection URL',
            'Paste the dashboard URL',
            `<label>Connection URL
            <textarea id="sbUrl" placeholder="postgresql://postgres.xxxx:password@aws-0-….pooler.supabase.com:5432/postgres" spellcheck="false"></textarea>
          </label>
          <div class="sb-summary" id="sbSummary" hidden></div>
          <p class="sb-hint" id="sbPoolerHint" hidden>This is the direct db.… host. If Test times out, paste the Session pooler URL instead.</p>
          <input type="hidden" id="sbServer" />
          <input type="hidden" id="sbPort" />
          <input type="hidden" id="sbUser" />
          <input type="hidden" id="sbDatabase" />
          <input type="hidden" id="sbTrust" value="1" />`,
            true
        )}
        ${expansionPanel(
            'sbAuthPanel',
            'Sign in',
            'Database password',
            `<div id="sbPasswordWrap">${passwordField('sbPassword', 'Database password')}</div>`,
            true
        )}
      </div>

      <div id="dbPicker" hidden>
        <div class="db-picker">
          <div class="db-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0C7 14 5 12 5 9.5S7 5 9.5 5 14 7 14 9.5 12 14 9.5 14z"/></svg>
            <input id="dbSearch" type="text" placeholder="Search, type a name, or pick from the list" autocomplete="off" spellcheck="false" aria-label="Search or type a database name" />
            <input id="database" type="hidden" />
          </div>
          <div class="db-list" id="dbList" role="listbox" aria-label="Databases"></div>
          <div class="db-footer">
            <button type="button" class="secondary" id="loadDbsBtn">Load from server</button>
            <button type="button" class="secondary" id="selectAllDbsBtn">Select all</button>
            <span class="db-summary" id="dbSummary">No database selected</span>
          </div>
        </div>
      </div>

      ${expansionPanel(
          'optsPanel',
          'Options',
          'Enable, pin, password',
          `<p class="pwd-note" id="pwdNote">Saved in the OS keychain and filled in again when you reopen this page.</p>
          <div class="checks">
            <label class="check"><input id="enabled" type="checkbox" checked /><span>Enable the extension</span></label>
            <label class="check" id="pinWrap" hidden><input id="pinToWorkspace" type="checkbox" /><span>Use this connection in this project</span></label>
            <label class="check"><input id="clearPassword" type="checkbox" /><span>Clear stored password on save</span></label>
          </div>`,
          false
      )}

      <div class="actions">
        <button type="submit" class="primary" id="saveBtn">Save &amp; Connect</button>
        <button type="button" class="secondary" id="testBtn">Test Connection</button>
        <button type="button" class="secondary" id="browseBtn" hidden>Browse tables</button>
      </div>
      <div class="status" id="status" role="status"></div>
    </form>
  </div>
<script nonce="${nonce}">
${loginScript()}
</script>
</body>
</html>`;
}

function loginScript(): string {
    return `  const vscode = acquireVsCodeApi();
  const KIND_ICONS = {
    mssql: ${JSON.stringify(ICON_MSSQL)},
    mysql: ${JSON.stringify(ICON_MYSQL)},
    postgres: ${JSON.stringify(ICON_POSTGRES)},
    supabase: ${JSON.stringify(ICON_SUPABASE)}
  };

  const els = {
    kindMssql: document.getElementById('kindMssql'),
    kindMysql: document.getElementById('kindMysql'),
    kindPostgres: document.getElementById('kindPostgres'),
    kindSupabase: document.getElementById('kindSupabase'),
    bodyMssql: document.getElementById('bodyMssql'),
    bodyMysql: document.getElementById('bodyMysql'),
    bodyPostgres: document.getElementById('bodyPostgres'),
    bodySupabase: document.getElementById('bodySupabase'),
    connectionId: document.getElementById('connectionId'),
    connName: document.getElementById('connName'),
    connList: document.getElementById('connList'),
    addConnBtn: document.getElementById('addConnBtn'),
    pinWrap: document.getElementById('pinWrap'),
    pinToWorkspace: document.getElementById('pinToWorkspace'),
    mssqlServer: document.getElementById('mssqlServer'),
    mssqlPort: document.getElementById('mssqlPort'),
    mssqlUser: document.getElementById('mssqlUser'),
    mssqlPassword: document.getElementById('mssqlPassword'),
    mssqlEncrypt: document.getElementById('mssqlEncrypt'),
    mssqlTrust: document.getElementById('mssqlTrust'),
    mssqlPickerMount: document.getElementById('mssqlPickerMount'),
    mysqlServer: document.getElementById('mysqlServer'),
    mysqlPort: document.getElementById('mysqlPort'),
    mysqlUser: document.getElementById('mysqlUser'),
    mysqlPassword: document.getElementById('mysqlPassword'),
    mysqlEncrypt: document.getElementById('mysqlEncrypt'),
    mysqlTrust: document.getElementById('mysqlTrust'),
    mysqlPickerMount: document.getElementById('mysqlPickerMount'),
    pgServer: document.getElementById('pgServer'),
    pgPort: document.getElementById('pgPort'),
    pgDatabase: document.getElementById('pgDatabase'),
    pgUser: document.getElementById('pgUser'),
    pgPassword: document.getElementById('pgPassword'),
    pgEncrypt: document.getElementById('pgEncrypt'),
    pgTrust: document.getElementById('pgTrust'),
    pgLoadDbsBtn: document.getElementById('pgLoadDbsBtn'),
    pgDbList: document.getElementById('pgDbList'),
    sbUrl: document.getElementById('sbUrl'),
    sbSummary: document.getElementById('sbSummary'),
    sbPoolerHint: document.getElementById('sbPoolerHint'),
    sbPasswordWrap: document.getElementById('sbPasswordWrap'),
    sbPassword: document.getElementById('sbPassword'),
    sbServer: document.getElementById('sbServer'),
    sbPort: document.getElementById('sbPort'),
    sbUser: document.getElementById('sbUser'),
    sbDatabase: document.getElementById('sbDatabase'),
    sbTrust: document.getElementById('sbTrust'),
    dbPicker: document.getElementById('dbPicker'),
    database: document.getElementById('database'),
    dbSearch: document.getElementById('dbSearch'),
    dbList: document.getElementById('dbList'),
    dbSummary: document.getElementById('dbSummary'),
    loadDbsBtn: document.getElementById('loadDbsBtn'),
    selectAllDbsBtn: document.getElementById('selectAllDbsBtn'),
    enabled: document.getElementById('enabled'),
    clearPassword: document.getElementById('clearPassword'),
    pwdNote: document.getElementById('pwdNote'),
    badge: document.getElementById('badge'),
    status: document.getElementById('status'),
    saveBtn: document.getElementById('saveBtn'),
    testBtn: document.getElementById('testBtn'),
    browseBtn: document.getElementById('browseBtn'),
    form: document.getElementById('form')
  };

  let availableDatabases = [];
  let selectedDatabases = [];
  let pgNames = [];
  let profiles = [];
  let selectedId = '';

  document.querySelectorAll('.pwd-wrap').forEach((wrap) => {
    const input = wrap.querySelector('input');
    const btn = wrap.querySelector('.pwd-toggle');
    const eye = wrap.querySelector('.icon-eye');
    const eyeOff = wrap.querySelector('.icon-eye-off');
    if (!input || !btn || !eye || !eyeOff) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.hidden = show;
      eyeOff.hidden = !show;
      btn.title = show ? 'Hide password' : 'Show password';
      btn.setAttribute('aria-label', btn.title);
    });
  });

  function getLoginKind() {
    if (els.kindMysql.checked) return 'mysql';
    if (els.kindPostgres.checked) return 'postgres';
    if (els.kindSupabase.checked) return 'supabase';
    return 'mssql';
  }

  function setLoginKind(kind) {
    els.kindMssql.checked = kind === 'mssql';
    els.kindMysql.checked = kind === 'mysql';
    els.kindPostgres.checked = kind === 'postgres';
    els.kindSupabase.checked = kind === 'supabase';
    applyKindUi();
  }

  function kindLabel(kind) {
    if (kind === 'mysql') return 'MySQL';
    if (kind === 'postgres') return 'PostgreSQL';
    if (kind === 'supabase') return 'Supabase';
    return 'SQL Server';
  }

  function applyKindUi() {
    const kind = getLoginKind();
    els.bodyMssql.hidden = kind !== 'mssql';
    els.bodyMysql.hidden = kind !== 'mysql';
    els.bodyPostgres.hidden = kind !== 'postgres';
    els.bodySupabase.hidden = kind !== 'supabase';
    if (kind === 'mssql') {
      els.mssqlPickerMount.appendChild(els.dbPicker);
      els.dbPicker.hidden = false;
    } else if (kind === 'mysql') {
      els.mysqlPickerMount.appendChild(els.dbPicker);
      els.dbPicker.hidden = false;
    } else {
      els.dbPicker.hidden = true;
    }
    renderDbList();
    updateSbPreview();
    updatePanelHints();
  }

  function renderConnList() {
    els.connList.innerHTML = '';
    if (profiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'db-empty';
      empty.textContent = 'No saved logins yet. Click Add, then fill the form.';
      els.connList.appendChild(empty);
      updatePanelHints();
      return;
    }
    for (const profile of profiles) {
      const row = document.createElement('div');
      row.className = 'conn-row' + (profile.id === selectedId ? ' is-selected' : '') + (profile.active ? ' is-active' : '');
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'conn-main';
      main.innerHTML = '<span class="kind-icon">' + (KIND_ICONS[profile.loginKind] || '') + '</span>';
      const meta = document.createElement('span');
      meta.className = 'conn-meta';
      const name = document.createElement('span');
      name.className = 'conn-name';
      name.textContent = profile.name;
      const host = document.createElement('span');
      host.className = 'conn-host';
      host.textContent = profile.server ? profile.server + (profile.database ? ' / ' + profile.database : '') : 'Not filled in';
      meta.appendChild(name);
      meta.appendChild(host);
      main.appendChild(meta);
      if (profile.active) {
        const pill = document.createElement('span');
        pill.className = 'conn-pill';
        pill.textContent = 'Active';
        main.appendChild(pill);
      }
      main.addEventListener('click', () => vscode.postMessage({ type: 'select', id: profile.id }));
      const actions = document.createElement('div');
      actions.className = 'conn-actions';
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'secondary';
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', () => vscode.postMessage({ type: 'rename', id: profile.id }));
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'secondary';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => vscode.postMessage({ type: 'delete', id: profile.id }));
      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      row.appendChild(main);
      row.appendChild(actions);
      els.connList.appendChild(row);
    }
    updatePanelHints();
  }

  function setHint(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text || '';
  }

  function hostHint(server, port) {
    const host = (server || '').trim();
    return host ? host + ':' + port : 'Host and port';
  }

  function updatePanelHints() {
    const kind = getLoginKind();
    setHint('connPanelHint', profiles.length === 0 ? 'None saved yet' : (profiles.length === 1 ? '1 saved' : profiles.length + ' saved'));
    setHint('typePanelHint', kindLabel(kind));
    setHint('optsPanelHint', els.enabled.checked ? 'Extension on' : 'Extension off');
    if (kind === 'mssql') {
      setHint('mssqlServerPanelHint', hostHint(els.mssqlServer.value, els.mssqlPort.value));
      setHint('mssqlDbPanelHint', els.dbSummary.textContent);
      setHint('mssqlAuthPanelHint', els.mssqlUser.value || 'Username and password');
      setHint('mssqlSecPanelHint', els.mssqlEncrypt.checked ? 'TLS on' : 'TLS off');
    } else if (kind === 'mysql') {
      setHint('mysqlServerPanelHint', hostHint(els.mysqlServer.value, els.mysqlPort.value));
      setHint('mysqlDbPanelHint', els.dbSummary.textContent);
      setHint('mysqlAuthPanelHint', els.mysqlUser.value || 'Username and password');
      setHint('mysqlSecPanelHint', els.mysqlEncrypt.checked ? 'TLS on' : 'TLS off');
    } else if (kind === 'postgres') {
      setHint('pgServerPanelHint', hostHint(els.pgServer.value, els.pgPort.value));
      setHint('pgDbPanelHint', els.pgDatabase.value.trim() || 'One database per connection');
      setHint('pgAuthPanelHint', els.pgUser.value || 'Username and password');
      setHint('pgSecPanelHint', els.pgEncrypt.checked ? 'TLS on' : 'TLS off');
    } else {
      setHint('sbUrlPanelHint', els.sbServer.value || 'Paste the dashboard URL');
      setHint('sbAuthPanelHint', els.sbPasswordWrap.hidden ? 'Password is in the URL' : 'Database password');
    }
  }

  function setBusy(busy) {
    els.saveBtn.disabled = busy;
    els.testBtn.disabled = busy;
    els.loadDbsBtn.disabled = busy;
    els.selectAllDbsBtn.disabled = busy;
    els.pgLoadDbsBtn.disabled = busy;
    els.addConnBtn.disabled = busy;
    els.dbSearch.disabled = busy;
  }

  function showStatus(message, kind) {
    els.status.textContent = message;
    els.status.className = 'status show ' + kind;
  }

  function selectedSet() {
    return new Set(selectedDatabases.map((name) => name.toLowerCase()));
  }

  function defaultDatabaseName() {
    return (els.database.value || '').trim();
  }

  function sameName(left, right) {
    return left.toLowerCase() === right.toLowerCase();
  }

  function addUnique(list, name) {
    if (!name || list.some((item) => sameName(item, name))) return;
    list.push(name);
  }

  function allDbNames() {
    const names = [];
    for (const name of availableDatabases) addUnique(names, name);
    for (const name of selectedDatabases) addUnique(names, name);
    addUnique(names, defaultDatabaseName());
    return names;
  }

  function setDefaultDatabase(name) {
    const trimmed = (name || '').trim();
    els.database.value = trimmed;
    if (trimmed) {
      const rest = selectedDatabases.filter((item) => !sameName(item, trimmed));
      selectedDatabases = [trimmed, ...rest];
    }
    renderDbList();
  }

  function filteredDbNames() {
    const filter = (els.dbSearch.value || '').trim().toLowerCase();
    const names = allDbNames();
    return filter ? names.filter((name) => name.toLowerCase().includes(filter)) : names;
  }

  function renderDbList() {
    const chosen = selectedSet();
    const defaultDb = defaultDatabaseName();
    if (defaultDb) chosen.add(defaultDb.toLowerCase());
    const filter = (els.dbSearch.value || '').trim();
    const visible = filteredDbNames();
    const exact = filter && allDbNames().some((name) => sameName(name, filter));
    els.dbList.innerHTML = '';
    if (allDbNames().length === 0 && !filter) {
      const empty = document.createElement('div');
      empty.className = 'db-empty';
      empty.textContent = 'Type a database name, or load the list from the server.';
      els.dbList.appendChild(empty);
      updateDbSummary();
      return;
    }
    for (const name of visible) {
      els.dbList.appendChild(renderMultiRow(name, defaultDb, chosen));
    }
    if (filter && !exact) {
      els.dbList.appendChild(renderCustomRow(filter));
    }
    if (els.dbList.childNodes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'db-empty';
      empty.textContent = 'No databases match that search.';
      els.dbList.appendChild(empty);
    }
    updateDbSummary();
  }

  function renderMultiRow(name, defaultDb, chosen) {
    const isDefault = Boolean(defaultDb && sameName(name, defaultDb));
    const isSelected = chosen.has(name.toLowerCase());
    const row = document.createElement('div');
    row.className = 'db-row' + (isDefault ? ' is-default' : '') + (isSelected ? ' is-selected' : '');
    row.setAttribute('role', 'option');
    const label = document.createElement('label');
    label.className = 'db-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = name;
    input.checked = isSelected;
    input.disabled = isDefault;
    input.addEventListener('change', () => {
      syncSelectedFromCheckboxes();
      row.classList.toggle('is-selected', input.checked);
      updateDbSummary();
    });
    const span = document.createElement('span');
    span.className = 'db-name';
    span.textContent = name;
    label.appendChild(input);
    label.appendChild(span);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'db-default-btn';
    btn.textContent = 'Default';
    btn.setAttribute('aria-pressed', isDefault ? 'true' : 'false');
    btn.title = isDefault ? 'This is the default database' : 'Use as default';
    btn.addEventListener('click', () => setDefaultDatabase(name));
    row.appendChild(label);
    row.appendChild(btn);
    return row;
  }

  function renderCustomRow(name) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'db-row db-custom db-pick';
    const span = document.createElement('span');
    span.className = 'db-name';
    span.textContent = 'Use “' + name + '” as default';
    btn.appendChild(span);
    btn.addEventListener('click', () => applyTypedDatabase(name));
    return btn;
  }

  function applyTypedDatabase(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    addUnique(availableDatabases, trimmed);
    setDefaultDatabase(trimmed);
    els.dbSearch.value = '';
    renderDbList();
  }

  function updateDbSummary() {
    const defaultDb = defaultDatabaseName();
    const names = selectedSet();
    if (defaultDb) names.add(defaultDb.toLowerCase());
    const count = names.size;
    if (!defaultDb) {
      els.dbSummary.textContent = count > 0 ? count + ' selected · pick a default' : 'No database selected';
      return;
    }
    els.dbSummary.textContent = count <= 1
      ? defaultDb + ' is the default'
      : count + ' selected · ' + defaultDb + ' is the default';
    updatePanelHints();
  }

  function syncSelectedFromCheckboxes() {
    const boxes = els.dbList.querySelectorAll('input[type="checkbox"]');
    const hiddenSelected = [];
    const visibleKeys = new Set();
    boxes.forEach((box) => visibleKeys.add(box.value.toLowerCase()));
    for (const name of selectedDatabases) {
      if (!visibleKeys.has(name.toLowerCase())) hiddenSelected.push(name);
    }
    selectedDatabases = hiddenSelected.slice();
    boxes.forEach((box) => {
      if (box.checked) addUnique(selectedDatabases, box.value);
    });
    const defaultDb = defaultDatabaseName();
    if (defaultDb && !selectedDatabases.some((name) => sameName(name, defaultDb))) {
      selectedDatabases.unshift(defaultDb);
    }
  }

  function previewPostgresUrl(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('mysql://') || lower.startsWith('mysql+')) {
      return { error: 'This is a MySQL URL. Choose MySQL.' };
    }
    let rest;
    if (lower.startsWith('postgresql://')) rest = trimmed.slice(13);
    else if (lower.startsWith('postgres://')) rest = trimmed.slice(11);
    else return { error: 'Use a postgres:// or postgresql:// URL from the Supabase dashboard.' };
    try {
      const parsed = new URL('http://' + rest);
      const host = decodeURIComponent(parsed.hostname);
      if (!host) return { error: 'The URL has no host.' };
      if (!host.toLowerCase().includes('supabase.')) {
        return { error: 'That host is not Supabase. Choose PostgreSQL.' };
      }
      return {
        host,
        port: parsed.port ? Number(parsed.port) : 5432,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: decodeURIComponent(parsed.pathname.replace(/^[/]/, '')).split('/')[0] || '',
        sslMode: (parsed.searchParams.get('sslmode') || '').toLowerCase()
      };
    } catch {
      return { error: 'That URL could not be read. Check it and paste again.' };
    }
  }

  function updateSbPreview() {
    if (getLoginKind() !== 'supabase') return;
    const parsed = previewPostgresUrl(els.sbUrl.value);
    if (parsed && parsed.error) {
      els.sbSummary.hidden = false;
      els.sbSummary.textContent = parsed.error;
      els.sbPoolerHint.hidden = true;
      els.sbPasswordWrap.hidden = false;
      return;
    }
    if (parsed) {
      els.sbServer.value = parsed.host;
      els.sbPort.value = String(parsed.port);
      els.sbUser.value = parsed.user;
      els.sbDatabase.value = parsed.database;
      els.sbTrust.value = parsed.sslMode === 'verify-full' || parsed.sslMode === 'verify-ca' ? '0' : '1';
      els.sbSummary.hidden = false;
      els.sbSummary.innerHTML = '<code>' + parsed.user + '@' + parsed.host + ':' + parsed.port + '/' + (parsed.database || 'postgres') + '</code>';
      els.sbPoolerHint.hidden = !(parsed.host.toLowerCase().startsWith('db.') && parsed.host.toLowerCase().includes('supabase.'));
      els.sbPasswordWrap.hidden = Boolean(parsed.password);
      return;
    }
    if (els.sbServer.value) {
      els.sbSummary.hidden = false;
      els.sbSummary.innerHTML = '<code>' + (els.sbUser.value || 'user') + '@' + els.sbServer.value + ':' + (els.sbPort.value || '5432') + '/' + (els.sbDatabase.value || 'postgres') + '</code>';
      els.sbPoolerHint.hidden = !(els.sbServer.value.toLowerCase().startsWith('db.') && els.sbServer.value.toLowerCase().includes('supabase.'));
      els.sbPasswordWrap.hidden = false;
      return;
    }
    els.sbSummary.hidden = true;
    els.sbPoolerHint.hidden = true;
    els.sbPasswordWrap.hidden = false;
  }

  function renderPgList(names) {
    pgNames = names.slice();
    els.pgDbList.innerHTML = '';
    if (pgNames.length === 0) {
      els.pgDbList.hidden = true;
      return;
    }
    els.pgDbList.hidden = false;
    for (const name of pgNames) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'db-row db-pick' + (sameName(name, els.pgDatabase.value) ? ' is-default' : '');
      btn.textContent = name;
      btn.addEventListener('click', () => {
        els.pgDatabase.value = name;
        renderPgList(pgNames);
      });
      els.pgDbList.appendChild(btn);
    }
  }

  function readForm() {
    const kind = getLoginKind();
    const shared = {
      connectionId: els.connectionId.value,
      name: els.connName.value,
      pinToWorkspace: els.pinToWorkspace.checked,
      loginKind: kind,
      enabled: els.enabled.checked,
      clearPassword: els.clearPassword.checked,
      connectionUrl: ''
    };
    if (kind === 'supabase') {
      return {
        ...shared,
        connectionUrl: els.sbUrl.value,
        server: els.sbServer.value,
        database: els.sbDatabase.value,
        databases: els.sbDatabase.value.trim() ? [els.sbDatabase.value.trim()] : [],
        user: els.sbUser.value,
        password: els.sbPassword.value,
        port: Number(els.sbPort.value) || 5432,
        encrypt: true,
        trustServerCertificate: els.sbTrust.value !== '0'
      };
    }
    if (kind === 'postgres') {
      const database = els.pgDatabase.value.trim();
      return {
        ...shared,
        server: els.pgServer.value,
        database,
        databases: database ? [database] : [],
        user: els.pgUser.value,
        password: els.pgPassword.value,
        port: Number(els.pgPort.value) || 5432,
        encrypt: els.pgEncrypt.checked,
        trustServerCertificate: els.pgTrust.checked
      };
    }
    const typed = (els.dbSearch.value || '').trim();
    if (!defaultDatabaseName() && typed) applyTypedDatabase(typed);
    syncSelectedFromCheckboxes();
    const database = els.database.value;
    let databases = selectedDatabases.slice();
    if (database.trim() && !databases.some((name) => name.toLowerCase() === database.trim().toLowerCase())) {
      databases = [database.trim(), ...databases];
    }
    if (kind === 'mysql') {
      return {
        ...shared,
        server: els.mysqlServer.value,
        database,
        databases,
        user: els.mysqlUser.value,
        password: els.mysqlPassword.value,
        port: Number(els.mysqlPort.value) || 3306,
        encrypt: els.mysqlEncrypt.checked,
        trustServerCertificate: els.mysqlTrust.checked
      };
    }
    return {
      ...shared,
      server: els.mssqlServer.value,
      database,
      databases,
      user: els.mssqlUser.value,
      password: els.mssqlPassword.value,
      port: Number(els.mssqlPort.value) || 1433,
      encrypt: els.mssqlEncrypt.checked,
      trustServerCertificate: els.mssqlTrust.checked
    };
  }

  function clearKindFields() {
    els.mssqlServer.value = '';
    els.mssqlPort.value = '1433';
    els.mssqlUser.value = '';
    els.mssqlPassword.value = '';
    els.mssqlEncrypt.checked = true;
    els.mssqlTrust.checked = false;
    els.mysqlServer.value = '';
    els.mysqlPort.value = '3306';
    els.mysqlUser.value = '';
    els.mysqlPassword.value = '';
    els.mysqlEncrypt.checked = true;
    els.mysqlTrust.checked = false;
    els.pgServer.value = '';
    els.pgPort.value = '5432';
    els.pgDatabase.value = '';
    els.pgUser.value = '';
    els.pgPassword.value = '';
    els.pgEncrypt.checked = true;
    els.pgTrust.checked = false;
    els.sbUrl.value = '';
    els.sbServer.value = '';
    els.sbPort.value = '5432';
    els.sbUser.value = '';
    els.sbDatabase.value = '';
    els.sbPassword.value = '';
    els.sbTrust.value = '1';
    els.sbSummary.hidden = true;
    els.sbPoolerHint.hidden = true;
    els.sbPasswordWrap.hidden = false;
  }

  function fillKindFields(c) {
    const kind = c.loginKind === 'mysql' || c.loginKind === 'postgres' || c.loginKind === 'supabase'
      ? c.loginKind
      : 'mssql';
    if (kind === 'mssql') {
      els.mssqlServer.value = c.server || '';
      els.mssqlPort.value = String(c.port || 1433);
      els.mssqlUser.value = c.user || '';
      els.mssqlPassword.value = c.password || '';
      els.mssqlEncrypt.checked = c.encrypt !== false;
      els.mssqlTrust.checked = !!c.trustServerCertificate;
    } else if (kind === 'mysql') {
      els.mysqlServer.value = c.server || '';
      els.mysqlPort.value = String(c.port || 3306);
      els.mysqlUser.value = c.user || '';
      els.mysqlPassword.value = c.password || '';
      els.mysqlEncrypt.checked = c.encrypt !== false;
      els.mysqlTrust.checked = !!c.trustServerCertificate;
    } else if (kind === 'postgres') {
      els.pgServer.value = c.server || '';
      els.pgPort.value = String(c.port || 5432);
      els.pgDatabase.value = c.database || '';
      els.pgUser.value = c.user || '';
      els.pgPassword.value = c.password || '';
      els.pgEncrypt.checked = c.encrypt !== false;
      els.pgTrust.checked = !!c.trustServerCertificate;
    } else {
      els.sbUrl.value = '';
      els.sbServer.value = c.server || '';
      els.sbPort.value = String(c.port || 5432);
      els.sbUser.value = c.user || '';
      els.sbDatabase.value = c.database || '';
      els.sbPassword.value = c.password || '';
      els.sbTrust.value = c.trustServerCertificate === false ? '0' : '1';
    }
  }

  function stateLabel(msg) {
    const map = {
      connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected',
      unconfigured: 'Not configured', disabled: 'Disabled', error: 'Error'
    };
    return map[msg] || msg;
  }

  function userChangedKind() {
    availableDatabases = [];
    selectedDatabases = [];
    els.dbSearch.value = '';
    els.database.value = '';
    pgNames = [];
    els.pgDbList.hidden = true;
    applyKindUi();
  }

  function requireReady(data) {
    if (data.loginKind === 'supabase') {
      if (!data.connectionUrl.trim() && !data.server.trim()) {
        showStatus('Paste a Supabase connection URL.', 'err');
        return false;
      }
      return true;
    }
    if (!data.server.trim() || !data.database.trim()) {
      showStatus('Server and database are required.', 'err');
      return false;
    }
    return true;
  }

  els.kindMssql.addEventListener('change', userChangedKind);
  els.kindMysql.addEventListener('change', userChangedKind);
  els.kindPostgres.addEventListener('change', userChangedKind);
  els.kindSupabase.addEventListener('change', userChangedKind);
  els.form.addEventListener('input', updatePanelHints);
  els.form.addEventListener('change', updatePanelHints);
  els.addConnBtn.addEventListener('click', () => vscode.postMessage({ type: 'add' }));
  els.sbUrl.addEventListener('input', updateSbPreview);
  els.dbSearch.addEventListener('input', renderDbList);
  els.dbSearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const query = (els.dbSearch.value || '').trim();
    if (!query) return;
    const names = allDbNames();
    const exact = names.find((name) => sameName(name, query));
    const partial = names.find((name) => name.toLowerCase().includes(query.toLowerCase()));
    applyTypedDatabase(exact || partial || query);
  });
  els.loadDbsBtn.addEventListener('click', () => {
    const data = readForm();
    if (!data.server.trim()) {
      showStatus('Server is required to load the list.', 'err');
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: 'listDatabases', ...data });
  });
  els.pgLoadDbsBtn.addEventListener('click', () => {
    const data = readForm();
    if (!data.server.trim()) {
      showStatus('Server is required to load the list.', 'err');
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: 'listDatabases', ...data });
  });
  els.selectAllDbsBtn.addEventListener('click', () => {
    const boxes = els.dbList.querySelectorAll('input[type="checkbox"]');
    boxes.forEach((box) => {
      box.checked = true;
      box.disabled = box.value && defaultDatabaseName() && sameName(box.value, defaultDatabaseName());
    });
    syncSelectedFromCheckboxes();
    renderDbList();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      const c = msg.config;
      const kind = c.loginKind === 'mysql' || c.loginKind === 'postgres' || c.loginKind === 'supabase'
        ? c.loginKind
        : 'mssql';
      profiles = Array.isArray(msg.profiles) ? msg.profiles : [];
      const nextId = msg.selectedId || c.connectionId || '';
      if (nextId !== selectedId) {
        availableDatabases = [];
        pgNames = [];
        els.dbSearch.value = '';
        els.pgDbList.innerHTML = '';
        els.pgDbList.hidden = true;
        els.status.className = 'status';
        els.status.textContent = '';
      }
      selectedId = nextId;
      els.connectionId.value = selectedId;
      els.connName.value = c.name || '';
      els.pinWrap.hidden = !msg.canPinWorkspace;
      els.pinToWorkspace.checked = !!msg.pinToWorkspace;
      setLoginKind(kind);
      clearKindFields();
      fillKindFields(c);
      els.database.value = c.database || '';
      selectedDatabases = Array.isArray(c.databases) && c.databases.length
        ? c.databases.slice()
        : (c.database ? [c.database] : []);
      if (availableDatabases.length === 0) availableDatabases = selectedDatabases.slice();
      else for (const name of selectedDatabases) addUnique(availableDatabases, name);
      els.enabled.checked = c.enabled !== false;
      els.clearPassword.checked = false;
      els.pwdNote.textContent = c.hasStoredPassword
        ? 'Saved in the OS keychain for this login. Use the eye icon to show or hide it.'
        : 'Will be saved in the OS keychain for this login.';
      renderConnList();
      applyKindUi();
      const typePanel = document.getElementById('typePanel');
      if (typePanel) typePanel.open = !c.server;
      let badge = (c.name || kindLabel(kind)) + ' · ' + stateLabel(msg.state);
      if (selectedDatabases.length > 1) badge += ' · ' + selectedDatabases.length + ' DBs';
      if (msg.tableCount > 0) {
        badge += ' · ' + msg.tableCount + ' tables' + (msg.stale ? ' (cached)' : '');
        els.browseBtn.hidden = false;
      } else {
        els.browseBtn.hidden = true;
      }
      if (msg.state === 'error' && msg.lastError) badge += ' — ' + msg.lastError;
      els.badge.textContent = badge;
      setBusy(false);
    } else if (msg.type === 'status') {
      setBusy(!!msg.busy);
      showStatus(msg.message, msg.busy ? 'busy' : (msg.ok ? 'ok' : 'err'));
    } else if (msg.type === 'saved') {
      setBusy(false);
      showStatus(msg.message, msg.ok ? 'ok' : 'err');
    } else if (msg.type === 'databases') {
      setBusy(false);
      if (msg.ok) {
        if (getLoginKind() === 'postgres') {
          renderPgList(msg.databases);
          if (!els.pgDatabase.value.trim() && msg.databases.length === 1) {
            els.pgDatabase.value = msg.databases[0];
            renderPgList(msg.databases);
          }
        } else {
          availableDatabases = msg.databases.slice();
          const defaultDb = defaultDatabaseName();
          if (!defaultDb && availableDatabases.length === 1) setDefaultDatabase(availableDatabases[0]);
          else renderDbList();
        }
      }
      showStatus(msg.message, msg.ok ? 'ok' : 'err');
    }
  });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = readForm();
    if (!requireReady(data)) return;
    setBusy(true);
    vscode.postMessage({ type: 'save', ...data });
  });
  els.testBtn.addEventListener('click', () => {
    const data = readForm();
    if (!requireReady(data)) return;
    setBusy(true);
    vscode.postMessage({ type: 'test', ...data });
  });
  els.browseBtn.addEventListener('click', () => vscode.postMessage({ type: 'browseSchema' }));
  applyKindUi();
  vscode.postMessage({ type: 'ready' });`;
}
