import * as vscode from 'vscode';
import {
    DbEngine,
    ExtensionConfig,
    LoginKind,
    SqlServerService,
    selectedDatabases
} from '../db/connection';
import { DiagnosticsManager } from '../providers/diagnostics';
import { hintFromMessage, resolveFormConnection, type FormPayload } from './connectionForm';
import { panelStatsForSelection, saveResultMessage } from './connectionPanelHtml';
import { fillWebviewPage, mediaRoot, tabIcon } from './media';
import { SchemaExplorer } from './schemaExplorer';

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
    | ({ type: 'listDatabases'; listProject?: string } & Omit<
          FormPayload,
          'enabled' | 'clearPassword'
      >)
    | { type: 'listProjects' }
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
    | { type: 'databases'; ok: boolean; databases: string[]; message: string }
    | { type: 'projects'; ok: boolean; projects: string[]; message: string };

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
        diagnostics: DiagnosticsManager,
        options?: { profileId?: string }
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (ConnectionPanel.current) {
            if (options?.profileId) {
                ConnectionPanel.current.selectedId = options.profileId;
            }
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
                localResourceRoots: [mediaRoot()]
            }
        );

        ConnectionPanel.current = new ConnectionPanel(panel, db, diagnostics);
        if (options?.profileId) {
            ConnectionPanel.current.selectedId = options.profileId;
        }
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly db: SqlServerService,
        private readonly diagnostics: DiagnosticsManager
    ) {
        this.panel = panel;
        this.panel.iconPath = tabIcon('bisql-logo-light.svg', 'bisql-logo-dark.svg');
        this.panel.webview.onDidReceiveMessage(
            (message: WebviewToExt) => {
                void this.onMessage(message);
            },
            null,
            this.disposables
        );
        this.panel.webview.html = this.getHtml();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

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
            case 'listProjects':
                await this.handleListProjects();
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

            const config = this.db.getConfig();
            const databases = selectedDatabases(config);
            const dbLabel = databases.length > 1 ? `${databases.length} databases` : databases[0] || 'database';
            const result = saveResultMessage({
                connected: this.db.connectionState === 'connected',
                connectionState: this.db.connectionState,
                lastError: this.db.lastErrorMessage,
                tables: this.db.schema.tables.length,
                dbLabel,
                loginKind: config.loginKind
            });

            await this.panel.webview.postMessage({
                type: 'saved',
                ok: result.ok,
                message: result.message
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

    private async handleListProjects(): Promise<void> {
        await this.postStatus('Loading projects…', true, true);
        try {
            const result = await this.db.listAccessibleProjects();
            await this.panel.webview.postMessage({
                type: 'projects',
                ok: result.ok,
                projects: result.projects,
                message: result.message
            } satisfies ExtToWebview);
            await this.postStatus(
                result.ok
                    ? `Loaded ${result.projects.length} projects. Click one to set home, or click another to add its datasets.`
                    : `Failed: ${result.message}`,
                result.ok,
                false
            );
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
                await this.postStatus(
                    persisted.settings.engine === 'bigquery'
                        ? 'Failed: Set project first.'
                        : 'Failed: Set server first.',
                    false,
                    false
                );
                return;
            }
            this.selectedId = persisted.id;
            const result = await this.db.listDatabases(message.listProject);
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
                        : persisted.settings.engine === 'bigquery'
                          ? `Loaded ${result.databases.length} datasets. Pick a default, then check extras. Type other-project. and Load to add another project.`
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
        if (resolved.settings.loginKind !== 'bigquery') {
            if (message.clearPassword) {
                await this.db.clearPassword(id);
            } else if (resolved.password.length > 0) {
                await this.db.setPassword(resolved.password, id);
            }
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
        return fillWebviewPage('connection', this.panel.webview, null);
    }
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
