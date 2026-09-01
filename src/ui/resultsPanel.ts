import * as vscode from 'vscode';
import { promptRunParams } from '../commands/promptRunParams';
import { QueryResult, SqlServerService } from '../db/connection';
import { isSqlDocument, SqlBlock, statementAtOffset } from '../parser/sqlExtractor';
import { annotateSqlError } from '../sql/errorLines';
import { highlightSql } from '../sql/highlightSql';
import {
    applyPlaceholders,
    hasParam,
    isMutatingSql,
    lookupParam,
    paramFieldsForSql,
    ParamField,
    uniqueBindNames,
    uniquePlaceholderNames
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
import { fillWebviewPage, mediaRoot, tabIcon } from './media';

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
    | { type: 'setParams'; params: Record<string, string | null> }
    | { type: 'ready' };

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
          paramFields: ParamField[];
      }
    | {
          type: 'setResult';
          loading: boolean;
          ok: boolean;
          error?: string;
          rowsAffected?: number;
          sqlOpen: boolean;
          detailed: boolean;
          sqlHtml: string;
          previewHtml: string;
          params: Record<string, string | null>;
          paramFields: ParamField[];
          info: { label: string; text: string }[];
          grid: GridState;
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

async function dockResultsBelow(
    panel: vscode.WebviewPanel,
    priorEditor: vscode.TextEditor | undefined,
    restoreFocus: boolean
): Promise<void> {
    panel.reveal(undefined, false);
    try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
    } catch {
        // Some hosts lack this command. The tab stays in the current group.
    }
    if (!restoreFocus || !priorEditor || priorEditor.document.isClosed) {
        return;
    }
    await vscode.window.showTextDocument(priorEditor.document, {
        viewColumn: priorEditor.viewColumn,
        preview: false,
        preserveFocus: false
    });
}

interface GridState {
    sql: string;
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
 * Shows the SQL that ran and the result rows in a tab under the editor.
 * Each run opens its own tab. Extra runs join that same bottom group.
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
        const priorEditor = vscode.window.activeTextEditor;
        // VS Code has no ViewColumn.Below. Open in the current group, then
        // move the tab into the group under the editor (create one if needed).
        const panel = vscode.window.createWebviewPanel(
            ResultsPanel.viewType,
            title,
            {
                viewColumn: vscode.ViewColumn.Active,
                preserveFocus: false
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [mediaRoot()]
            }
        );
        panel.iconPath = tabIcon('sql-results-light.svg', 'sql-results-dark.svg');
        void dockResultsBelow(panel, priorEditor, options?.preserveFocus === true);
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
    private sourceBlock: SqlBlock | undefined;
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
        ResultsPanel.openPanels.add(this);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (message: WebviewToExt) => {
                void this.onMessage(message);
            },
            null,
            this.disposables
        );
        this.panel.webview.html = this.getHtml();
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
        if (message.type === 'ready') {
            await this.pushView();
            return;
        }
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

    public linkSqlSource(block: SqlBlock): void {
        this.sourceBlock = block;
        if (this.result.ok || !this.result.error) {
            return;
        }
        const error = annotateSqlError(this.result.error, block, this.result.errorLine);
        if (error === this.result.error) {
            return;
        }
        this.result = { ...this.result, error };
        void this.pushView();
    }

    public displayError(result: QueryResult = this.result): string {
        const message = result.error ?? 'The query failed.';
        if (!this.sourceBlock) {
            return message;
        }
        return annotateSqlError(message, this.sourceBlock, result.errorLine);
    }

    public async runFromEditor(sql: string): Promise<void> {
        if (this.busy) {
            return;
        }
        this.draftSql = sql;
        this.draftParams = mergeRunParams(sql, this.draftParams);
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
        this.draftParams = mergeRunParams(text, this.draftParams);
        await this.post({
            type: 'sqlDraft',
            previewHtml: highlightSql(sqlPreviewText(text)),
            sqlHtml: highlightSql(text),
            params: this.draftParams,
            paramFields: paramFieldsForSql(text)
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
        const prompted = await promptRunParams(
            text,
            this.result.readOnly ? 'Explain SQL' : 'Run Selected SQL',
            this.draftParams
        );
        if (prompted === undefined) {
            return;
        }
        this.draftParams = prompted;
        const filledSql = applyPlaceholders(text, this.draftParams);
        if (!this.result.readOnly && isMutatingSql(filledSql)) {
            const confirm = await vscode.window.showWarningMessage(
                'This SQL may change data or schema. Run it anyway?',
                { modal: true },
                'Run'
            );
            if (confirm !== 'Run') {
                return;
            }
        }
        this.draftParams = mergeRunParams(text, this.draftParams);
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
            void this.pushView();
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
        this.loading = false;
        this.result =
            result.ok || !result.error
                ? result
                : { ...result, error: this.displayError(result) };
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
        void this.pushView();
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
                vscode.window.showErrorMessage(this.displayError(result));
                await this.postStatus(this.displayError(result), false);
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
                vscode.window.showErrorMessage(this.displayError());
                await this.postStatus(this.displayError(), false);
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
            sql: this.result.sql,
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

    private viewPayload(): Extract<ExtToWebview, { type: 'setResult' }> {
        const sql = this.draftSql || this.result.sql;
        return {
            type: 'setResult',
            loading: this.loading,
            ok: this.result.ok,
            error: this.result.error,
            rowsAffected: this.result.rowsAffected,
            sqlOpen: this.sqlOpen,
            detailed: this.detailedMode,
            sqlHtml: highlightSql(sql),
            previewHtml: highlightSql(sqlPreviewText(sql)),
            params: this.draftParams,
            paramFields: paramFieldsForSql(sql),
            info: this.infoItems(),
            grid: this.gridState()
        };
    }

    private async pushView(): Promise<void> {
        await this.post(this.viewPayload());
    }

    private infoItems(): { label: string; text: string }[] {
        const result = this.result;
        const items: { label: string; text: string }[] = [
            { label: 'Time', text: formatElapsed(result.elapsedMs) }
        ];
        if (result.ok && result.columns.length > 0) {
            items.push({
                label: this.plan.editable ? 'Editing' : 'Read only',
                text: this.plan.reason
            });
            if (result.sort) {
                const col =
                    result.columns[result.sort.columnIndex] ?? `#${result.sort.columnIndex + 1}`;
                items.push({
                    label: 'Sort',
                    text: `${col} ${result.sort.direction}. Click a header to change.`
                });
    } else {
                items.push({
                    label: 'Sort',
                    text: 'Click a column header to sort. Click again for DESC, again to clear.'
                });
            }
            if (result.truncated) {
                items.push({ label: 'Pages', text: 'More rows after this page. Use Next.' });
            }
            if (!result.paged) {
                items.push({
                    label: 'Pages',
                    text: 'Only this page was loaded. This SQL cannot fetch more pages.'
                });
            }
            items.push({
                label: 'Cells',
                text: 'Long values stay on one line. Use the expand button to open the full cell or row.'
            });
            items.push({
                label: 'Keys',
                text: this.plan.editable
                    ? 'Click a cell again or press Enter to edit. Right-click a row for more actions.'
                    : 'Right-click a row to copy it. Use Detailed to show column types when they are known.'
            });
        } else if (!result.ok) {
            items.push({ label: 'Error', text: result.error ?? 'The query failed.' });
        } else if (result.rowsAffected !== undefined) {
            items.push({
                label: 'Result',
                text: `${result.rowsAffected} row${result.rowsAffected === 1 ? '' : 's'} affected`
            });
        }
        return items;
    }

    private getHtml(): string {
        return fillWebviewPage('results', this.panel.webview, this.viewPayload());
    }
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

function mergeRunParams(
    sql: string,
    previous: Record<string, string | null>
): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    const seen = new Set<string>();
    for (const name of uniquePlaceholderNames(sql)) {
        seen.add(name.toLowerCase());
        if (hasParam(previous, name)) {
            out[name] = lookupParam(previous, name);
        }
    }
    for (const name of uniqueBindNames(sql)) {
        if (seen.has(name.toLowerCase())) {
            continue;
        }
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

