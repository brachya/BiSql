import * as vscode from 'vscode';
import {
    DbEngine,
    ExtensionConfig,
    SettingsScope,
    SqlServerService,
    parseEngine,
    selectedDatabases
} from '../db/connection';
import { DiagnosticsManager } from '../providers/diagnostics';
import { tabIcon } from './media';
import { SchemaExplorer } from './schemaExplorer';

type FormPayload = {
    engine: DbEngine;
    server: string;
    database: string;
    databases: string[];
    user: string;
    password: string;
    port: number;
    encrypt: boolean;
    trustServerCertificate: boolean;
    enabled: boolean;
    clearPassword: boolean;
    settingsScope: SettingsScope;
};

type WebviewToExt =
    | { type: 'ready' }
    | ({ type: 'save' } & FormPayload)
    | ({ type: 'test' } & Omit<FormPayload, 'enabled' | 'clearPassword'>)
    | { type: 'loadScope'; scope: SettingsScope }
    | ({ type: 'listDatabases' } & Omit<FormPayload, 'enabled' | 'clearPassword'>)
    | { type: 'browseSchema' };

type ExtToWebview =
    | {
          type: 'init';
          config: {
              engine: DbEngine;
              server: string;
              database: string;
              databases: string[];
              user: string;
              port: number;
              encrypt: boolean;
              trustServerCertificate: boolean;
              enabled: boolean;
              hasStoredPassword: boolean;
              password: string;
              settingsScope: SettingsScope;
              canUseWorkspace: boolean;
          };
          state: string;
          lastError?: string;
          tableCount: number;
          stale: boolean;
      }
    | { type: 'status'; message: string; ok: boolean; busy?: boolean }
    | { type: 'saved'; ok: boolean; message: string }
    | { type: 'databases'; ok: boolean; databases: string[]; message: string };

/**
 * Login / connection form shown as an editor tab. Writes settings through the
 * VS Code Configuration API and stores the password in SecretStorage — never
 * asks the user to edit JSON by hand.
 */
export class ConnectionPanel {
    public static readonly viewType = 'bisql.connectionPanel';

    private static current: ConnectionPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    public static show(
        _context: vscode.ExtensionContext | undefined,
        db: SqlServerService,
        diagnostics: DiagnosticsManager
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (ConnectionPanel.current) {
            ConnectionPanel.current.panel.reveal(column);
            void ConnectionPanel.current.postInit();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ConnectionPanel.viewType,
            'Database Login',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );

        ConnectionPanel.current = new ConnectionPanel(panel, db, diagnostics);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly db: SqlServerService,
        private readonly diagnostics: DiagnosticsManager
    ) {
        this.panel = panel;
        this.panel.iconPath = tabIcon('bisql-logo-light.svg', 'bisql-logo-dark.svg');
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
            this.db.onDidChangeState(() => {
                void this.postInit();
            }),
            this.db.onDidChangeSchema(() => {
                void this.postInit();
            })
        );
    }

    private async onMessage(message: WebviewToExt): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.postInit();
                return;
            case 'save':
                await this.handleSave(message);
                return;
            case 'test':
                await this.handleTest(message);
                return;
            case 'loadScope':
                await this.postInitForScope(message.scope);
                return;
            case 'listDatabases':
                await this.handleListDatabases(message);
                return;
            case 'browseSchema':
                SchemaExplorer.show(this.db, () => {
                    ConnectionPanel.show(undefined, this.db, this.diagnostics);
                });
                return;
        }
    }

    private async postInit(): Promise<void> {
        await this.postInitForScope(this.db.getSettingsScope());
    }

    private async postInitForScope(scope: SettingsScope): Promise<void> {
        const effectiveScope =
            scope === 'workspace' && this.db.hasWorkspaceFolder() ? 'workspace' : 'global';
        const config = this.db.getConfigForScope(effectiveScope);
        const password = (await this.db.getPassword(effectiveScope)) ?? '';
        const payload: ExtToWebview = {
            type: 'init',
            config: {
                engine: config.engine,
                server: config.server,
                database: config.database,
                databases: selectedDatabases(config),
                user: config.user,
                port: config.port,
                encrypt: config.encrypt,
                trustServerCertificate: config.trustServerCertificate,
                enabled: config.enabled,
                hasStoredPassword: password.length > 0,
                password,
                settingsScope: effectiveScope,
                canUseWorkspace: this.db.hasWorkspaceFolder()
            },
            state: this.db.connectionState,
            lastError: this.db.lastErrorMessage,
            tableCount: this.db.schema.tables.length,
            stale: this.db.schema.stale
        };
        await this.panel.webview.postMessage(payload);
    }

    private async handleSave(message: Extract<WebviewToExt, { type: 'save' }>): Promise<void> {
        await this.postStatus('Saving…', true, true);
        try {
            const scope: SettingsScope =
                message.settingsScope === 'workspace' && this.db.hasWorkspaceFolder()
                    ? 'workspace'
                    : 'global';

            const databases = normalizeFormDatabases(message.database, message.databases);
            await this.db.saveConnectionSettings(
                {
                    engine: parseEngine(message.engine),
                    server: message.server.trim(),
                    database: message.database.trim() || databases[0] || '',
                    databases,
                    user: message.user.trim(),
                    port: message.port,
                    encrypt: message.encrypt,
                    trustServerCertificate: message.trustServerCertificate,
                    enabled: message.enabled
                },
                scope
            );

            if (message.clearPassword) {
                await this.db.clearPassword(scope);
            } else {
                await this.db.setPassword(message.password, scope);
            }

            await this.db.reconfigure();
            await this.diagnostics.revalidateOpenDocuments(true);

            const connected = this.db.connectionState === 'connected';
            const tables = this.db.schema.tables.length;
            const where =
                scope === 'workspace' ? 'Saved for this project only.' : 'Saved for all projects (shared).';
            const dbLabel = databases.length > 1 ? `${databases.length} databases` : databases[0] || 'database';
            const msg = connected
                ? `${where} Connected — ${tables} tables/views from ${dbLabel}.`
                : this.db.lastErrorMessage
                  ? `${where} Connection failed: ${this.db.lastErrorMessage}`
                  : `${where} Fill in server and database, then Test Connection.`;

            await this.panel.webview.postMessage({
                type: 'saved',
                ok: connected || (!message.server.trim() && !message.database.trim()),
                message: msg
            } satisfies ExtToWebview);
            await this.postInit();
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            await this.panel.webview.postMessage({
                type: 'saved',
                ok: false,
                message: `Save failed: ${text}`
            } satisfies ExtToWebview);
        }
    }

    private async handleTest(message: Extract<WebviewToExt, { type: 'test' }>): Promise<void> {
        await this.postStatus('Testing connection…', true, true);
        try {
            const scope: SettingsScope =
                message.settingsScope === 'workspace' && this.db.hasWorkspaceFolder()
                    ? 'workspace'
                    : 'global';

            const databases = normalizeFormDatabases(message.database, message.databases);
            await this.db.saveConnectionSettings(
                {
                    engine: parseEngine(message.engine),
                    server: message.server.trim(),
                    database: message.database.trim() || databases[0] || '',
                    databases,
                    user: message.user.trim(),
                    port: message.port,
                    encrypt: message.encrypt,
                    trustServerCertificate: message.trustServerCertificate,
                    enabled: true
                },
                scope
            );
            if (message.password.length > 0) {
                await this.db.setPassword(message.password, scope);
            }

            const result = await this.db.testConnection();
            if (result.ok) {
                await this.db.refreshSchema();
                await this.diagnostics.revalidateOpenDocuments(false);
                await this.postStatus(`Connected: ${result.message}`, true, false);
            } else {
                const hint = hintFromMessage(result.message, parseEngine(message.engine));
                await this.postStatus(
                    hint ? `Failed: ${result.message}\n\n${hint}` : `Failed: ${result.message}`,
                    false,
                    false
                );
            }
            await this.postInit();
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            await this.postStatus(`Failed: ${text}`, false, false);
        }
    }

    private async handleListDatabases(
        message: Extract<WebviewToExt, { type: 'listDatabases' }>
    ): Promise<void> {
        await this.postStatus('Loading databases…', true, true);
        try {
            const scope: SettingsScope =
                message.settingsScope === 'workspace' && this.db.hasWorkspaceFolder()
                    ? 'workspace'
                    : 'global';
            const databases = normalizeFormDatabases(message.database, message.databases);
            await this.db.saveConnectionSettings(
                {
                    engine: parseEngine(message.engine),
                    server: message.server.trim(),
                    database: message.database.trim() || databases[0] || '',
                    databases,
                    user: message.user.trim(),
                    port: message.port,
                    encrypt: message.encrypt,
                    trustServerCertificate: message.trustServerCertificate,
                    enabled: true
                },
                scope
            );
            if (message.password.length > 0) {
                await this.db.setPassword(message.password, scope);
            }
            const result = await this.db.listDatabases();
            await this.panel.webview.postMessage({
                type: 'databases',
                ok: result.ok,
                databases: result.databases,
                message: result.message
            } satisfies ExtToWebview);
            await this.postStatus(
                result.ok
                    ? `Loaded ${result.databases.length} databases. Select which ones to use.`
                    : `Failed: ${result.message}`,
                result.ok,
                false
            );
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            await this.postStatus(`Failed: ${text}`, false, false);
        }
    }

    private async postStatus(message: string, ok: boolean, busy = false): Promise<void> {
        await this.panel.webview.postMessage({
            type: 'status',
            message,
            ok,
            busy
        } satisfies ExtToWebview);
    }

    private dispose(): void {
        ConnectionPanel.current = undefined;
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
<title>Database Login</title>
<style nonce="${nonce}">
  :root { --gap: 14px; --radius: 8px; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 24px 48px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  .wrap { max-width: 520px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 1.45rem; font-weight: 600; letter-spacing: -0.02em; }
  .sub { margin: 0 0 22px; opacity: 0.75; line-height: 1.45; }
  .card {
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-radius: var(--radius); padding: 20px;
  }
  .grid { display: grid; gap: var(--gap); }
  .row-2 { display: grid; grid-template-columns: 1fr 120px; gap: var(--gap); }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; opacity: 0.92; }
  label span.hint { font-size: 0.75rem; opacity: 0.65; font-weight: 400; }
  input[type="text"], input[type="password"], input[type="number"], select {
    width: 100%; padding: 8px 10px; border-radius: 4px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    font: inherit; outline: none;
  }
  input:focus, select:focus { border-color: var(--vscode-focusBorder); }
  .checks { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
  .check { display: flex; align-items: flex-start; gap: 8px; font-size: 0.9rem; cursor: pointer; }
  .check input { margin-top: 3px; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
  button {
    font: inherit; padding: 8px 16px; border-radius: 4px; border: 1px solid transparent; cursor: pointer;
  }
  button:disabled { opacity: 0.55; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .status {
    margin-top: 16px; padding: 10px 12px; border-radius: 4px; line-height: 1.4;
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
    display: inline-flex; align-items: center; gap: 6px; margin-bottom: 16px;
    padding: 4px 10px; border-radius: 999px; font-size: 0.78rem;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .pwd-note { font-size: 0.78rem; opacity: 0.7; margin-top: -4px; }
  .pwd-wrap {
    position: relative;
    display: flex;
    align-items: stretch;
  }
  .pwd-wrap input {
    padding-right: 42px;
  }
  .pwd-toggle {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    width: 34px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    opacity: 0.7;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .pwd-toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, transparent); }
  .pwd-toggle svg { width: 16px; height: 16px; fill: currentColor; }
  .engine-label { font-size: 0.85rem; margin-bottom: 2px; }
  .engine-hint { font-size: 0.75rem; opacity: 0.65; margin: 0 0 8px; }
  .engine-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .engine-grid.three {
    grid-template-columns: 1fr 1fr 1fr;
  }
  .engine-option {
    position: relative;
    display: block;
    cursor: pointer;
  }
  .engine-option input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .engine-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 12px 14px;
    border-radius: 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
    min-height: 72px;
  }
  .engine-option input:focus-visible + .engine-card {
    outline: 1px solid var(--vscode-focusBorder);
  }
  .engine-option input:checked + .engine-card {
    border-color: var(--vscode-focusBorder);
    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
  }
  .engine-card strong { font-size: 0.92rem; }
  .engine-card span { font-size: 0.75rem; opacity: 0.7; line-height: 1.35; }
  .db-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
  .db-list {
    margin-top: 10px; max-height: 180px; overflow: auto;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 8px 10px;
    background: var(--vscode-input-background);
  }
  .db-list:empty::before {
    content: 'Click “Load databases” to pick more than one.';
    opacity: 0.55; font-size: 0.8rem;
  }
  .db-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 0.88rem; cursor: pointer; }
  button.db-item {
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    width: 100%;
    text-align: left;
    border-radius: 4px;
    padding: 6px 8px;
  }
  button.db-item[aria-pressed="true"] {
    border-color: var(--vscode-focusBorder);
    font-weight: 600;
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Database Login</h1>
    <p class="sub">Pick SQL Server, MySQL, or PostgreSQL. Save as shared for all projects, or only for this project.</p>
    <div class="badge" id="badge">Checking…</div>

    <form class="card" id="form" autocomplete="off">
      <div class="grid">
        <div>
          <div class="engine-label">Which database?</div>
          <p class="engine-hint">Pick one engine for this connection.</p>
          <div class="engine-grid three" role="radiogroup" aria-label="Database engine">
            <label class="engine-option">
              <input type="radio" name="engine" id="engineMssql" value="mssql" checked />
              <div class="engine-card">
                <strong>SQL Server</strong>
                <span>Microsoft SQL Server · port 1433</span>
              </div>
            </label>
            <label class="engine-option">
              <input type="radio" name="engine" id="engineMysql" value="mysql" />
              <div class="engine-card">
                <strong>MySQL</strong>
                <span>MySQL / MariaDB · port 3306</span>
              </div>
            </label>
            <label class="engine-option">
              <input type="radio" name="engine" id="enginePostgres" value="postgres" />
              <div class="engine-card">
                <strong>PostgreSQL</strong>
                <span>PostgreSQL · port 5432</span>
              </div>
            </label>
          </div>
        </div>

        <div id="scopeBlock">
          <div class="engine-label">Save where?</div>
          <p class="engine-hint">Shared is the default — every project can use it. Or choose this project only.</p>
          <div class="engine-grid" role="radiogroup" aria-label="Settings scope">
            <label class="engine-option">
              <input type="radio" name="settingsScope" id="scopeGlobal" value="global" checked />
              <div class="engine-card">
                <strong>All projects</strong>
                <span>Shared settings and password</span>
              </div>
            </label>
            <label class="engine-option">
              <input type="radio" name="settingsScope" id="scopeWorkspace" value="workspace" />
              <div class="engine-card">
                <strong>This project</strong>
                <span>Override only for this folder</span>
              </div>
            </label>
          </div>
        </div>

        <div class="row-2">
          <label>
            Server
            <input id="server" type="text" placeholder="localhost" required />
          </label>
          <label>
            Port
            <input id="port" type="number" min="1" max="65535" value="1433" />
          </label>
        </div>

        <label>
          Default database
          <input id="database" type="text" placeholder="YourDatabase" required />
          <span class="hint" id="databaseHint">Used for the live connection, dry-run, and when the same table name exists in more than one database.</span>
        </label>

        <div id="extraDbBlock">
          <div class="engine-label" id="extraDbLabel">Also load schema from</div>
          <p class="engine-hint" id="extraDbHint">Select every database you want IntelliSense to know. Same table name in two DBs → the default database wins.</p>
          <div class="db-toolbar">
            <button type="button" class="secondary" id="loadDbsBtn">Load databases</button>
            <button type="button" class="secondary" id="selectAllDbsBtn">Select all</button>
          </div>
          <div class="db-list" id="dbList" role="group" aria-label="Databases"></div>
        </div>

        <label>
          Username
          <input id="user" type="text" placeholder="readonly_user" autocomplete="username" />
        </label>

        <label>
          Password
          <div class="pwd-wrap">
            <input id="password" type="password" placeholder="••••••••" autocomplete="current-password" />
            <button type="button" class="pwd-toggle" id="pwdToggle" title="Show password" aria-label="Show password">
              <svg id="iconEye" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>
                <circle cx="12" cy="12" r="2.2"/>
              </svg>
              <svg id="iconEyeOff" viewBox="0 0 24 24" aria-hidden="true" style="display:none">
                <path d="M2 4.3 3.3 3l18 18-1.3 1.3-3.2-3.2A12.6 12.6 0 0 1 12 19c-7 0-10-7-10-7a21.4 21.4 0 0 1 5.1-5.4L2 4.3zm7.1 7.1A3.9 3.9 0 0 0 12 16a4 4 0 0 0 4-4 3.9 3.9 0 0 0-.6-2.1l-6.3 6.5zM12 5c7 0 10 7 10 7a21 21 0 0 1-3.7 4.3l-1.5-1.5A12.5 12.5 0 0 0 20.5 12S17.7 7 12 7c-.7 0-1.3.1-1.9.2L8.6 5.7C9.7 5.3 10.8 5 12 5z"/>
              </svg>
            </button>
          </div>
        </label>
        <p class="pwd-note" id="pwdNote">Saved in the OS keychain and filled in again when you reopen this page.</p>

        <div class="checks">
          <label class="check">
            <input id="enabled" type="checkbox" checked />
            <span>Enable the extension</span>
          </label>
          <label class="check">
            <input id="encrypt" type="checkbox" checked />
            <span>Encrypt connection <span class="hint">(TLS / SSL)</span></span>
          </label>
          <label class="check">
            <input id="trust" type="checkbox" />
            <span>Trust server certificate <span class="hint">(local / self-signed)</span></span>
          </label>
          <label class="check">
            <input id="clearPassword" type="checkbox" />
            <span>Clear stored password on save</span>
          </label>
        </div>
      </div>

      <div class="actions">
        <button type="submit" class="primary" id="saveBtn">Save &amp; Connect</button>
        <button type="button" class="secondary" id="testBtn">Test Connection</button>
        <button type="button" class="secondary" id="browseBtn" hidden>Browse tables</button>
      </div>

      <div class="status" id="status" role="status"></div>
    </form>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const DEFAULT_PORTS = { mssql: 1433, mysql: 3306, postgres: 5432 };

  const els = {
    engineMssql: document.getElementById('engineMssql'),
    engineMysql: document.getElementById('engineMysql'),
    enginePostgres: document.getElementById('enginePostgres'),
    scopeGlobal: document.getElementById('scopeGlobal'),
    scopeWorkspace: document.getElementById('scopeWorkspace'),
    scopeBlock: document.getElementById('scopeBlock'),
    server: document.getElementById('server'),
    database: document.getElementById('database'),
    databaseHint: document.getElementById('databaseHint'),
    extraDbBlock: document.getElementById('extraDbBlock'),
    extraDbLabel: document.getElementById('extraDbLabel'),
    extraDbHint: document.getElementById('extraDbHint'),
    dbList: document.getElementById('dbList'),
    loadDbsBtn: document.getElementById('loadDbsBtn'),
    selectAllDbsBtn: document.getElementById('selectAllDbsBtn'),
    user: document.getElementById('user'),
    password: document.getElementById('password'),
    port: document.getElementById('port'),
    pwdToggle: document.getElementById('pwdToggle'),
    iconEye: document.getElementById('iconEye'),
    iconEyeOff: document.getElementById('iconEyeOff'),
    enabled: document.getElementById('enabled'),
    encrypt: document.getElementById('encrypt'),
    trust: document.getElementById('trust'),
    clearPassword: document.getElementById('clearPassword'),
    pwdNote: document.getElementById('pwdNote'),
    badge: document.getElementById('badge'),
    status: document.getElementById('status'),
    saveBtn: document.getElementById('saveBtn'),
    testBtn: document.getElementById('testBtn'),
    browseBtn: document.getElementById('browseBtn'),
    form: document.getElementById('form')
  };

  let passwordVisible = false;
  let suppressScopeLoad = false;
  let availableDatabases = [];
  let selectedDatabases = [];

  function setPasswordVisible(visible) {
    passwordVisible = visible;
    els.password.type = visible ? 'text' : 'password';
    els.iconEye.style.display = visible ? 'none' : 'block';
    els.iconEyeOff.style.display = visible ? 'block' : 'none';
    els.pwdToggle.title = visible ? 'Hide password' : 'Show password';
    els.pwdToggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  }

  els.pwdToggle.addEventListener('click', () => {
    setPasswordVisible(!passwordVisible);
  });

  function getEngine() {
    if (els.engineMysql.checked) {
      return 'mysql';
    }
    if (els.enginePostgres.checked) {
      return 'postgres';
    }
    return 'mssql';
  }

  function setEngine(engine) {
    if (engine === 'mysql') {
      els.engineMysql.checked = true;
    } else if (engine === 'postgres') {
      els.enginePostgres.checked = true;
    } else {
      els.engineMssql.checked = true;
    }
    updateEngineUi();
  }

  function engineLabel(engine) {
    if (engine === 'mysql') {
      return 'MySQL';
    }
    if (engine === 'postgres') {
      return 'PostgreSQL';
    }
    return 'SQL Server';
  }

  function updateEngineUi() {
    const engine = getEngine();
    const isPostgres = engine === 'postgres';
    els.selectAllDbsBtn.hidden = isPostgres;
    els.databaseHint.textContent = isPostgres
      ? 'PostgreSQL connects to this one database. Schema loads from every user schema in it.'
      : 'Used for the live connection, dry-run, and when the same table name exists in more than one database.';
    els.extraDbLabel.textContent = isPostgres ? 'Available databases' : 'Also load schema from';
    els.extraDbHint.textContent = isPostgres
      ? 'Click a name to use it as the default database. Extra databases cannot be queried on the same connection.'
      : 'Select every database you want IntelliSense to know. Same table name in two DBs → the default database wins.';
    els.server.placeholder = engine === 'mssql' ? 'localhost or host\\\\INSTANCE' : 'localhost';
    renderDbList();
  }

  function getScope() {
    return els.scopeWorkspace.checked ? 'workspace' : 'global';
  }

  function setScope(scope) {
    suppressScopeLoad = true;
    if (scope === 'workspace') {
      els.scopeWorkspace.checked = true;
    } else {
      els.scopeGlobal.checked = true;
    }
    suppressScopeLoad = false;
  }

  let lastEngine = getEngine();

  function setBusy(busy) {
    els.saveBtn.disabled = busy;
    els.testBtn.disabled = busy;
    els.loadDbsBtn.disabled = busy;
    els.selectAllDbsBtn.disabled = busy;
  }

  function showStatus(message, kind) {
    els.status.textContent = message;
    els.status.className = 'status show ' + kind;
  }

  function selectedSet() {
    return new Set(selectedDatabases.map((name) => name.toLowerCase()));
  }

  function renderDbList() {
    const engine = getEngine();
    const chosen = selectedSet();
    const defaultDb = (els.database.value || '').trim();
    if (defaultDb) {
      chosen.add(defaultDb.toLowerCase());
    }
    const names = availableDatabases.length > 0
      ? availableDatabases
      : selectedDatabases.length > 0
        ? selectedDatabases
        : (defaultDb ? [defaultDb] : []);
    els.dbList.innerHTML = '';
    if (engine === 'postgres') {
      for (const name of names) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'db-item';
        btn.textContent = name;
        if (defaultDb && name.toLowerCase() === defaultDb.toLowerCase()) {
          btn.setAttribute('aria-pressed', 'true');
        }
        btn.addEventListener('click', () => {
          els.database.value = name;
          selectedDatabases = [name];
          renderDbList();
        });
        els.dbList.appendChild(btn);
      }
      return;
    }
    for (const name of names) {
      const label = document.createElement('label');
      label.className = 'db-item';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = name;
      input.checked = chosen.has(name.toLowerCase());
      if (defaultDb && name.toLowerCase() === defaultDb.toLowerCase()) {
        input.checked = true;
      }
      input.addEventListener('change', () => {
        syncSelectedFromCheckboxes();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(name));
      els.dbList.appendChild(label);
    }
  }

  function syncSelectedFromCheckboxes() {
    const boxes = els.dbList.querySelectorAll('input[type="checkbox"]');
    selectedDatabases = [];
    boxes.forEach((box) => {
      if (box.checked) {
        selectedDatabases.push(box.value);
      }
    });
    const defaultDb = (els.database.value || '').trim();
    if (defaultDb && !selectedDatabases.some((name) => name.toLowerCase() === defaultDb.toLowerCase())) {
      selectedDatabases.unshift(defaultDb);
    }
  }

  function readForm() {
    syncSelectedFromCheckboxes();
    const engine = getEngine();
    const database = els.database.value;
    let databases = engine === 'postgres'
      ? (database.trim() ? [database.trim()] : [])
      : selectedDatabases.slice();
    if (engine !== 'postgres' && database.trim() && !databases.some((name) => name.toLowerCase() === database.trim().toLowerCase())) {
      databases = [database.trim(), ...databases];
    }
    return {
      engine,
      settingsScope: getScope(),
      server: els.server.value,
      database,
      databases,
      user: els.user.value,
      password: els.password.value,
      port: Number(els.port.value) || DEFAULT_PORTS[engine] || 1433,
      encrypt: els.encrypt.checked,
      trustServerCertificate: els.trust.checked,
      enabled: els.enabled.checked,
      clearPassword: els.clearPassword.checked
    };
  }

  function stateLabel(msg) {
    const map = {
      connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected',
      unconfigured: 'Not configured', disabled: 'Disabled', error: 'Error'
    };
    return map[msg] || msg;
  }

  function onEngineChange() {
    const next = getEngine();
    const prevDefault = DEFAULT_PORTS[lastEngine];
    const nextDefault = DEFAULT_PORTS[next];
    if (Number(els.port.value) === prevDefault) {
      els.port.value = String(nextDefault);
    }
    lastEngine = next;
    updateEngineUi();
  }

  function onScopeChange() {
    if (suppressScopeLoad) {
      return;
    }
    vscode.postMessage({ type: 'loadScope', scope: getScope() });
  }

  els.engineMssql.addEventListener('change', onEngineChange);
  els.engineMysql.addEventListener('change', onEngineChange);
  els.enginePostgres.addEventListener('change', onEngineChange);
  els.scopeGlobal.addEventListener('change', onScopeChange);
  els.scopeWorkspace.addEventListener('change', onScopeChange);
  els.database.addEventListener('change', () => {
    syncSelectedFromCheckboxes();
    renderDbList();
  });
  els.loadDbsBtn.addEventListener('click', () => {
    const data = readForm();
    if (!data.server.trim() || !data.database.trim()) {
      showStatus('Server and default database are required to load the list.', 'err');
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: 'listDatabases', ...data });
  });
  els.selectAllDbsBtn.addEventListener('click', () => {
    const boxes = els.dbList.querySelectorAll('input[type="checkbox"]');
    boxes.forEach((box) => { box.checked = true; });
    syncSelectedFromCheckboxes();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      const c = msg.config;
      setEngine(c.engine === 'mysql' || c.engine === 'postgres' ? c.engine : 'mssql');
      lastEngine = getEngine();
      setScope(c.settingsScope === 'workspace' ? 'workspace' : 'global');
      els.scopeBlock.style.display = c.canUseWorkspace ? '' : 'none';
      if (!c.canUseWorkspace) {
        setScope('global');
      }
      els.server.value = c.server || '';
      els.database.value = c.database || '';
      selectedDatabases = Array.isArray(c.databases) && c.databases.length
        ? c.databases.slice()
        : (c.database ? [c.database] : []);
      availableDatabases = selectedDatabases.slice();
      els.user.value = c.user || '';
      els.port.value = String(c.port || DEFAULT_PORTS[getEngine()]);
      els.encrypt.checked = !!c.encrypt;
      els.trust.checked = !!c.trustServerCertificate;
      els.enabled.checked = c.enabled !== false;
      els.password.value = c.password || '';
      els.clearPassword.checked = false;
      els.pwdNote.textContent = c.hasStoredPassword
        ? 'Saved in the OS keychain for this scope. Use the eye icon to show or hide it.'
        : 'Will be saved in the OS keychain for the selected scope.';
      els.server.placeholder = getEngine() === 'mssql' ? 'localhost or host\\\\INSTANCE' : 'localhost';
      updateEngineUi();

      const scopeLabel = c.settingsScope === 'workspace' ? 'This project' : 'All projects';
      const dbCount = selectedDatabases.length;
      let badge = engineLabel(getEngine()) + ' · ' + scopeLabel + ' · ' + stateLabel(msg.state);
      if (dbCount > 1) {
        badge += ' · ' + dbCount + ' DBs';
      }
      if (msg.tableCount > 0) {
        badge += ' · ' + msg.tableCount + ' tables' + (msg.stale ? ' (cached)' : '');
        els.browseBtn.hidden = false;
      } else {
        els.browseBtn.hidden = true;
      }
      if (msg.state === 'error' && msg.lastError) {
        badge += ' — ' + msg.lastError;
      }
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
        availableDatabases = msg.databases.slice();
        renderDbList();
      }
      showStatus(msg.message, msg.ok ? 'ok' : 'err');
    }
  });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = readForm();
    if (!data.server.trim() || !data.database.trim()) {
      showStatus('Server and default database are required.', 'err');
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: 'save', ...data });
  });

  els.testBtn.addEventListener('click', () => {
    const data = readForm();
    if (!data.server.trim() || !data.database.trim()) {
      showStatus('Server and default database are required.', 'err');
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: 'test', ...data });
  });

  els.browseBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'browseSchema' });
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i++) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}

function normalizeFormDatabases(defaultDatabase: string, databases: string[] | undefined): string[] {
    const names = [defaultDatabase, ...(databases ?? [])]
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(name);
    }
    return result;
}

function hintFromMessage(message: string, engine: DbEngine): string | undefined {
    const lower = message.toLowerCase();
    if (lower.includes('unable to process incoming packet') || lower.includes('connection lost')) {
        if (engine === 'mssql') {
            return (
                'If this is MySQL, choose Engine → MySQL / MariaDB (port 3306). ' +
                'If this is PostgreSQL, choose Engine → PostgreSQL (port 5432). ' +
                'For SQL Server: enable Trust server certificate, or turn Encrypt off.'
            );
        }
        if (engine === 'postgres') {
            return 'Check PostgreSQL host, port 5432, credentials, database name, and TLS settings.';
        }
        return 'Check MySQL host, port 3306, credentials, and TLS settings.';
    }
    if (lower.includes('login failed') || lower.includes('access denied')) {
        return 'Check username/password, and that the login can open this database.';
    }
    if (lower.includes('certificate') || lower.includes('self signed')) {
        return 'Enable "Trust server certificate" for local or self-signed TLS.';
    }
    if (lower.includes('etimeout') || lower.includes('timeout')) {
        return 'Check VPN/firewall, port, and that the database server is running.';
    }
    return undefined;
}

export type ConnectionFormSettings = Pick<
    ExtensionConfig,
    | 'engine'
    | 'server'
    | 'database'
    | 'databases'
    | 'user'
    | 'port'
    | 'encrypt'
    | 'trustServerCertificate'
    | 'enabled'
> & { settingsScope: SettingsScope };
