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
import { fillWebviewPage, mediaRoot, tabIcon } from './media';
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
                localResourceRoots: [mediaRoot()]
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

