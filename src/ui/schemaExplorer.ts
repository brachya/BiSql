import * as vscode from 'vscode';
import { refreshSchemaWithPicker } from '../commands/refreshSchema';
import { ColumnInfo, DbEngine, SqlServerService, TableInfo } from '../db/connection';
import { DiagnosticsManager } from '../providers/diagnostics';
import {
    compareDatabases,
    formatSchemaDiffReport,
    parseChangeLevel,
    parseDiffFilter,
    SchemaDiff
} from '../sql/schemaDiff';
import { buildTableRelations, compactRelationMap, TableRelationBundle } from '../sql/tableRelations';
import { fillWebviewPage, mediaRoot, tabIcon } from './media';
import { copyText, previewTable } from './schemaActions';

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
    | { type: 'openSidebar' }
    | { type: 'revealInSidebar'; qualifiedName: string }
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
          foreignKeysLoaded: boolean;
          relations: Record<string, TableRelationBundle>;
          focusTable?: string;
          initialMode?: 'browse' | 'map' | 'compare';
          initialDatabase?: string;
      }
    | { type: 'focus'; qualifiedName: string }
    | { type: 'openMap'; database?: string; focusTable?: string }
    | { type: 'status'; message: string; ok: boolean; busy?: boolean }
    | { type: 'diff'; diff: SchemaDiff };

export type SchemaExplorerOptions = {
    focusTable?: string;
    mode?: 'browse' | 'map' | 'compare';
    database?: string;
    revealInSidebar?: (qualifiedName: string) => void;
    diagnostics?: DiagnosticsManager;
};

/**
 * Browse tables and views already in the schema cache.
 * Does not query the live database until the user clicks Refresh.
 */
export class SchemaExplorer {
    public static readonly viewType = 'bisql.schemaExplorer';

    private static current: SchemaExplorer | undefined;
    public static defaultRevealInSidebar: ((qualifiedName: string) => void) | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private pendingFocus: string | undefined;
    private pendingMode: 'browse' | 'map' | 'compare' | undefined;
    private pendingDatabase: string | undefined;
    private revealInSidebar: ((qualifiedName: string) => void) | undefined;
    private diagnostics: DiagnosticsManager | undefined;

    public static show(
        db: SqlServerService,
        openLogin: () => void,
        options?: SchemaExplorerOptions
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (SchemaExplorer.current) {
            SchemaExplorer.current.applyOptions(options);
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
                localResourceRoots: [mediaRoot()]
            }
        );
        panel.iconPath = tabIcon('sql-results-light.svg', 'sql-results-dark.svg');

        SchemaExplorer.current = new SchemaExplorer(panel, db, openLogin, options);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly db: SqlServerService,
        private readonly openLogin: () => void,
        options?: SchemaExplorerOptions
    ) {
        this.panel = panel;
        this.applyOptions(options);
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
            this.db.onDidChangeSchema(() => {
                void this.postInit();
            }),
            this.db.onDidChangeState(() => {
                void this.postInit();
            })
        );
    }

    /** BigQuery refreshes the home project. Other engines refresh the whole login. */
    private async refreshWithoutPicker(): Promise<{
        ok: boolean;
        cancelled: boolean;
        updated: boolean;
    }> {
        const config = this.db.getConfig();
        const home = config.server.trim();
        const ok =
            config.engine === 'bigquery' && home
                ? await this.db.refreshSchema({ projects: [home] })
                : await this.db.refreshSchema();
        return { ok, cancelled: false, updated: ok || this.db.lastRefreshUpdatedCache };
    }

    private applyOptions(options?: SchemaExplorerOptions): void {
        if (options?.focusTable) {
            this.pendingFocus = options.focusTable;
        }
        if (options?.mode) {
            this.pendingMode = options.mode;
        }
        if (options?.database) {
            this.pendingDatabase = options.database;
        }
        if (options?.revealInSidebar) {
            this.revealInSidebar = options.revealInSidebar;
            SchemaExplorer.defaultRevealInSidebar = options.revealInSidebar;
        } else if (!this.revealInSidebar) {
            this.revealInSidebar = SchemaExplorer.defaultRevealInSidebar;
        }
        if (options?.diagnostics) {
            this.diagnostics = options.diagnostics;
        }
    }

    private async onMessage(message: WebviewToExt): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.postInit();
                return;
            case 'copy':
                await copyText(message.text);
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
                const refreshed = this.diagnostics
                    ? await refreshSchemaWithPicker(this.db, this.diagnostics)
                    : await this.refreshWithoutPicker();
                await this.postInit();
                const statusOk = refreshed.ok || refreshed.cancelled;
                const message = refreshed.cancelled
                    ? 'Refresh cancelled.'
                    : refreshed.ok
                      ? `Loaded ${this.db.schema.tables.length} tables and views.`
                      : (this.db.lastErrorMessage ?? 'Could not refresh schema.');
                await this.panel.webview.postMessage({
                    type: 'status',
                    message,
                    ok: statusOk,
                    busy: false
                } satisfies ExtToWebview);
                return;
            }
            case 'openLogin':
                this.openLogin();
                return;
            case 'openSidebar':
                await vscode.commands.executeCommand('bisql.explorer.focus');
                return;
            case 'revealInSidebar':
                this.revealInSidebar?.(message.qualifiedName);
                await vscode.commands.executeCommand('bisql.explorer.focus');
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
                await copyText(report);
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
        await this.panel.webview.postMessage({
            type: 'status',
            message: `Opening ${qualifiedName}…`,
            ok: true,
            busy: true
        } satisfies ExtToWebview);
        const result = await previewTable(this.db, qualifiedName);
        await this.panel.webview.postMessage({
            type: 'status',
            message: result.message,
            ok: result.ok,
            busy: false
        } satisfies ExtToWebview);
    }

    private async postInit(): Promise<void> {
        const config = this.db.getConfig();
        const focusTable = this.pendingFocus;
        const initialMode = this.pendingMode;
        const initialDatabase = this.pendingDatabase;
        this.pendingFocus = undefined;
        this.pendingMode = undefined;
        this.pendingDatabase = undefined;
        const relationBundles = buildTableRelations(this.db.schema.tables);
        const payload: ExtToWebview = {
            type: 'init',
            engine: config.engine,
            server: config.server,
            database: config.database,
            state: this.db.connectionState,
            stale: this.db.schema.stale,
            fetchedAt: this.db.schema.fetchedAt,
            tableCount: this.db.schema.tables.length,
            tables: this.db.schema.tables.map(toDto),
            foreignKeysLoaded: this.db.schema.foreignKeysLoaded,
            relations: compactRelationMap(relationBundles),
            focusTable,
            initialMode,
            initialDatabase
        };
        await this.panel.webview.postMessage(payload);
        if (initialMode === 'map') {
            await this.panel.webview.postMessage({
                type: 'openMap',
                database: initialDatabase,
                focusTable
            } satisfies ExtToWebview);
        } else if (focusTable) {
            await this.panel.webview.postMessage({
                type: 'focus',
                qualifiedName: focusTable
            } satisfies ExtToWebview);
        }
    }

    private dispose(): void {
        SchemaExplorer.current = undefined;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }

    private getHtml(): string {
        return fillWebviewPage('schema', this.panel.webview, null);
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

