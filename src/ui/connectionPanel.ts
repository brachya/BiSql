import * as vscode from 'vscode';
import {
    DbEngine,
    ExtensionConfig,
    LoginKind,
    SqlServerService,
    engineForLoginKind,
    parseLoginKind,
    selectedDatabases
} from '../db/connection';
import { isSupabaseHost, parsePostgresUrl } from '../db/postgresUrl';
import { DiagnosticsManager } from '../providers/diagnostics';
import { connectionPanelHtml, panelStatsForSelection } from './connectionPanelHtml';
import { tabIcon } from './media';
import { SchemaExplorer } from './schemaExplorer';

type FormPayload = {
    connectionId: string;
    name: string;
    pinToWorkspace: boolean;
    loginKind: LoginKind;
    connectionUrl: string;
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
};

type ProfileRow = {
    id: string;
    name: string;
    loginKind: LoginKind;
    server: string;
    database: string;
    active: boolean;
};

type WebviewToExt =
    | { type: 'ready' }
    | ({ type: 'save' } & FormPayload)
    | ({ type: 'test' } & Omit<FormPayload, 'enabled' | 'clearPassword'>)
    | { type: 'select'; id: string }
    | { type: 'add' }
    | { type: 'rename'; id: string }
    | { type: 'delete'; id: string }
    | ({ type: 'listDatabases' } & Omit<FormPayload, 'enabled' | 'clearPassword'>)
    | { type: 'browseSchema' };

type ExtToWebview =
    | {
          type: 'init';
          profiles: ProfileRow[];
          selectedId: string;
          pinToWorkspace: boolean;
          canPinWorkspace: boolean;
          config: {
              connectionId: string;
              name: string;
              loginKind: LoginKind;
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
    private selectedId = '';

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
            case 'select':
                this.selectedId = message.id;
                await this.postInit();
                return;
            case 'add':
                this.selectedId = await this.db.addProfile();
                await this.postInit();
                return;
            case 'rename': {
                const current = this.db.getProfile(message.id);
                const name = await vscode.window.showInputBox({
                    prompt: 'Connection name',
                    value: current?.name ?? '',
                    ignoreFocusOut: true
                });
                if (name?.trim()) {
                    await this.db.renameProfile(message.id, name);
                    await this.postInit();
                }
                return;
            }
            case 'delete': {
                const current = this.db.getProfile(message.id);
                const pick = await vscode.window.showWarningMessage(
                    `Delete “${current?.name ?? 'this connection'}”? The password for this login is removed too.`,
                    { modal: true },
                    'Delete'
                );
                if (pick === 'Delete') {
                    await this.db.deleteProfile(message.id);
                    this.selectedId = this.db.getActiveConnectionId();
                    await this.postInit();
                }
                return;
            }
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
        const profiles = this.db.listProfiles();
        const activeId = this.db.getActiveConnectionId();
        if (!this.selectedId || !profiles.some((profile) => profile.id === this.selectedId)) {
            this.selectedId = activeId || profiles[0]?.id || '';
        }
        const selected = this.db.getProfile(this.selectedId);
        const config = selected ? this.db.configForProfile(selected) : this.db.getConfig();
        const password = (await this.db.getPassword(this.selectedId || undefined)) ?? '';
        const payload: ExtToWebview = {
            type: 'init',
            profiles: profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                loginKind: profile.loginKind,
                server: profile.server,
                database: profile.database,
                active: profile.id === activeId
            })),
            selectedId: this.selectedId,
            pinToWorkspace: this.db.isActivePinnedToWorkspace() && this.selectedId === activeId,
            canPinWorkspace: this.db.hasWorkspaceFolder(),
            config: {
                connectionId: config.connectionId,
                name: config.connectionName,
                loginKind: config.loginKind,
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
                password
            },
            ...panelStatsForSelection({
                selectedId: this.selectedId,
                activeId,
                hasServer: Boolean(config.server.trim()),
                liveState: this.db.connectionState,
                lastError: this.db.lastErrorMessage,
                tableCount: this.db.schema.tables.length,
                stale: this.db.schema.stale
            })
        };
        await this.panel.webview.postMessage(payload);
    }

    private async handleSave(message: Extract<WebviewToExt, { type: 'save' }>): Promise<void> {
        await this.postStatus('Saving…', true, true);
        try {
            const persisted = await this.persistForm(message, true);
            if (!persisted.ok) {
                await this.panel.webview.postMessage({
                    type: 'saved',
                    ok: false,
                    message: persisted.message
                } satisfies ExtToWebview);
                return;
            }
            this.selectedId = persisted.id;

            await this.db.reconfigure();
            await this.diagnostics.revalidateOpenDocuments(true);

            const connected = this.db.connectionState === 'connected';
            const tables = this.db.schema.tables.length;
            const databases = selectedDatabases(this.db.getConfig());
            const dbLabel = databases.length > 1 ? `${databases.length} databases` : databases[0] || 'database';
            const msg = connected
                ? `Saved. Connected — ${tables} tables/views from ${dbLabel}.`
                : this.db.lastErrorMessage
                  ? `Saved. Connection failed: ${this.db.lastErrorMessage}`
                  : 'Saved. Fill in the login, then Test Connection.';

            await this.panel.webview.postMessage({
                type: 'saved',
                ok: connected,
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
            const persisted = await this.persistForm({ ...message, enabled: true, clearPassword: false }, true);
            if (!persisted.ok) {
                await this.postStatus(persisted.message, false, false);
                return;
            }
            this.selectedId = persisted.id;

            const result = await this.db.testConnection();
            if (result.ok) {
                await this.db.refreshSchema();
                await this.diagnostics.revalidateOpenDocuments(false);
                await this.postStatus(`Connected: ${result.message}`, true, false);
            } else {
                const hint = hintFromMessage(result.message, persisted.settings.loginKind);
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
            const persisted = await this.persistForm(
                { ...message, enabled: true, clearPassword: false },
                true,
                { requireDatabase: false }
            );
            if (!persisted.ok) {
                await this.postStatus(persisted.message, false, false);
                return;
            }
            if (!persisted.settings.server.trim()) {
                await this.postStatus('Failed: Set server first.', false, false);
                return;
            }
            this.selectedId = persisted.id;
            const result = await this.db.listDatabases();
            await this.panel.webview.postMessage({
                type: 'databases',
                ok: result.ok,
                databases: result.databases,
                message: result.message
            } satisfies ExtToWebview);
            await this.postStatus(
                result.ok
                    ? persisted.settings.engine === 'postgres'
                        ? `Loaded ${result.databases.length} databases. Click one to use it.`
                        : `Loaded ${result.databases.length} databases. Pick a default, then check any extras.`
                    : `Failed: ${result.message}`,
                result.ok,
                false
            );
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            await this.postStatus(`Failed: ${text}`, false, false);
        }
    }

    private async persistForm(
        message: Omit<FormPayload, 'enabled' | 'clearPassword'> & {
            enabled?: boolean;
            clearPassword?: boolean;
        },
        activate: boolean,
        options?: { requireDatabase?: boolean }
    ): Promise<
        | {
              ok: true;
              id: string;
              settings: {
                  engine: DbEngine;
                  loginKind: LoginKind;
                  server: string;
                  database: string;
                  databases: string[];
                  user: string;
                  port: number;
                  encrypt: boolean;
                  trustServerCertificate: boolean;
              };
          }
        | { ok: false; message: string }
    > {
        const resolved = resolveFormConnection(message, options);
        if (!resolved.ok) {
            return resolved;
        }
        const id = await this.db.saveConnectionSettings({
            ...resolved.settings,
            connectionId: message.connectionId,
            name: message.name,
            enabled: message.enabled !== false,
            pinToWorkspace: message.pinToWorkspace,
            activate
        });
        if (message.clearPassword) {
            await this.db.clearPassword(id);
        } else if (resolved.password.length > 0) {
            await this.db.setPassword(resolved.password, id);
        }
        return { ok: true, id, settings: resolved.settings };
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
        return connectionPanelHtml(getNonce());
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

function resolveFormConnection(
    message: Omit<FormPayload, 'enabled' | 'clearPassword'> & { enabled?: boolean },
    options?: { requireDatabase?: boolean }
):
    | {
          ok: true;
          settings: {
              engine: DbEngine;
              loginKind: LoginKind;
              server: string;
              database: string;
              databases: string[];
              user: string;
              port: number;
              encrypt: boolean;
              trustServerCertificate: boolean;
          };
          password: string;
      }
    | { ok: false; message: string } {
    const loginKind = parseLoginKind(message.loginKind, engineForLoginKind(message.loginKind), message.server);
    const requireDatabase = options?.requireDatabase !== false;

    if (loginKind === 'supabase') {
        const url = message.connectionUrl.trim();
        if (url) {
            const parsed = parsePostgresUrl(url);
            if (!parsed.ok) {
                return { ok: false, message: parsed.error };
            }
            if (!isSupabaseHost(parsed.value.host)) {
                return {
                    ok: false,
                    message: 'That host is not Supabase. Choose PostgreSQL and fill the fields.'
                };
            }
            const password = parsed.value.password || message.password;
            if (!password) {
                return {
                    ok: false,
                    message: 'Add the database password. It was not in the URL.'
                };
            }
            const database = parsed.value.database.trim() || 'postgres';
            return {
                ok: true,
                settings: {
                    engine: 'postgres',
                    loginKind: 'supabase',
                    server: parsed.value.host,
                    database,
                    databases: [database],
                    user: parsed.value.user,
                    port: parsed.value.port,
                    encrypt: parsed.value.sslMode !== 'disable',
                    trustServerCertificate: parsed.value.sslMode !== 'verify-full'
                },
                password
            };
        }
        if (!message.server.trim() || !isSupabaseHost(message.server)) {
            return { ok: false, message: 'Paste a Supabase connection URL.' };
        }
        if (requireDatabase && !message.database.trim()) {
            return { ok: false, message: 'Paste a Supabase connection URL.' };
        }
        return {
            ok: true,
            settings: {
                engine: 'postgres',
                loginKind: 'supabase',
                server: message.server.trim(),
                database: message.database.trim() || 'postgres',
                databases: [message.database.trim() || 'postgres'],
                user: message.user.trim(),
                port: message.port || 5432,
                encrypt: true,
                trustServerCertificate: message.trustServerCertificate !== false
            },
            password: message.password
        };
    }

    const engine = engineForLoginKind(loginKind);
    if (!message.server.trim()) {
        return { ok: false, message: 'Server is required.' };
    }
    if (requireDatabase && !message.database.trim()) {
        return { ok: false, message: 'Database is required.' };
    }
    const databases = normalizeFormDatabases(message.database, message.databases);
    return {
        ok: true,
        settings: {
            engine,
            loginKind,
            server: message.server.trim(),
            database: message.database.trim() || databases[0] || '',
            databases,
            user: message.user.trim(),
            port: message.port,
            encrypt: message.encrypt,
            trustServerCertificate: message.trustServerCertificate
        },
        password: message.password
    };
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

function hintFromMessage(message: string, loginKind: LoginKind): string | undefined {
    const lower = message.toLowerCase();
    if (lower.includes('unable to process incoming packet') || lower.includes('connection lost')) {
        if (loginKind === 'mssql') {
            return (
                'If this is MySQL, choose MySQL. ' +
                'If this is PostgreSQL or Supabase, pick that card instead. ' +
                'For SQL Server: enable Trust server certificate, or turn Encrypt off.'
            );
        }
        if (loginKind === 'supabase') {
            return 'Supabase handshake failed. Paste the Session pooler URL and keep TLS on.';
        }
        if (loginKind === 'postgres') {
            return 'Check PostgreSQL host, port, credentials, database name, and TLS settings.';
        }
        return 'Check MySQL host, port, credentials, and TLS settings.';
    }
    if (lower.includes('login failed') || lower.includes('access denied') || lower.includes('password authentication failed')) {
        return 'Check username/password, and that the login can open this database.';
    }
    if (lower.includes('certificate') || lower.includes('self signed')) {
        return loginKind === 'mssql'
            ? 'Enable "Trust server certificate" for local or self-signed TLS.'
            : 'Enable "Allow self-signed certificate".';
    }
    if (lower.includes('etimeout') || lower.includes('timeout')) {
        return loginKind === 'supabase'
            ? 'Timed out. If you used the direct db.… host, paste the Session pooler URL instead.'
            : 'Check VPN/firewall, port, and that the database server is running.';
    }
    return undefined;
}

export type ConnectionFormSettings = Pick<
    ExtensionConfig,
    | 'engine'
    | 'loginKind'
    | 'server'
    | 'database'
    | 'databases'
    | 'user'
    | 'port'
    | 'encrypt'
    | 'trustServerCertificate'
    | 'enabled'
>;
