import * as vscode from 'vscode';
import { QueryResult, SqlServerService } from '../db/connection';
import { isSqlDocument, statementAtOffset } from '../parser/sqlExtractor';
import { highlightSql } from '../sql/highlightSql';
import {
    findFStringInterpolations,
    isMutatingSql,
    lookupParam,
    uniqueBindNames
} from '../sql/parameters';
import {
    analyzeResultEdit,
    buildDeleteSql,
    buildInsertSql,
    buildRenameSql,
    buildUpdateSql,
    canDuplicateRow,
    explainResultToQuery,
    formatMutationPreview,
    NULL_DISPLAY,
    ResultColumnEdit,
    ResultEditPlan
} from '../sql/resultEdit';
import {
    buildResultExport,
    ExportFormat,
    ExportScope
} from '../sql/resultExport';
import {
    clampPageSize,
    compareResultCells,
    nextSort,
    PAGE_SIZE_CHOICES,
    ResultSort
} from '../sql/resultPage';
import { tabIcon } from './media';

type WebviewToExt =
    | { type: 'setNull'; row: number; col: number }
    | { type: 'deleteRow'; row: number }
    | { type: 'duplicateRow'; row: number }
    | { type: 'editCell'; row: number; col: number; value: string }
    | { type: 'renameColumn'; col: number }
    | { type: 'setDetailed'; on: boolean }
    | { type: 'setSqlOpen'; on: boolean }
    | { type: 'refresh' }
    | { type: 'page'; delta: number }
    | { type: 'pageSize'; pageSize: number }
    | { type: 'sortBy'; col: number }
    | { type: 'copyExport'; scope: ExportScope; format: ExportFormat; row: number; col: number }
    | { type: 'saveExport'; scope: ExportScope; format: ExportFormat; row: number; col: number }
    | { type: 'copySql' }
    | { type: 'runQuery'; params: Record<string, string | null> }
    | { type: 'editInEditor' }
    | { type: 'setParams'; params: Record<string, string | null> };

type ExtToWebview =
    | { type: 'applied'; action: 'setNull' | 'editCell'; row: number; col: number; value: string }
    | { type: 'applied'; action: 'deleteRow'; row: number }
    | { type: 'applied'; action: 'renameColumn'; col: number; displayName: string; sourceColumn: string }
    | { type: 'status'; message: string; ok: boolean }
    | { type: 'busy'; busy: boolean }
    | {
          type: 'sqlDraft';
          previewHtml: string;
          sqlHtml: string;
          params: Record<string, string | null>;
      };

function pendingQueryResult(
    sql: string,
    params: Record<string, string | null>,
    pageSize: number
): QueryResult {
    return {
        ok: true,
        sql,
        executedSql: sql,
        params,
        columns: [],
        rows: [],
        rowsAffected: undefined,
        elapsedMs: 0,
        truncated: false,
        maxRows: pageSize,
        pageOffset: 0,
        paged: false
    };
}

interface GridState {
    columns: string[];
    rows: string[][];
    edit: {
        editable: boolean;
        canDuplicate: boolean;
        detailed: boolean;
        reason: string;
        tableDisplay: string;
        columns: ResultColumnEdit[];
    };
    pager: {
        page: number;
        pageSize: number;
        hasMore: boolean;
        hasPrev: boolean;
        rowStart: number;
        rowEnd: number;
        paged: boolean;
        sortCol: number;
        sortDir: string;
        pageSizes: number[];
    };
}

/**
 * Shows the SQL that ran and the result rows in a new editor tab.
 * Each run opens its own tab so two queries can sit side by side.
 * Query edits go through a real SQL editor, not a webview textarea.
 */
export class ResultsPanel {
    public static readonly viewType = 'bisql.resultsPanel';
    private static readonly openPanels = new Set<ResultsPanel>();

    public static findByDocument(uri: vscode.Uri): ResultsPanel | undefined {
        const key = uri.toString();
        for (const panel of ResultsPanel.openPanels) {
            if (panel.linkedUri?.toString() === key) {
                return panel;
            }
        }
        return undefined;
    }

    public static show(
        result: QueryResult,
        db: SqlServerService,
        options?: { preserveFocus?: boolean }
    ): ResultsPanel {
        return ResultsPanel.create(result, db, options, false);
    }

    /**
     * Open the results tab at once so the editor stays usable while SQL runs.
     */
    public static showRunning(
        db: SqlServerService,
        sql: string,
        params: Record<string, string | null>,
        options?: { preserveFocus?: boolean }
    ): ResultsPanel {
        const pageSize = clampPageSize(db.getConfig().queryMaxRows, db.getConfig().queryMaxRows);
        return ResultsPanel.create(
            pendingQueryResult(sql, params, pageSize),
            db,
            options,
            true
        );
    }

    private static create(
        result: QueryResult,
        db: SqlServerService,
        options: { preserveFocus?: boolean } | undefined,
        loading: boolean
    ): ResultsPanel {
        const title = loading ? 'Running SQL…' : result.ok ? 'SQL Results' : 'SQL Error';
        const panel = vscode.window.createWebviewPanel(
            ResultsPanel.viewType,
            title,
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: options?.preserveFocus === true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );
        panel.iconPath = tabIcon('sql-results-light.svg', 'sql-results-dark.svg');
        return new ResultsPanel(panel, db, result, loading);
    }

    private result: QueryResult;
    private plan: ResultEditPlan;
    private columns: string[];
    private rows: string[][];
    private pageSize: number;
    private pageOffset: number;
    private sort: ResultSort | undefined;
    private paged: boolean;
    private loading: boolean;
    private detailedMode = false;
    private sqlOpen = false;
    private busy = false;
    private linkedUri: vscode.Uri | undefined;
    private draftSql: string;
    private draftParams: Record<string, string | null>;
    private linkedSqlTimer: NodeJS.Timeout | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly db: SqlServerService,
        result: QueryResult,
        loading: boolean
    ) {
        this.result = result;
        this.draftSql = result.sql;
        this.draftParams = { ...result.params };
        this.columns = [...result.columns];
        this.rows = result.rows.map((row) => [...row]);
        this.pageSize = result.maxRows;
        this.pageOffset = result.pageOffset;
        this.sort = result.sort;
        this.paged = result.paged;
        this.loading = loading;
        this.plan = this.buildPlan(result);
        this.panel.webview.html = this.getHtml();

        ResultsPanel.openPanels.add(this);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (message: WebviewToExt) => {
                void this.onMessage(message);
            },
            null,
            this.disposables
        );
        vscode.workspace.onDidChangeTextDocument(
            (event) => {
                if (!this.linkedUri || event.document.uri.toString() !== this.linkedUri.toString()) {
                    return;
                }
                this.scheduleLinkedSql(event.document.getText());
            },
            null,
            this.disposables
        );
        vscode.workspace.onDidCloseTextDocument(
            (document) => {
                if (this.linkedUri && document.uri.toString() === this.linkedUri.toString()) {
                    this.linkedUri = undefined;
                }
            },
            null,
            this.disposables
        );
    }

    private buildPlan(result: QueryResult): ResultEditPlan {
        if (!result.ok || result.columns.length === 0 || result.readOnly) {
            return analyzeResultEdit('', [], this.db.getConfig().engine, () => undefined);
        }
        return analyzeResultEdit(result.sql, result.columns, this.db.getConfig().engine, (reference) =>
            this.db.findTable(reference)
        );
    }

    private async onMessage(message: WebviewToExt): Promise<void> {
        if (message.type === 'setDetailed') {
            this.detailedMode = !!message.on;
            return;
        }
        if (message.type === 'setSqlOpen') {
            this.sqlOpen = !!message.on;
            return;
        }
        if (message.type === 'setParams') {
            this.draftParams = asParams(message.params);
            return;
        }
        if (message.type === 'editInEditor') {
            await this.handleEditInEditor();
            return;
        }
        if (this.busy) {
            return;
        }
        switch (message.type) {
            case 'setNull':
                await this.handleSetNull(message.row, message.col);
                return;
            case 'editCell':
                await this.handleEditCell(
                message.row,
                message.col,
                typeof message.value === 'string' ? message.value : String(message.value ?? '')
            );
                return;
            case 'deleteRow':
                await this.handleDeleteRow(message.row);
                return;
            case 'duplicateRow':
                await this.handleDuplicateRow(message.row);
                return;
            case 'renameColumn':
                await this.handleRenameColumn(message.col);
                return;
            case 'refresh':
                await this.handleRefresh();
                return;
            case 'page':
                await this.handlePage(message.delta);
                return;
            case 'pageSize':
                await this.handlePageSize(message.pageSize);
                return;
            case 'sortBy':
                await this.handleSortBy(message.col);
                return;
            case 'copyExport':
                await this.handleCopyExport(message.scope, message.format, message.row, message.col);
                return;
            case 'saveExport':
                await this.handleSaveExport(message.scope, message.format, message.row, message.col);
                return;
            case 'copySql':
                await this.handleCopySql();
                return;
            case 'runQuery':
                await this.handleRunQuery(undefined, message.params);
                return;
        }
    }

    private async handleCopySql(): Promise<void> {
        await vscode.env.clipboard.writeText(this.sqlForRun().trim());
        await this.postStatus('Copied SQL to the clipboard.', true);
    }

    public linkDocument(document: vscode.TextDocument): void {
        this.linkedUri = document.uri;
    }

    public async runFromEditor(sql: string): Promise<void> {
        if (this.busy) {
            return;
        }
        this.draftSql = sql;
        this.draftParams = mergeBindParams(sql, this.draftParams);
        await this.handleRunQuery(sql, this.draftParams);
    }

    private async handleEditInEditor(): Promise<void> {
        const open = this.linkedDocument();
        if (open) {
            await vscode.window.showTextDocument(open, {
                preview: false,
                preserveFocus: false
            });
            return;
        }
        const sql = this.draftSql || this.result.sql;
        const document = await vscode.workspace.openTextDocument({
            language: 'sql',
            content: sql
        });
        this.linkDocument(document);
        const resultsColumn = this.panel.viewColumn;
        const editorColumn =
            resultsColumn === vscode.ViewColumn.One
                ? vscode.ViewColumn.Two
                : vscode.ViewColumn.One;
        await vscode.window.showTextDocument(document, {
            viewColumn: editorColumn,
            preview: false,
            preserveFocus: false
        });
    }

    private linkedDocument(): vscode.TextDocument | undefined {
        if (!this.linkedUri) {
            return undefined;
        }
        const key = this.linkedUri.toString();
        return vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
    }

    private sqlForRun(): string {
        const editor = this.linkedSqlEditor();
        if (editor) {
            const offset = editor.document.offsetAt(editor.selection.active);
            const slice = statementAtOffset(editor.document.getText(), offset);
            if (slice && slice.text.trim().length > 0) {
                return slice.text;
            }
        }
        return this.draftSql || this.result.sql;
    }

    private linkedSqlEditor(): vscode.TextEditor | undefined {
        const document = this.linkedDocument();
        if (!document || !isSqlDocument(document)) {
            return undefined;
        }
        const key = document.uri.toString();
        return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === key);
    }

    private scheduleLinkedSql(sql: string): void {
        if (this.linkedSqlTimer) {
            clearTimeout(this.linkedSqlTimer);
        }
        this.linkedSqlTimer = setTimeout(() => {
            this.linkedSqlTimer = undefined;
            void this.onLinkedSqlChanged(sql);
        }, 80);
    }

    private async onLinkedSqlChanged(sql: string): Promise<void> {
        const editor = this.linkedSqlEditor();
        const text =
            editor && isSqlDocument(editor.document)
                ? (statementAtOffset(sql, editor.document.offsetAt(editor.selection.active))?.text ?? sql)
                : sql;
        this.draftSql = text;
        this.draftParams = mergeBindParams(text, this.draftParams);
        await this.post({
            type: 'sqlDraft',
            previewHtml: highlightSql(sqlPreviewText(text)),
            sqlHtml: highlightSql(text),
            params: this.draftParams
        });
    }

    private async handleRunQuery(
        sql: unknown,
        params: unknown
    ): Promise<void> {
        if (params && typeof params === 'object') {
            this.draftParams = asParams(params);
        }
        const text = typeof sql === 'string' && sql.length > 0 ? sql : this.sqlForRun();
        if (text.trim().length === 0) {
            await this.postStatus('Enter SQL to run.', false);
            return;
        }
        const interpolations = findFStringInterpolations(text);
        if (interpolations.length > 0) {
            const sample = interpolations.slice(0, 3).join(', ');
            await this.postStatus(
                `This SQL still has Python interpolations (${sample}). Remove {…} first.`,
                false
            );
            return;
        }
        if (!this.result.readOnly && isMutatingSql(text)) {
            const confirm = await vscode.window.showWarningMessage(
                'This SQL may change data or schema. Run it anyway?',
                { modal: true },
                'Run'
            );
            if (confirm !== 'Run') {
                return;
            }
        }
        this.draftParams = mergeBindParams(text, this.draftParams);
        this.sqlOpen = true;
        if (this.result.readOnly) {
            await this.reloadExplain(text, this.draftParams, 'Explaining SQL…');
            return;
        }
        await this.reloadQuery(0, this.pageSize, undefined, 'Running SQL…', text, this.draftParams);
    }

    private exportPayload(
        scope: ExportScope,
        format: ExportFormat,
        row: number,
        col: number
    ) {
        return buildResultExport({
            columns: this.columns,
            rows: this.rows,
            scope,
            format,
            row,
            col,
            nullDisplay: NULL_DISPLAY
        });
    }

    private async handleCopyExport(
        scope: ExportScope,
        format: ExportFormat,
        row: number,
        col: number
    ): Promise<void> {
        const built = this.exportPayload(scope, format, row, col);
        if ('error' in built) {
            await this.postStatus(built.error, false);
            return;
        }
        await vscode.env.clipboard.writeText(built.content);
        await this.postStatus(`Copied ${exportLabel(scope, format)} to the clipboard.`, true);
    }

    private async handleSaveExport(
        scope: ExportScope,
        format: ExportFormat,
        row: number,
        col: number
    ): Promise<void> {
        const built = this.exportPayload(scope, format, row, col);
        if ('error' in built) {
            await this.postStatus(built.error, false);
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const defaultUri = folder
            ? vscode.Uri.joinPath(folder, built.suggestedName)
            : vscode.Uri.file(built.suggestedName);
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            saveLabel: 'Export',
            filters:
                format === 'json'
                    ? { JSON: ['json'] }
                    : { CSV: ['csv'] }
        });
        if (!uri) {
            return;
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(built.content, 'utf8'));
        await this.postStatus(`Saved ${exportLabel(scope, format)}.`, true);
    }

    private async handlePage(delta: number): Promise<void> {
        const step = delta < 0 ? -1 : 1;
        const nextOffset = this.pageOffset + step * this.pageSize;
        if (nextOffset < 0) {
            return;
        }
        if (step > 0 && !this.result.truncated) {
            await this.postStatus('This is the last page.', true);
            return;
        }
        if (!this.paged && step > 0) {
            await this.postStatus('This query cannot fetch more pages. Only the first page was loaded.', false);
            return;
        }
        await this.reloadQuery(nextOffset, this.pageSize, this.sort, 'Loading page…');
    }

    private async handlePageSize(pageSize: number): Promise<void> {
        const next = clampPageSize(pageSize, this.pageSize);
        if (next === this.pageSize) {
            return;
        }
        await this.reloadQuery(0, next, this.sort, 'Changing page size…');
    }

    private async handleSortBy(col: number): Promise<void> {
        const next = nextSort(this.sort, col);
        if (!this.paged) {
            if (!next) {
                await this.reloadQuery(0, this.pageSize, undefined, 'Clearing sort…');
                return;
            }
            this.sort = next;
            this.result = { ...this.result, sort: next };
            this.sortRowsInMemory();
            this.panel.webview.html = this.getHtml();
            return;
        }
        await this.reloadQuery(0, this.pageSize, next, 'Sorting…');
    }

    private sortRowsInMemory(): void {
        const sort = this.sort;
        if (!sort) {
            return;
        }
        this.rows.sort((left, right) =>
            compareResultCells(left[sort.columnIndex], right[sort.columnIndex], sort.direction, NULL_DISPLAY)
        );
    }

    private applyResult(result: QueryResult): void {
        this.result = result;
        this.draftSql = result.sql;
        this.draftParams = { ...result.params };
        this.columns = [...result.columns];
        this.rows = result.rows.map((row) => [...row]);
        this.pageSize = result.maxRows;
        this.pageOffset = result.pageOffset;
        this.sort = result.sort;
        this.paged = result.paged;
        this.plan = this.buildPlan(result);
        if (!result.paged && this.sort) {
            this.sortRowsInMemory();
        }
        if (result.readOnly) {
            this.panel.title = result.ok ? 'SQL Plan' : 'SQL Plan Error';
        } else {
            this.panel.title = result.ok ? 'SQL Results' : 'SQL Error';
        }
        this.panel.webview.html = this.getHtml();
    }

    public setResult(result: QueryResult): void {
        this.loading = false;
        this.applyResult(result);
    }

    public setTitle(title: string): void {
        this.panel.title = title;
    }

    private async reloadQuery(
        offset: number,
        pageSize: number,
        sort: ResultSort | undefined,
        title: string,
        sql?: string,
        params?: Record<string, string | null>
    ): Promise<void> {
        const querySql = sql ?? this.result.sql;
        const queryParams = params ?? this.result.params;
        if (this.result.readOnly) {
            await this.reloadExplain(querySql, queryParams, title);
            return;
        }
        this.busy = true;
        await this.post({ type: 'busy', busy: true });
        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title,
                    cancellable: true
                },
                async (_progress, token) => {
                    const abort = new AbortController();
                    const sub = token.onCancellationRequested(() => abort.abort());
                    try {
                        return await this.db.executeQuery(querySql, queryParams, {
                            offset,
                            limit: pageSize,
                            sort,
                            signal: abort.signal
                        });
                    } finally {
                        sub.dispose();
                    }
                }
            );
            if (!result.ok) {
                vscode.window.showErrorMessage(result.error ?? 'The query failed.');
                await this.postStatus(result.error ?? 'The query failed.', false);
                return;
            }
            this.applyResult(result);
        } finally {
            this.busy = false;
            await this.post({ type: 'busy', busy: false });
        }
    }

    private async reloadExplain(
        sql: string,
        params: Record<string, string | null>,
        title: string
    ): Promise<void> {
        this.busy = true;
        await this.post({ type: 'busy', busy: true });
        try {
            const explained = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title,
                    cancellable: false
                },
                () => this.db.explainQuery(sql, params)
            );
            this.applyResult(explainResultToQuery(explained, params));
            if (!explained.ok) {
                vscode.window.showErrorMessage(explained.error ?? 'Explain failed.');
                await this.postStatus(explained.error ?? 'Explain failed.', false);
            } else if (explained.note) {
                await this.postStatus(explained.note, true);
            }
        } finally {
            this.busy = false;
            await this.post({ type: 'busy', busy: false });
        }
    }

    private async handleSetNull(row: number, col: number): Promise<void> {
        const column = this.plan.columns[col];
        if (!this.plan.editable || !column?.canSetNull || !column.sourceColumn) {
            await this.postStatus('This cell cannot be set to NULL.', false);
            return;
        }
        const current = this.rowAt(row);
        if (!current) {
            return;
        }
        if (current[col] === NULL_DISPLAY) {
            await this.postStatus('That cell is already NULL.', true);
            return;
        }
        const mutation = buildUpdateSql(this.plan, column.sourceColumn, null, current);
        if ('error' in mutation) {
            await this.postStatus(mutation.error, false);
            return;
        }
        const ok = await this.confirmAndRun(
            'This will set a live database value to NULL.',
            mutation.sql,
            mutation.params,
            true
        );
        if (!ok) {
            return;
        }
        current[col] = NULL_DISPLAY;
        await this.post({ type: 'applied', action: 'setNull', row, col, value: NULL_DISPLAY });
    }

    private async handleEditCell(row: number, col: number, value: string): Promise<void> {
        const column = this.plan.columns[col];
        if (!this.plan.editable || !column?.canEdit || !column.sourceColumn) {
            await this.postStatus('This cell cannot be edited.', false);
            return;
        }
        const current = this.rowAt(row);
        if (!current) {
            return;
        }
        if (current[col] === value) {
            return;
        }
        const mutation = buildUpdateSql(this.plan, column.sourceColumn, value, current);
        if ('error' in mutation) {
            await this.postStatus(mutation.error, false);
            return;
        }
        const ok = await this.confirmAndRun(
            'This will change live data in the database.',
            mutation.sql,
            mutation.params,
            true
        );
        if (!ok) {
            return;
        }
        current[col] = value;
        await this.post({ type: 'applied', action: 'editCell', row, col, value });
    }

    private async handleDeleteRow(row: number): Promise<void> {
        if (!this.plan.editable) {
            await this.postStatus('This result cannot be edited.', false);
            return;
        }
        const current = this.rowAt(row);
        if (!current) {
            return;
        }
        const mutation = buildDeleteSql(this.plan, current);
        if ('error' in mutation) {
            await this.postStatus(mutation.error, false);
            return;
        }
        const ok = await this.confirmAndRun(
            'This will delete a row from the live table.',
            mutation.sql,
            mutation.params,
            true
        );
        if (!ok) {
            return;
        }
        this.rows.splice(row, 1);
        await this.post({ type: 'applied', action: 'deleteRow', row });
    }

    private async handleDuplicateRow(row: number): Promise<void> {
        if (!canDuplicateRow(this.plan)) {
            await this.postStatus('This row cannot be duplicated.', false);
            return;
        }
        const current = this.rowAt(row);
        if (!current) {
            return;
        }
        const mutation = buildInsertSql(this.plan, current);
        if ('error' in mutation) {
            await this.postStatus(mutation.error, false);
            return;
        }
        const ok = await this.confirmAndRun(
            'This will insert a copy of the row into the live table.',
            mutation.sql,
            mutation.params,
            true
        );
        if (!ok) {
            return;
        }
        await this.handleRefresh();
    }

    private async handleRenameColumn(col: number): Promise<void> {
        const column = this.plan.columns[col];
        if (!this.plan.editable || !column?.canRename || !column.sourceColumn) {
            await this.postStatus('This column cannot be renamed.', false);
            return;
        }
        const oldName = column.sourceColumn;
        const newName = await vscode.window.showInputBox({
            title: 'Rename column',
            prompt: `New name for ${oldName} on ${this.plan.tableDisplay}`,
            value: oldName,
            ignoreFocusOut: true
        });
        if (newName === undefined) {
            return;
        }
        const trimmed = newName.trim();
        const built = buildRenameSql(this.plan, oldName, trimmed);
        if ('error' in built) {
            vscode.window.showErrorMessage(built.error);
            return;
        }
        const ok = await this.confirmAndRun(
            'This will rename a real table column. Queries that use the old name will break.',
            built.sql,
            {},
            false
        );
        if (!ok) {
            return;
        }
        this.applyRenameInMemory(oldName, trimmed, col);
        await this.db.refreshSchema();
        await this.post({
            type: 'applied',
            action: 'renameColumn',
            col,
            displayName: trimmed,
            sourceColumn: trimmed
        });
    }

    private applyRenameInMemory(oldName: string, newName: string, col: number): void {
        this.columns[col] = newName;
        const editCol = this.plan.columns[col];
        if (editCol) {
            editCol.displayName = newName;
            editCol.sourceColumn = newName;
        }
        const table = this.plan.table;
        if (!table) {
            return;
        }
        const info = table.columnsByLower.get(oldName.toLowerCase());
        if (!info) {
            return;
        }
        table.columnsByLower.delete(oldName.toLowerCase());
        info.name = newName;
        table.columnsByLower.set(newName.toLowerCase(), info);
    }

    private async handleRefresh(): Promise<void> {
        await this.reloadQuery(
            this.pageOffset,
            this.pageSize,
            this.sort,
            this.result.readOnly ? 'Explaining SQL…' : 'Refreshing SQL…'
        );
    }

    private async confirmAndRun(
        title: string,
        sql: string,
        params: Record<string, string | null>,
        requireOneRow: boolean
    ): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
            title,
            { modal: true, detail: formatMutationPreview(sql, params) },
            'Apply'
        );
        if (choice !== 'Apply') {
            return false;
        }
        return this.runMutation(sql, params, requireOneRow);
    }

    private async runMutation(
        sql: string,
        params: Record<string, string | null>,
        requireOneRow: boolean
    ): Promise<boolean> {
        this.busy = true;
        await this.post({ type: 'busy', busy: true });
        try {
            const result = await this.db.executeQuery(sql, params);
            if (!result.ok) {
                const message = result.error ?? 'The change failed.';
                vscode.window.showErrorMessage(message);
                await this.postStatus(message, false);
                return false;
            }
            if (requireOneRow && result.rowsAffected !== 1) {
                const n = result.rowsAffected;
                const message =
                    n === 0
                        ? 'No row was changed. It may have been deleted or changed already.'
                        : `Expected 1 row, but the database reported ${n ?? 'unknown'} rows. The tab was not updated.`;
                vscode.window.showErrorMessage(message);
                await this.postStatus(message, false);
                return false;
            }
            await this.postStatus('Saved to the database.', true);
            return true;
        } finally {
            this.busy = false;
            await this.post({ type: 'busy', busy: false });
        }
    }

    private rowAt(row: number): string[] | undefined {
        if (!Number.isInteger(row) || row < 0 || row >= this.rows.length) {
            return undefined;
        }
        return this.rows[row];
    }

    private async post(message: ExtToWebview): Promise<void> {
        await this.panel.webview.postMessage(message);
    }

    private async postStatus(message: string, ok: boolean): Promise<void> {
        await this.post({ type: 'status', message, ok });
    }

    private dispose(): void {
        ResultsPanel.openPanels.delete(this);
        if (this.linkedSqlTimer) {
            clearTimeout(this.linkedSqlTimer);
            this.linkedSqlTimer = undefined;
        }
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }

    private gridState(): GridState {
        const count = this.rows.length;
        const rowStart = count === 0 ? 0 : this.pageOffset + 1;
        const rowEnd = this.pageOffset + count;
        const sizes = new Set<number>(PAGE_SIZE_CHOICES);
        sizes.add(this.pageSize);
        return {
            columns: this.columns,
            rows: this.rows,
            edit: {
                editable: this.plan.editable,
                canDuplicate: canDuplicateRow(this.plan),
                detailed: this.detailedMode,
                reason: this.plan.reason,
                tableDisplay: this.plan.tableDisplay,
                columns: this.plan.columns
            },
            pager: {
                page: Math.floor(this.pageOffset / Math.max(1, this.pageSize)) + 1,
                pageSize: this.pageSize,
                hasMore: this.result.truncated,
                hasPrev: this.pageOffset > 0,
                rowStart,
                rowEnd,
                paged: this.paged,
                sortCol: this.sort?.columnIndex ?? -1,
                sortDir: this.sort?.direction ?? '',
                pageSizes: [...sizes].sort((a, b) => a - b)
            }
        };
    }

    private getHtml(): string {
        const nonce = getNonce();
        const result = this.result;
        const stateJson = embedJson(this.gridState());
        const body = this.loading
            ? '<div class="status info">Running SQL… The editor stays usable. Cancel from the progress toast if it hangs.</div><div id="tableHost"></div>'
            : result.ok
              ? renderSuccessShell(result)
              : `<div class="status error">${escapeHtml(result.error ?? 'The query failed.')}</div>`;
        const hasGrid = result.ok && result.columns.length > 0;
        const actions = hasGrid ? renderActions(this.plan, this.detailedMode) : '';
        const pager = hasGrid ? renderPager(this.gridState().pager) : '';
        const infoPop = renderInfoPopover(result, this.plan);

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${result.ok ? 'SQL Results' : 'SQL Error'}</title>
<style nonce="${nonce}">
  :root {
    --radius: 8px;
    --cell-number: var(--vscode-debugTokenExpression-number, var(--vscode-charts-blue, #4fc1ff));
    --cell-string: var(--vscode-debugTokenExpression-string, var(--vscode-charts-orange, #ce9178));
    --cell-bool: var(--vscode-debugTokenExpression-boolean, var(--vscode-charts-purple, #c586c0));
    --cell-date: var(--vscode-charts-green, #3fb950);
    --cell-id: var(--vscode-charts-yellow, #dcdcaa);
    --cell-null: var(--vscode-disabledForeground, #6e7681);
    --sql-kw: var(--vscode-symbolIcon-keywordForeground, #569cd6);
    --sql-fn: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
    --accent: var(--vscode-charts-blue, #3794ff);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 18px 32px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  .topbar {
    display: flex; flex-wrap: wrap; gap: 10px 14px;
    align-items: center; justify-content: space-between;
    margin: 0 0 12px;
  }
  .title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .title-mark {
    display: grid; place-items: center; flex: none;
    width: 26px; height: 26px; border-radius: 7px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
  }
  .title-mark .icon { width: 15px; height: 15px; }
  h1 { margin: 0; font-size: 1.1rem; font-weight: 600; letter-spacing: -0.02em; }
  .info-wrap { position: relative; }
  .info-pop {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 8;
    min-width: 260px; max-width: 360px; padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
  }
  .info-pop p { margin: 0 0 8px; font-size: 0.82rem; line-height: 1.4; }
  .info-pop p:last-child { margin: 0; }
  .info-pop .k {
    display: block; margin: 0 0 2px;
    font-size: 0.7rem; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.65;
  }
  .icon {
    display: block; width: 16px; height: 16px; flex: none;
  }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .toolbar-split {
    width: 1px; align-self: stretch; min-height: 20px;
    background: var(--vscode-widget-border, transparent);
  }
  .export-label { display: flex; align-items: center; }
  select {
    font: inherit; padding: 5px 8px; border-radius: 4px;
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, transparent));
  }
  button {
    font: inherit; padding: 6px 12px; border-radius: 4px;
    border: 1px solid transparent; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0;
    color: inherit; background: transparent;
  }
  button.icon-btn:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  button.secondary[aria-pressed="true"] {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .sql-box {
    position: relative; margin: 0 0 12px; border-radius: var(--radius);
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .sql-bar { display: flex; align-items: center; gap: 2px; padding-right: 6px; }
  .sql-toggle {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; text-align: left; background: transparent; color: inherit;
  }
  .sql-toggle:hover { background: var(--vscode-list-hoverBackground, transparent); }
  .sql-toggle .chevron { display: inline-flex; transition: transform 0.12s ease; }
  .sql-box.open .chevron { transform: rotate(90deg); }
  .sql-name { font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.7; }
  .sql-preview {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    opacity: 0.65; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.8rem;
  }
  .sql-box.open .sql-preview { display: none; }
  .sql-body { display: none; padding: 0 10px 10px; }
  .sql-box.open .sql-body { display: block; }
  .sql {
    margin: 0; padding: 10px 12px; max-height: 280px; overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    line-height: 1.45; tab-size: 4;
    white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
    border-radius: 6px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    color: var(--vscode-editor-foreground);
  }
  .sql .kw, .sql-preview .kw { color: var(--sql-kw); font-weight: 650; }
  .sql .fn, .sql-preview .fn { color: var(--sql-fn); }
  .sql .str, .sql-preview .str { color: var(--cell-string); }
  .sql .num, .sql-preview .num { color: var(--cell-number); }
  .sql .cm, .sql-preview .cm { color: var(--vscode-descriptionForeground); font-style: italic; opacity: 0.88; }
  .sql .param, .sql-preview .param { color: var(--cell-id); }
  .params { margin: 10px 0 0; padding: 0; list-style: none; font-size: 0.85rem; }
  .params[hidden] { display: none; }
  .param-row {
    display: flex; align-items: center; gap: 8px; margin: 0 0 6px;
  }
  .param-row label {
    flex: none; min-width: 5.5rem; font-family: var(--vscode-editor-font-family, monospace);
  }
  .param-input {
    flex: 1; min-width: 0; padding: 4px 8px; font: inherit;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 4px;
  }
  .params .param { color: var(--cell-id); }
  .label { font-size: 0.75rem; opacity: 0.7; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  .status {
    margin: 0 0 12px; padding: 10px 12px; border-radius: var(--radius); line-height: 1.45;
  }
  .status.error {
    color: var(--vscode-errorForeground);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 14%, transparent);
  }
  .status.info {
    background: var(--vscode-inputValidation-infoBackground, transparent);
  }
  .status.ok {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 18%, transparent);
  }
  .table-wrap {
    overflow: auto; max-height: calc(100vh - 220px);
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
    border-radius: var(--radius);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--accent) 18%, transparent);
  }
  table { border-collapse: collapse; width: max-content; min-width: 100%; }
  th, td {
    padding: 6px 10px; border-bottom: 1px solid var(--vscode-widget-border, transparent);
    border-right: 1px solid var(--vscode-widget-border, transparent);
    vertical-align: middle; text-align: left; white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85rem; max-width: 480px;
  }
  td { overflow: hidden; }
  .cell-inner {
    display: flex; align-items: center; gap: 4px; min-width: 0;
  }
  .cell-text {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  td.cell-number .cell-inner { justify-content: flex-end; }
  td.cell-number .cell-text { flex: 0 1 auto; }
  button.icon-btn.cell-expand {
    flex: none; width: 22px; height: 22px; padding: 0; opacity: 0.8;
  }
  button.icon-btn.cell-expand .icon { width: 12px; height: 12px; }
  button.icon-btn.cell-expand:hover { opacity: 1; }
  th {
    position: sticky; top: 0; z-index: 1;
    background: color-mix(in srgb, var(--accent) 12%, var(--vscode-sideBar-background, var(--vscode-editor-background)));
    border-bottom: 2px solid color-mix(in srgb, var(--accent) 50%, transparent);
    font-weight: 600; cursor: pointer;
  }
  .col-name { display: flex; align-items: center; gap: 6px; }
  .type-dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: none;
    background: var(--vscode-descriptionForeground); opacity: 0.7;
  }
  th.kind-number .type-dot { background: var(--cell-number); opacity: 1; }
  th.kind-string .type-dot { background: var(--cell-string); opacity: 1; }
  th.kind-bool .type-dot { background: var(--cell-bool); opacity: 1; }
  th.kind-date .type-dot { background: var(--cell-date); opacity: 1; }
  th.kind-id .type-dot { background: var(--cell-id); opacity: 1; }
  .col-meta {
    display: none; margin-top: 3px;
    font-weight: 400; font-size: 0.7rem; line-height: 1.3; opacity: 0.7;
    white-space: normal; max-width: 220px;
  }
  body.detailed .col-meta { display: block; }
  body.detailed th { vertical-align: bottom; }
  td { cursor: pointer; }
  td.locked, th.locked { opacity: 0.78; }
  td:not(.locked) { cursor: text; }
  td.pk { font-weight: 600; box-shadow: inset 2px 0 0 var(--cell-id); }
  tbody tr:nth-child(even) td {
    background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
  }
  tr:hover td { background: var(--vscode-list-hoverBackground, transparent); }
  td.cell-number { color: var(--cell-number); text-align: right; font-variant-numeric: tabular-nums; }
  td.cell-string { color: var(--cell-string); }
  td.cell-bool { color: var(--cell-bool); font-weight: 600; }
  td.cell-date { color: var(--cell-date); }
  td.cell-id { color: var(--cell-id); }
  td.null {
    color: var(--cell-null); opacity: 1; font-style: italic; font-weight: 400;
  }
  td.selected, th.selected {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground, transparent));
  }
  tr.selected td { background: color-mix(in srgb, var(--accent) 10%, var(--vscode-list-hoverBackground, transparent)); }
  td.editing { padding: 2px; }
  td.editing input {
    width: 100%; min-width: 80px; padding: 4px 6px; font: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder); border-radius: 2px;
  }
  th.sorted { color: var(--vscode-textLink-foreground); }
  .sort-mark { opacity: 0.85; font-size: 0.75rem; }
  .pager {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    margin: 0 0 12px; padding: 8px 10px; border-radius: var(--radius);
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
  }
  .pager .page-label { font-size: 0.85rem; min-width: 8rem; }
  body.busy .table-wrap { opacity: 0.7; pointer-events: none; }
  .ctx-menu {
    position: fixed; z-index: 20; min-width: 188px; padding: 4px;
    border-radius: 6px;
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent));
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  }
  .ctx-menu[hidden] { display: none; }
  .ctx-menu button {
    display: flex; width: 100%; align-items: center; gap: 8px;
    padding: 6px 10px; border: 0; border-radius: 4px; text-align: left;
    background: transparent; color: var(--vscode-menu-foreground, inherit);
  }
  .ctx-menu button:hover:not(:disabled) {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-menu-selectionForeground, inherit);
  }
  .ctx-menu button:disabled { opacity: 0.45; }
  .ctx-sep {
    height: 1px; margin: 4px 6px;
    background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border, transparent));
  }
  .viewer {
    display: none; position: fixed; inset: 0; z-index: 30;
    align-items: center; justify-content: center; padding: 24px;
    background: color-mix(in srgb, var(--vscode-editor-background) 55%, rgba(0, 0, 0, 0.35));
  }
  .viewer.open { display: flex; }
  .viewer-panel {
    display: flex; flex-direction: column; width: min(920px, 100%);
    max-height: min(80vh, 720px); min-height: 180px;
    border-radius: var(--radius);
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }
  .viewer-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  .viewer-title {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600;
  }
  .viewer-actions { display: flex; align-items: center; gap: 6px; flex: none; }
  .viewer-body {
    margin: 0; padding: 12px; overflow: auto; flex: 1; min-height: 0;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85rem;
  }
  .viewer-body > pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
  }
  .viewer-field { margin: 0 0 14px; }
  .viewer-field:last-child { margin: 0; }
  .viewer-key {
    margin: 0 0 4px; font-size: 0.72rem; letter-spacing: 0.04em;
    text-transform: uppercase; opacity: 0.65;
  }
  .viewer-val { margin: 0; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body class="${this.detailedMode ? 'detailed' : ''}">
  <div class="topbar">
    <div class="title-row">
      <span class="title-mark">${icon('table')}</span>
  <h1>${this.loading ? 'Running SQL' : result.ok ? 'Query results' : 'Query failed'}</h1>
      <div class="info-wrap">
        <button type="button" class="icon-btn" id="btnInfo" aria-expanded="false" title="Query info">${icon('info')}</button>
        ${infoPop}
      </div>
    </div>
    ${actions}
  </div>
  ${renderSqlBlock(this.draftSql || result.sql, this.draftParams, this.sqlOpen)}
  ${pager}
  <div class="status" id="liveStatus" hidden></div>
  ${body}
  <div class="ctx-menu" id="ctxMenu" hidden>
    <button type="button" data-act="edit">Edit cell</button>
    <button type="button" data-act="null">Set NULL</button>
    <button type="button" data-act="duplicate">Duplicate row</button>
    <button type="button" data-act="delete">Delete row</button>
    <div class="ctx-sep"></div>
    <button type="button" data-act="viewCell">View cell</button>
    <button type="button" data-act="viewRow">View row</button>
    <button type="button" data-act="copyCell">Copy cell</button>
    <button type="button" data-act="copyRow">Copy row</button>
  </div>
  <div class="viewer" id="cellViewer">
    <div class="viewer-panel" role="dialog" aria-modal="true" aria-labelledby="viewerTitle">
      <div class="viewer-bar">
        <span class="viewer-title" id="viewerTitle">Cell</span>
        <div class="viewer-actions">
          <button type="button" class="secondary" id="viewerToggle">View row</button>
          <button type="button" class="icon-btn" id="viewerCopy" title="Copy">${icon('copy')}</button>
          <button type="button" class="icon-btn" id="viewerClose" title="Close">${icon('close')}</button>
        </div>
      </div>
      <div class="viewer-body" id="viewerBody"></div>
    </div>
  </div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const NULL_DISPLAY = ${embedJson(NULL_DISPLAY)};
  const EXPAND_ICON = ${JSON.stringify(icon('expand'))};
  const CELL_PREVIEW_LEN = 160;
  let state = ${stateJson};
  let selected = { row: -1, col: -1 };
  let busy = false;
  let editing = false;
  let detailed = !!(state.edit && state.edit.detailed);
  let viewer = { open: false, mode: 'cell', row: -1, col: -1 };

  const host = document.getElementById('tableHost');
  const sqlBox = document.getElementById('sqlBox');
  const btnSqlToggle = document.getElementById('btnSqlToggle');
  const btnCopySql = document.getElementById('btnCopySql');
  const btnRunSql = document.getElementById('btnRunSql');
  const btnEditSql = document.getElementById('btnEditSql');
  const sqlText = document.getElementById('sqlText');
  const sqlPreview = document.getElementById('sqlPreview');
  const paramList = document.getElementById('paramList');
  const paramLabel = document.getElementById('paramLabel');
  const btnInfo = document.getElementById('btnInfo');
  const infoPop = document.getElementById('infoPop');
  const btnNull = document.getElementById('btnNull');
  const btnDelete = document.getElementById('btnDelete');
  const btnDuplicate = document.getElementById('btnDuplicate');
  const btnRename = document.getElementById('btnRename');
  const btnDetailed = document.getElementById('btnDetailed');
  const btnRefresh = document.getElementById('btnRefresh');
  const ctxMenu = document.getElementById('ctxMenu');
  const exportScope = document.getElementById('exportScope');
  const exportFormat = document.getElementById('exportFormat');
  const btnCopy = document.getElementById('btnCopy');
  const btnSave = document.getElementById('btnSave');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const pageSize = document.getElementById('pageSize');
  const liveStatus = document.getElementById('liveStatus');
  const cellViewer = document.getElementById('cellViewer');
  const viewerTitle = document.getElementById('viewerTitle');
  const viewerBody = document.getElementById('viewerBody');
  const viewerToggle = document.getElementById('viewerToggle');
  const viewerCopy = document.getElementById('viewerCopy');
  const viewerClose = document.getElementById('viewerClose');

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function readParamValues() {
    const values = {};
    if (!paramList) return values;
    paramList.querySelectorAll('.param-input').forEach((input) => {
      const name = input.getAttribute('data-name');
      if (!name) return;
      values[name] = input.value === '' ? null : input.value;
    });
    return values;
  }

  function renderParamFields(params) {
    if (!paramList) return;
    const names = Object.keys(params || {});
    if (names.length === 0) {
      paramList.innerHTML = '';
      paramList.hidden = true;
      if (paramLabel) paramLabel.hidden = true;
      return;
    }
    paramList.hidden = false;
    if (paramLabel) paramLabel.hidden = false;
    paramList.innerHTML = names.map((name) => {
      const current = params[name];
      const shown = current === null || current === undefined ? '' : current;
      return '<div class="param-row"><label><span class="param">:' + escapeHtml(name) +
        '</span></label><input class="param-input" data-name="' + escapeHtml(name) +
        '" value="' + escapeHtml(shown) + '" placeholder="NULL" spellcheck="false" /></div>';
    }).join('');
  }

  function applySqlDraft(msg) {
    if (sqlPreview && typeof msg.previewHtml === 'string') sqlPreview.innerHTML = msg.previewHtml;
    if (sqlText && typeof msg.sqlHtml === 'string') sqlText.innerHTML = msg.sqlHtml;
    if (msg.params && typeof msg.params === 'object') renderParamFields(msg.params);
  }

  function runEditorSql() {
    if (busy) return;
    setSqlOpen(true);
    vscode.postMessage({ type: 'runQuery', params: readParamValues() });
  }

  function colMeta(col) {
    return (state.edit && state.edit.columns && state.edit.columns[col]) || {};
  }

  function columnDetailLine(meta) {
    const bits = [];
    if (meta.typeDisplay) bits.push(meta.typeDisplay);
    else if (meta.typeName) bits.push(meta.typeName);
    if (meta.isPrimaryKey) bits.push('PK');
    if (meta.isIdentity) bits.push('identity');
    if (meta.isComputed) bits.push('computed');
    if (meta.sourceColumn) bits.push(meta.isNullable ? 'NULL' : 'NOT NULL');
    return bits.join(' · ');
  }

  function typeKind(typeName) {
    const t = String(typeName || '').toLowerCase();
    if (/uniqueidentifier|uuid|guid/.test(t)) return 'id';
    if (/^(rowversion|timestamp)$/.test(t)) return 'id';
    if (/\\b(bit|bool)/.test(t)) return 'bool';
    if (/date|time/.test(t)) return 'date';
    if (/int|decimal|numeric|float|real|money|double|number|smallmoney/.test(t)) return 'number';
    if (/binary|varbinary|blob|image/.test(t)) return 'id';
    if (/char|text|json|xml|enum|set|clob/.test(t)) return 'string';
    return '';
  }

  function inferKind(value) {
    const v = String(value).trim();
    if (/^(true|false)$/i.test(v)) return 'bool';
    if (/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/.test(v)) return 'number';
    if (/^\\d{4}-\\d{2}-\\d{2}([ tT]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$/.test(v)) return 'date';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'id';
    return 'string';
  }

  function valueKind(typeName, value) {
    return typeKind(typeName) || inferKind(value);
  }

  function cellPreview(value) {
    // One line in the grid; the full value stays in state.rows for the viewer.
    const oneLine = String(value).replace(/[\\r\\n\\t]+/g, ' ');
    if (oneLine.length > CELL_PREVIEW_LEN) return oneLine.slice(0, CELL_PREVIEW_LEN) + '…';
    return oneLine;
  }

  function needsExpand(value) {
    const text = String(value);
    if (text === NULL_DISPLAY) return false;
    return /[\\r\\n]/.test(text) || text.length > 80;
  }

  function formatFullValue(value) {
    if (value === NULL_DISPLAY) return value;
    const text = String(value);
    const trimmed = text.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch (err) {}
    }
    return text;
  }

  function expandButtonHtml() {
    return '<button type="button" class="cell-expand icon-btn" data-view="cell" title="View full cell">' +
      EXPAND_ICON + '</button>';
  }

  function markOverflowCells() {
    if (!host) return;
    host.querySelectorAll('td[data-row]').forEach((td) => {
      if (td.querySelector('.cell-expand')) return;
      const textEl = td.querySelector('.cell-text');
      if (!textEl || textEl.scrollWidth <= textEl.clientWidth + 1) return;
      const inner = td.querySelector('.cell-inner');
      if (!inner) return;
      inner.insertAdjacentHTML('beforeend', expandButtonHtml());
    });
  }

  function closeViewer() {
    viewer.open = false;
    if (cellViewer) cellViewer.classList.remove('open');
  }

  function renderViewer() {
    if (!cellViewer || !viewerTitle || !viewerBody || !viewerToggle) return;
    const row = state.rows[viewer.row];
    if (!row) {
      closeViewer();
      return;
    }
    if (viewer.mode === 'row') {
      viewerTitle.textContent = 'Row ' + (viewer.row + 1);
      viewerToggle.textContent = 'View cell';
      viewerToggle.disabled = viewer.col < 0;
      viewerBody.innerHTML = state.columns.map((name, i) => {
        return '<div class="viewer-field"><div class="viewer-key">' + escapeHtml(name) +
          '</div><pre class="viewer-val">' + escapeHtml(formatFullValue(row[i])) + '</pre></div>';
      }).join('');
    } else {
      const name = state.columns[viewer.col] || 'Cell';
      viewerTitle.textContent = name;
      viewerToggle.textContent = 'View row';
      viewerToggle.disabled = false;
      viewerBody.innerHTML = '<pre>' + escapeHtml(formatFullValue(row[viewer.col])) + '</pre>';
    }
    cellViewer.classList.add('open');
    viewer.open = true;
  }

  function openViewer(mode, row, col) {
    hideCtxMenu();
    setInfoOpen(false);
    viewer = { open: true, mode: mode, row: row, col: col };
    renderViewer();
  }

  let paintedRows = 0;
  const ROW_BATCH = 80;

  function renderTable(resetPaint) {
    if (!host) return;
    closeViewer();
    const prevWrap = host.querySelector('.table-wrap');
    const keepTop = prevWrap ? prevWrap.scrollTop : 0;
    const keepLeft = prevWrap ? prevWrap.scrollLeft : 0;
    if (!state.columns || state.columns.length === 0) {
      host.innerHTML = '';
      return;
    }
    if (resetPaint === true || paintedRows === 0) {
      paintedRows = Math.min(ROW_BATCH, state.rows.length);
    }
    const head = state.columns.map((name, col) => {
      const meta = colMeta(col);
      const sorted = state.pager && state.pager.sortCol === col;
      const kind = typeKind(meta.typeName || meta.typeDisplay);
      const cls = [
        meta.canEdit ? '' : 'locked',
        col === selected.col ? 'selected' : '',
        sorted ? 'sorted' : '',
        kind ? 'kind-' + kind : ''
      ].filter(Boolean).join(' ');
      const mark = sorted ? (state.pager.sortDir === 'DESC' ? ' ▼' : ' ▲') : '';
      const detail = columnDetailLine(meta);
      const title = sorted
        ? 'Sorted ' + state.pager.sortDir + ' — click to change'
        : (detail || (meta.sourceColumn && meta.sourceColumn !== name
          ? 'Column ' + meta.sourceColumn
          : 'Click to sort'));
      return '<th data-col="' + col + '" class="' + cls + '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' +
        '<span class="col-name">' +
        (kind ? '<span class="type-dot"></span>' : '') +
        escapeHtml(name) +
        (meta.isPrimaryKey ? ' (PK)' : '') +
        '<span class="sort-mark">' + mark + '</span></span>' +
        (detail ? '<span class="col-meta">' + escapeHtml(detail) + '</span>' : '') +
        '</th>';
    }).join('');
    let body;
    if (state.rows.length === 0) {
      body = '<tr><td colspan="' + state.columns.length + '" class="null">No rows</td></tr>';
    } else {
      const visible = state.rows.slice(0, paintedRows);
      body = visible.map((row, r) => {
        const cells = row.map((cell, c) => {
          const meta = colMeta(c);
          const isNull = cell === NULL_DISPLAY;
          const kind = isNull ? 'null' : valueKind(meta.typeName || meta.typeDisplay, cell);
          const classes = [
            isNull ? 'null' : 'cell-' + kind,
            meta.canEdit ? '' : 'locked',
            meta.isPrimaryKey ? 'pk' : '',
            selected.row === r && selected.col === c ? 'selected' : ''
          ].filter(Boolean).join(' ');
          const editHint = state.edit && state.edit.editable && meta.canEdit
            ? 'Click again or press Enter to edit'
            : '';
          const preview = cellPreview(cell);
          const expand = needsExpand(cell) ? expandButtonHtml() : '';
          return '<td data-row="' + r + '" data-col="' + c + '" class="' + classes + '"' +
            (editHint ? ' title="' + editHint + '"' : '') + '>' +
            '<span class="cell-inner"><span class="cell-text">' + escapeHtml(preview) +
            '</span>' + expand + '</span></td>';
        }).join('');
        const trClass = selected.row === r ? ' class="selected"' : '';
        return '<tr' + trClass + '>' + cells + '</tr>';
      }).join('');
    }
    host.innerHTML = '<div class="table-wrap"><table><thead><tr>' + head +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
    const wrap = host.querySelector('.table-wrap');
    if (wrap && paintedRows < state.rows.length) {
      if (wrap.scrollHeight <= wrap.clientHeight + 4) {
        requestAnimationFrame(() => {
          paintedRows = Math.min(state.rows.length, paintedRows + ROW_BATCH);
          renderTable(false);
        });
      } else {
        wrap.addEventListener('scroll', () => {
          if (paintedRows >= state.rows.length) return;
          if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 80) return;
          paintedRows = Math.min(state.rows.length, paintedRows + ROW_BATCH);
          renderTable(false);
        }, { once: true });
      }
    }
    if (wrap) {
      wrap.scrollTop = keepTop;
      wrap.scrollLeft = keepLeft;
    }
    markOverflowCells();
  }

  function currentScope() {
    return exportScope ? exportScope.value : 'table';
  }

  function currentFormat() {
    return exportFormat ? exportFormat.value : 'json';
  }

  function exportEnabled() {
    if (busy) return false;
    const scope = currentScope();
    if (scope === 'row') return selected.row >= 0;
    if (scope === 'cell') return selected.row >= 0 && selected.col >= 0;
    return true;
  }

  function setInfoOpen(open) {
    if (!infoPop || !btnInfo) return;
    infoPop.hidden = !open;
    btnInfo.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setSqlOpen(open) {
    if (!sqlBox || !btnSqlToggle) return;
    sqlBox.classList.toggle('open', open);
    btnSqlToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    vscode.postMessage({ type: 'setSqlOpen', on: !!open });
  }

  function updateToolbar() {
    const editable = !!(state.edit && state.edit.editable);
    const meta = selected.col >= 0 ? colMeta(selected.col) : {};
    if (btnNull) btnNull.disabled = busy || !editable || selected.row < 0 || !meta.canSetNull;
    if (btnDelete) btnDelete.disabled = busy || !editable || selected.row < 0;
    if (btnDuplicate) {
      btnDuplicate.disabled = busy || !editable || selected.row < 0 || !state.edit.canDuplicate;
    }
    if (btnRename) btnRename.disabled = busy || !editable || selected.col < 0 || !meta.canRename;
    if (btnDetailed) btnDetailed.setAttribute('aria-pressed', detailed ? 'true' : 'false');
    if (btnRefresh) btnRefresh.disabled = busy;
    if (btnRunSql) btnRunSql.disabled = busy;
    if (exportScope) {
      const optRow = exportScope.querySelector('option[value="row"]');
      const optCell = exportScope.querySelector('option[value="cell"]');
      if (optRow) optRow.disabled = selected.row < 0;
      if (optCell) optCell.disabled = selected.row < 0 || selected.col < 0;
      if (currentScope() === 'row' && selected.row < 0) exportScope.value = 'table';
      if (currentScope() === 'cell' && (selected.row < 0 || selected.col < 0)) exportScope.value = 'table';
    }
    const canExport = exportEnabled();
    if (btnCopy) btnCopy.disabled = !canExport;
    if (btnSave) btnSave.disabled = !canExport;
    if (btnPrev) btnPrev.disabled = busy || !(state.pager && state.pager.hasPrev);
    if (btnNext) btnNext.disabled = busy || !(state.pager && state.pager.hasMore);
    if (pageSize) pageSize.disabled = busy;
  }

  function postExport(kind, scope) {
    vscode.postMessage({
      type: kind,
      scope: scope || currentScope(),
      format: currentFormat(),
      row: selected.row,
      col: selected.col
    });
  }

  let ctxJustOpened = false;

  function hideCtxMenu() {
    if (ctxMenu) ctxMenu.hidden = true;
  }

  function showCtxMenu(x, y) {
    if (!ctxMenu) return;
    const editable = !!(state.edit && state.edit.editable);
    const meta = selected.col >= 0 ? colMeta(selected.col) : {};
    const byAct = (act) => ctxMenu.querySelector('[data-act="' + act + '"]');
    const btnEdit = byAct('edit');
    const btnSetNull = byAct('null');
    const btnDup = byAct('duplicate');
    const btnDel = byAct('delete');
    const btnCopyCell = byAct('copyCell');
    const btnCopyRow = byAct('copyRow');
    const btnViewCell = byAct('viewCell');
    const btnViewRow = byAct('viewRow');
    if (btnEdit) btnEdit.disabled = busy || !editable || !meta.canEdit;
    if (btnSetNull) btnSetNull.disabled = busy || !editable || !meta.canSetNull;
    if (btnDup) btnDup.disabled = busy || !editable || !state.edit.canDuplicate;
    if (btnDel) btnDel.disabled = busy || !editable;
    if (btnCopyCell) btnCopyCell.disabled = busy || selected.col < 0;
    if (btnCopyRow) btnCopyRow.disabled = busy;
    if (btnViewCell) btnViewCell.disabled = busy || selected.col < 0;
    if (btnViewRow) btnViewRow.disabled = busy;
    ctxMenu.hidden = false;
    const pad = 8;
    const nextX = Math.min(x, window.innerWidth - ctxMenu.offsetWidth - pad);
    const nextY = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - pad);
    ctxMenu.style.left = Math.max(pad, nextX) + 'px';
    ctxMenu.style.top = Math.max(pad, nextY) + 'px';
    ctxJustOpened = true;
    setTimeout(() => { ctxJustOpened = false; }, 0);
  }

  function setStatus(message, ok) {
    if (!liveStatus) return;
    if (!message) {
      liveStatus.hidden = true;
      liveStatus.textContent = '';
      return;
    }
    liveStatus.hidden = false;
    liveStatus.textContent = message;
    liveStatus.className = 'status ' + (ok ? 'ok' : 'error');
  }

  function applySelection() {
    if (!host) return;
    host.querySelectorAll('td.selected, th.selected, tr.selected').forEach((el) => {
      el.classList.remove('selected');
    });
    if (selected.col >= 0) {
      const th = host.querySelector('th[data-col="' + selected.col + '"]');
      if (th) th.classList.add('selected');
    }
    if (selected.row >= 0) {
      const first = host.querySelector('td[data-row="' + selected.row + '"]');
      if (first && first.parentElement) first.parentElement.classList.add('selected');
      if (selected.col >= 0) {
        const td = host.querySelector(
          'td[data-row="' + selected.row + '"][data-col="' + selected.col + '"]'
        );
        if (td) td.classList.add('selected');
      }
    }
  }

  function selectCell(row, col) {
    selected = { row: row, col: col };
    applySelection();
    updateToolbar();
  }

  function startEdit(td, row, col) {
    const meta = colMeta(col);
    if (busy || editing) return;
    if (!state.edit || !state.edit.editable) {
      setStatus((state.edit && state.edit.reason) || 'This result is read only.', false);
      return;
    }
    if (!meta.canEdit) {
      if (meta.isPrimaryKey) setStatus('The primary key cannot be edited.', false);
      else if (meta.isIdentity) setStatus('Identity columns cannot be edited.', false);
      else if (meta.isComputed) setStatus('Computed columns cannot be edited.', false);
      else setStatus('This cell cannot be edited.', false);
      return;
    }
    setStatus('', true);
    closeViewer();
    const original = state.rows[row][col];
    editing = true;
    td.classList.add('editing');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = original === NULL_DISPLAY ? '' : original;
    td.textContent = '';
    td.appendChild(input);
    input.focus({ preventScroll: true });
    input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      editing = false;
      const next = input.value;
      renderTable();
      if (save && next !== original && !(original === NULL_DISPLAY && next === '')) {
        vscode.postMessage({ type: 'editCell', row: row, col: col, value: next });
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  if (host) {
    host.addEventListener('click', (event) => {
      if (event.target.closest('input')) return;
      const expandBtn = event.target.closest('[data-view]');
      if (expandBtn) {
        const td = expandBtn.closest('td');
        if (!td || !td.hasAttribute('data-row')) return;
        const row = Number(td.getAttribute('data-row'));
        const col = Number(td.getAttribute('data-col'));
        selectCell(row, col);
        openViewer('cell', row, col);
        return;
      }
      const th = event.target.closest('th');
      if (th && host.contains(th)) {
        const col = Number(th.getAttribute('data-col'));
        selectCell(-1, col);
        vscode.postMessage({ type: 'sortBy', col: col });
        return;
      }
      const td = event.target.closest('td');
      if (!td || !td.hasAttribute('data-row')) return;
      const row = Number(td.getAttribute('data-row'));
      const col = Number(td.getAttribute('data-col'));
      if (selected.row === row && selected.col === col) {
        startEdit(td, row, col);
        return;
      }
      selectCell(row, col);
    });
    host.addEventListener('contextmenu', (event) => {
      const td = event.target.closest('td');
      if (!td || !td.hasAttribute('data-row')) return;
      event.preventDefault();
      if (editing) return;
      selectCell(Number(td.getAttribute('data-row')), Number(td.getAttribute('data-col')));
      showCtxMenu(event.clientX, event.clientY);
    });
    host.addEventListener('dblclick', (event) => {
      if (event.target.closest('input')) return;
      if (event.target.closest('[data-view]')) return;
      const td = event.target.closest('td');
      if (!td || !td.hasAttribute('data-row')) return;
      startEdit(td, Number(td.getAttribute('data-row')), Number(td.getAttribute('data-col')));
    });
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      if (sqlBox && sqlBox.contains(event.target)) {
        event.preventDefault();
        runEditorSql();
        return;
      }
    }
    if (event.key === 'Escape' && viewer.open) {
      closeViewer();
      return;
    }
    if (event.key === 'Escape' && ctxMenu && !ctxMenu.hidden) {
      hideCtxMenu();
      return;
    }
    if (event.key === 'Escape' && infoPop && !infoPop.hidden) {
      setInfoOpen(false);
      return;
    }
    if (event.target && event.target.classList && event.target.classList.contains('param-input')) {
      return;
    }
    if (editing || busy || viewer.open) return;
    if (event.key === 'Enter' && selected.row >= 0 && selected.col >= 0) {
      const td = host && host.querySelector('td.selected');
      if (td) startEdit(td, selected.row, selected.col);
    }
    if (event.key === 'Delete' && selected.row >= 0 && btnDelete && !btnDelete.disabled) {
      vscode.postMessage({ type: 'deleteRow', row: selected.row });
    }
  });

  if (btnInfo && infoPop) {
    btnInfo.addEventListener('click', (event) => {
      event.stopPropagation();
      setInfoOpen(infoPop.hidden);
    });
    document.addEventListener('click', (event) => {
      if (infoPop.hidden) return;
      const wrap = btnInfo.closest('.info-wrap');
      if (wrap && wrap.contains(event.target)) return;
      setInfoOpen(false);
    });
  }
  if (btnSqlToggle) {
    btnSqlToggle.addEventListener('click', () => {
      setSqlOpen(!sqlBox || !sqlBox.classList.contains('open'));
    });
  }
  if (btnCopySql) {
    btnCopySql.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'copySql' });
    });
  }
  if (btnRunSql) {
    btnRunSql.addEventListener('click', (event) => {
      event.stopPropagation();
      runEditorSql();
    });
  }
  if (btnEditSql) {
    btnEditSql.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'editInEditor' });
    });
  }
  if (paramList) {
    paramList.addEventListener('input', () => {
      vscode.postMessage({ type: 'setParams', params: readParamValues() });
    });
  }
  if (btnNull) btnNull.addEventListener('click', () => {
    vscode.postMessage({ type: 'setNull', row: selected.row, col: selected.col });
  });
  if (btnDelete) btnDelete.addEventListener('click', () => {
    vscode.postMessage({ type: 'deleteRow', row: selected.row });
  });
  if (btnDuplicate) btnDuplicate.addEventListener('click', () => {
    vscode.postMessage({ type: 'duplicateRow', row: selected.row });
  });
  if (btnDetailed) {
    btnDetailed.addEventListener('click', () => {
      detailed = !detailed;
      document.body.classList.toggle('detailed', detailed);
      btnDetailed.setAttribute('aria-pressed', detailed ? 'true' : 'false');
      vscode.postMessage({ type: 'setDetailed', on: detailed });
    });
  }
  if (btnRename) btnRename.addEventListener('click', () => {
    vscode.postMessage({ type: 'renameColumn', col: selected.col });
  });
  if (ctxMenu) {
    ctxMenu.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.getAttribute('data-act');
      hideCtxMenu();
      if (act === 'edit') {
        const td = host && host.querySelector('td.selected');
        if (td) startEdit(td, selected.row, selected.col);
        return;
      }
      if (act === 'null') {
        vscode.postMessage({ type: 'setNull', row: selected.row, col: selected.col });
        return;
      }
      if (act === 'duplicate') {
        vscode.postMessage({ type: 'duplicateRow', row: selected.row });
        return;
      }
      if (act === 'delete') {
        vscode.postMessage({ type: 'deleteRow', row: selected.row });
        return;
      }
      if (act === 'viewCell') {
        openViewer('cell', selected.row, selected.col);
        return;
      }
      if (act === 'viewRow') {
        openViewer('row', selected.row, selected.col);
        return;
      }
      if (act === 'copyCell') {
        postExport('copyExport', 'cell');
        return;
      }
      if (act === 'copyRow') {
        postExport('copyExport', 'row');
        return;
      }
    });
  }
  document.addEventListener('click', (event) => {
    if (ctxJustOpened || !ctxMenu || ctxMenu.hidden) return;
    if (ctxMenu.contains(event.target)) return;
    hideCtxMenu();
  });
  document.addEventListener('scroll', hideCtxMenu, true);
  if (viewerClose) viewerClose.addEventListener('click', closeViewer);
  if (viewerToggle) {
    viewerToggle.addEventListener('click', () => {
      if (!viewer.open) return;
      viewer.mode = viewer.mode === 'cell' ? 'row' : 'cell';
      renderViewer();
    });
  }
  if (viewerCopy) {
    viewerCopy.addEventListener('click', () => {
      if (!viewer.open) return;
      postExport('copyExport', viewer.mode);
    });
  }
  if (cellViewer) {
    cellViewer.addEventListener('click', (event) => {
      if (event.target === cellViewer) closeViewer();
    });
  }
  if (btnRefresh) btnRefresh.addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
  if (exportScope) exportScope.addEventListener('change', updateToolbar);
  if (btnCopy) btnCopy.addEventListener('click', () => postExport('copyExport'));
  if (btnSave) btnSave.addEventListener('click', () => postExport('saveExport'));
  if (btnPrev) btnPrev.addEventListener('click', () => {
    vscode.postMessage({ type: 'page', delta: -1 });
  });
  if (btnNext) btnNext.addEventListener('click', () => {
    vscode.postMessage({ type: 'page', delta: 1 });
  });
  if (pageSize) pageSize.addEventListener('change', () => {
    vscode.postMessage({ type: 'pageSize', pageSize: Number(pageSize.value) });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'busy') {
      busy = !!msg.busy;
      document.body.classList.toggle('busy', busy);
      updateToolbar();
      return;
    }
    if (msg.type === 'status') {
      setStatus(msg.message, msg.ok);
      return;
    }
    if (msg.type === 'sqlDraft') {
      applySqlDraft(msg);
      return;
    }
    if (msg.type === 'applied') {
      if (msg.action === 'setNull' || msg.action === 'editCell') {
        if (state.rows[msg.row]) state.rows[msg.row][msg.col] = msg.value;
      } else if (msg.action === 'deleteRow') {
        state.rows.splice(msg.row, 1);
        if (selected.row === msg.row) selected.row = -1;
        else if (selected.row > msg.row) selected.row -= 1;
        paintedRows = Math.min(paintedRows, state.rows.length);
      } else if (msg.action === 'renameColumn') {
        state.columns[msg.col] = msg.displayName;
        if (state.edit.columns[msg.col]) {
          state.edit.columns[msg.col].displayName = msg.displayName;
          state.edit.columns[msg.col].sourceColumn = msg.sourceColumn;
        }
      }
      renderTable(false);
      updateToolbar();
    }
  });

  renderTable();
  updateToolbar();
  updateSqlHighlight();
})();
</script>
</body>
</html>`;
    }
}

function renderActions(plan: ResultEditPlan, detailed: boolean): string {
    const editButtons = plan.editable
        ? `<button type="button" class="icon-btn" id="btnNull" disabled title="Set NULL">${icon('null')}</button>
      <button type="button" class="icon-btn" id="btnDuplicate" disabled title="Duplicate row">${icon('duplicate')}</button>
      <button type="button" class="icon-btn" id="btnDelete" disabled title="Delete row">${icon('delete')}</button>
      <button type="button" class="icon-btn" id="btnRename" disabled title="Rename column">${icon('rename')}</button>
      <span class="toolbar-split"></span>`
        : '';
    return `<div class="actions" id="toolbar">
      ${editButtons}
      <button type="button" class="secondary" id="btnDetailed" aria-pressed="${detailed ? 'true' : 'false'}" title="Show column type and flags">${icon('detail')} Detailed</button>
      <button type="button" class="secondary" id="btnRefresh">${icon('refresh')} Refresh</button>
      <span class="toolbar-split"></span>
      <label class="export-label">
        <select id="exportScope" title="Export scope">
          <option value="table">This page</option>
          <option value="row" disabled>This row</option>
          <option value="cell" disabled>This cell</option>
        </select>
      </label>
      <label class="export-label">
        <select id="exportFormat" title="Export format">
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
        </select>
      </label>
      <button type="button" class="secondary" id="btnCopy">${icon('copy')} Copy</button>
      <button type="button" class="secondary" id="btnSave">${icon('save')} Save</button>
    </div>`;
}

function renderPager(pager: GridState['pager']): string {
    const sizeOptions = pager.pageSizes
        .map((size) => {
            const selected = size === pager.pageSize ? ' selected' : '';
            return `<option value="${size}"${selected}>${size}</option>`;
        })
        .join('');
    const pageText =
        pager.rowEnd === 0 ? 'No rows' : `Rows ${pager.rowStart}–${pager.rowEnd}`;
    return `<div class="pager" id="pager">
    <button type="button" class="secondary" id="btnPrev"${pager.hasPrev ? '' : ' disabled'}>Previous</button>
    <span class="page-label">${escapeHtml(pageText)}</span>
    <button type="button" class="secondary" id="btnNext"${pager.hasMore ? '' : ' disabled'}>Next</button>
    <label class="export-label">Rows per page
      <select id="pageSize">${sizeOptions}</select>
    </label>
  </div>`;
}

function exportLabel(scope: ExportScope, format: ExportFormat): string {
    const fmt = format.toUpperCase();
    if (scope === 'cell') {
        return `cell as ${fmt}`;
    }
    if (scope === 'row') {
        return `row as ${fmt}`;
    }
    return `page as ${fmt}`;
}

function renderSuccessShell(result: QueryResult): string {
    if (result.columns.length === 0) {
        const affected =
            result.rowsAffected === undefined
                ? 'The statement finished. No result rows.'
                : `${result.rowsAffected} row${result.rowsAffected === 1 ? '' : 's'} affected.`;
        return `<div class="status info">${escapeHtml(affected)}</div>`;
    }
    return '<div id="tableHost"></div>';
}

function renderInfoPopover(result: QueryResult, plan: ResultEditPlan): string {
    const items: string[] = [infoItem('Time', formatElapsed(result.elapsedMs))];
    if (result.ok && result.columns.length > 0) {
        items.push(infoItem(plan.editable ? 'Editing' : 'Read only', plan.reason));
        if (result.sort) {
            const col = result.columns[result.sort.columnIndex] ?? `#${result.sort.columnIndex + 1}`;
            items.push(infoItem('Sort', `${col} ${result.sort.direction}. Click a header to change.`));
        } else {
            items.push(infoItem('Sort', 'Click a column header to sort. Click again for DESC, again to clear.'));
        }
        if (result.truncated) {
            items.push(infoItem('Pages', 'More rows after this page. Use Next.'));
        }
        if (!result.paged) {
            items.push(infoItem('Pages', 'Only this page was loaded. This SQL cannot fetch more pages.'));
        }
        items.push(
            infoItem(
                'Cells',
                'Long values stay on one line. Use the expand button to open the full cell or row.'
            )
        );
        items.push(
            infoItem(
                'Keys',
                plan.editable
                    ? 'Click a cell again or press Enter to edit. Right-click a row for more actions.'
                    : 'Right-click a row to copy it. Use Detailed to show column types when they are known.'
            )
        );
    } else if (!result.ok) {
        items.push(infoItem('Error', result.error ?? 'The query failed.'));
    } else if (result.rowsAffected !== undefined) {
        items.push(
            infoItem('Result', `${result.rowsAffected} row${result.rowsAffected === 1 ? '' : 's'} affected`)
        );
    }
    return `<div class="info-pop" id="infoPop" hidden>${items.join('')}</div>`;
}

function infoItem(label: string, text: string): string {
    return `<p><span class="k">${escapeHtml(label)}</span>${escapeHtml(text)}</p>`;
}

function renderSqlBlock(
    sql: string,
    params: Record<string, string | null>,
    open: boolean
): string {
    const preview = sqlPreviewText(sql);
    return `<section class="sql-box${open ? ' open' : ''}" id="sqlBox">
    <div class="sql-bar">
      <button type="button" class="sql-toggle" id="btnSqlToggle" aria-expanded="${open ? 'true' : 'false'}">
        <span class="chevron">${icon('chevron')}</span><span class="sql-name">SQL</span>
        <span class="sql-preview" id="sqlPreview">${highlightSql(preview)}</span>
      </button>
      <button type="button" class="secondary" id="btnEditSql" title="Edit in editor">${icon('edit')} Edit</button>
      <button type="button" class="secondary" id="btnRunSql" title="Run (Ctrl+Enter)">${icon('run')} Run</button>
      <button type="button" class="icon-btn" id="btnCopySql" title="Copy SQL">${icon('copy')}</button>
    </div>
    <div class="sql-body" id="sqlBody">
      <pre class="sql" id="sqlText">${highlightSql(sql)}</pre>
      ${renderParams(sql, params)}
    </div>
  </section>`;
}

function renderParams(sql: string, params: Record<string, string | null>): string {
    const keys = uniqueBindNames(sql);
    if (keys.length === 0) {
        return '<div class="label" id="paramLabel" hidden>Parameters</div><div class="params" id="paramList" hidden></div>';
    }
    const items = keys
        .map((key) => {
            const value = lookupParam(params, key);
            const shown = value === null ? '' : value;
            return `<div class="param-row"><label><span class="param">:${escapeHtml(key)}</span></label><input class="param-input" data-name="${escapeHtml(key)}" value="${escapeHtml(shown)}" placeholder="NULL" spellcheck="false" /></div>`;
        })
        .join('');
    return `<div class="label" id="paramLabel">Parameters</div><div class="params" id="paramList">${items}</div>`;
}

function icon(name: IconName): string {
    return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

type IconName = keyof typeof ICON_PATHS;

const ICON_PATHS = {
    info: '<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="5.1" r="0.85" fill="currentColor"/><path d="M8 7.3v4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    chevron:
        '<path d="M6 4.2 10 8 6 11.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    copy: '<rect x="5.4" y="5.6" width="7" height="7.6" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.6 10.2V3.8c0-.6.5-1.1 1.1-1.1h6.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    refresh:
        '<path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M13 2.8v3.3h-3.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    null: '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.3 11.7 11.7 4.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    delete:
        '<path d="M3.4 4.8h9.2M6.2 4.8V3.6h3.6v1.2M5.3 4.8l.5 7.4h4.4l.5-7.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
    rename:
        '<path d="M9.5 3.5 12.4 6.4 5.7 13.1H2.8v-2.9z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
    edit: '<path d="M3.2 10.3 9.9 3.6 12 5.7 5.3 12.4H3.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.7 4.8 10.8 6.9" fill="none" stroke="currentColor" stroke-width="1.2"/>',
    duplicate:
        '<rect x="5.6" y="5.4" width="7.2" height="7.2" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.2 10.4V3.8c0-.6.5-1.1 1.1-1.1h6.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    detail:
        '<path d="M3.2 4.2h9.6M3.2 8h9.6M3.2 11.8h6.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    close:
        '<path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    expand:
        '<path d="M3.4 6.2V3.4h2.8M12.6 6.2V3.4h-2.8M3.4 9.8v2.8h2.8M12.6 9.8v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    save: '<path d="M8 3.2v7M5.3 7.4 8 10.1l2.7-2.7M3.4 12.7h9.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    table:
        '<rect x="1.4" y="2.4" width="13.2" height="11.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.4 5.8h13.2M5.8 5.8v7.8M10.2 5.8v7.8M1.4 9.3h13.2" fill="none" stroke="currentColor" stroke-width="1.1"/>',
    run: '<path d="M4.2 2.8v10.4L13.2 8z" fill="currentColor"/>'
} as const;

function mergeBindParams(
    sql: string,
    previous: Record<string, string | null>
): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const name of uniqueBindNames(sql)) {
        out[name] = lookupParam(previous, name);
    }
    return out;
}

function sqlPreviewText(sql: string): string {
    const firstLine = sql.trim().split(/\r?\n/, 1)[0] ?? '';
    return firstLine.length > 96 ? `${firstLine.slice(0, 96)}…` : firstLine;
}

function asParams(value: unknown): Record<string, string | null> {
    if (!value || typeof value !== 'object') {
        return {};
    }
    const out: Record<string, string | null> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === null || typeof entry === 'string') {
            out[key] = entry;
        }
    }
    return out;
}

function formatElapsed(ms: number): string {
    if (ms < 1000) {
        return `${ms} ms`;
    }
    return `${(ms / 1000).toFixed(2)} s`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function embedJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i++) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}
