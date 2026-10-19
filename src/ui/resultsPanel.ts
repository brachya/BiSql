import * as vscode from 'vscode';
import { confirmBigqueryScan } from '../commands/confirmBigqueryScan';
import { promptRunParams } from '../commands/promptRunParams';
import { formatScanBytes } from '../db/bigquery';
import { QueryResult, SqlServerService } from '../db/connection';
import { gridCellPreview, LONG_CELL_CHARS, MAX_STORED_CELL_CHARS, longCellWarning } from '../db/queryCells';
import { isSqlDocument, primaryResultTable, SqlBlock, statementAtOffset } from '../parser/sqlExtractor';
import { cellEditorText, cellPanelId, CellKey, rowMatchingKeys } from '../sql/cellDocument';
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
import { cellValueUri, CellSaveResult, putCellValue, setCellSaveHandler } from './cellValueFiles';
import { fillWebviewPage, mediaRoot, tabIcon } from './media';
import {
    handleDeleteRow,
    handleDuplicateRow,
    handleEditCell,
    handleRenameColumn,
    handleSetNull,
    ConfirmResult,
    ResultMutationHost
} from './resultsMutations';

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
    | { type: 'openCell'; row: number; col: number }
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
          scanLabel?: string;
          readOnly?: boolean;
          /** Set when a cell is longer than LONG_CELL_CHARS. The grid holds the start. */
          cellWarning?: string;
          longCellChars: number;
          maxStoredCellChars: number;
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

/** Tab title, with the first table name when the SQL has one. */
export function resultsTabTitle(
    result: { ok: boolean; sql: string; readOnly?: boolean },
    loading: boolean
): string {
    let base: string;
    if (loading) {
        base = 'Running SQL…';
    } else if (result.readOnly) {
        base = result.ok ? 'SQL Plan' : 'SQL Plan Error';
    } else {
        base = result.ok ? 'SQL Results' : 'SQL Error';
    }
    const table = primaryResultTable(result.sql);
    return table ? `${base} - ${table}` : base;
}

/**
 * Shows the SQL that ran and the result rows in a tab under the editor.
 * Each run opens its own tab. Extra runs join that same bottom group.
 * Query edits go through a real SQL editor, not a webview textarea.
 */
export class ResultsPanel {
    public static readonly viewType = 'bisql.resultsPanel';
    private static readonly openPanels = new Set<ResultsPanel>();
    private static nextPanelId = 1;

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
        const title = resultsTabTitle(result, loading);
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
    private readonly openedCells = new Map<string, { sourceColumn: string; keys: CellKey[] }>();
    private readonly panelId = ResultsPanel.nextPanelId++;
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
        if (message.type === 'openCell') {
            await this.handleOpenCell(message.row, message.col);
            return;
        }
        if (this.busy) {
            return;
        }
        switch (message.type) {
            case 'setNull':
                await handleSetNull(this.mutationHost(), message.row, message.col);
                return;
            case 'editCell':
                await handleEditCell(
                    this.mutationHost(),
                    message.row,
                    message.col,
                    typeof message.value === 'string' ? message.value : String(message.value ?? '')
                );
                return;
            case 'deleteRow':
                await handleDeleteRow(this.mutationHost(), message.row);
                return;
            case 'duplicateRow':
                await handleDuplicateRow(this.mutationHost(), message.row);
                return;
            case 'renameColumn':
                await handleRenameColumn(this.mutationHost(), message.col);
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

    private async handleOpenCell(row: number, col: number): Promise<void> {
        const record = this.rowAt(row);
        if (!record || !Number.isInteger(col) || col < 0 || col >= record.length) {
            await this.postStatus('That cell is not in this result.', false);
            return;
        }
        const opened = cellEditorText(record[col] ?? '');
        const column = this.columns[col] || 'cell';
        const meta = this.plan.columns[col];
        const keys = this.cellKeys(row);
        const writable = !!keys && this.plan.editable && !!meta?.canEdit && !!meta.sourceColumn;
        const uri = cellValueUri(this.panelId, this.pageOffset + row + 1, column, opened.language);
        if (writable && meta?.sourceColumn && keys) {
            this.openedCells.set(uri.toString(), { sourceColumn: meta.sourceColumn, keys });
        }
        putCellValue(uri, opened.text, writable);
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.languageId !== opened.language) {
            await vscode.languages.setTextDocumentLanguage(document, opened.language);
        }
        const resultsColumn = this.panel.viewColumn;
        const editorColumn =
            resultsColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
        await vscode.window.showTextDocument(document, {
            viewColumn: editorColumn,
            preview: false,
            preserveFocus: false
        });
    }

    private cellKeys(row: number): CellKey[] | undefined {
        const record = this.rowAt(row);
        if (!record || this.plan.pkIndexes.length === 0) {
            return undefined;
        }
        const keys: CellKey[] = [];
        for (const index of this.plan.pkIndexes) {
            const sourceColumn = this.plan.columns[index]?.sourceColumn;
            if (!sourceColumn) {
                return undefined;
            }
            keys.push({ sourceColumn, value: record[index] ?? '' });
        }
        return keys;
    }

    private async saveOpenedCell(uriKey: string, text: string): Promise<CellSaveResult> {
        const opened = this.openedCells.get(uriKey);
        if (!opened) {
            await this.postStatus('This cell cannot be edited.', false);
            return 'failed';
        }
        if (this.busy) {
            await this.postStatus('Wait for the current change to finish.', false);
            return 'failed';
        }
        const col = this.plan.columns.findIndex((column) => column.sourceColumn === opened.sourceColumn);
        const column = col >= 0 ? this.plan.columns[col] : undefined;
        if (!this.plan.editable || !column?.canEdit || !column.sourceColumn) {
            await this.postStatus('This cell cannot be edited.', false);
            return 'failed';
        }
        const row = rowMatchingKeys(
            this.rows,
            this.plan.columns.map((item) => item.sourceColumn),
            opened.keys
        );
        if (row < 0) {
            await this.postStatus('That row is not on this page anymore. Go back to it, then save again.', false);
            return 'failed';
        }
        const edited = await handleEditCell(this.mutationHost(), row, col, text);
        if (edited === 'applied' || edited === 'unchanged') {
            return 'saved';
        }
        if (edited === 'cancelled') {
            return 'cancelled';
        }
        return 'failed';
    }

    public static async saveCellFile(uri: vscode.Uri, text: string): Promise<CellSaveResult> {
        const panelId = cellPanelId(uri.path);
        if (panelId === undefined) {
            return 'failed';
        }
        for (const panel of ResultsPanel.openPanels) {
            if (panel.panelId === panelId) {
                return panel.saveOpenedCell(uri.toString(), text);
            }
        }
        return 'failed';
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

    /**
     * File-line text must use the statement that actually ran.
     * A linked .sql file can move the caret; drop the old block if it no longer matches.
     */
    private syncSqlSource(sql: string): void {
        const editor = this.linkedSqlEditor();
        if (editor) {
            const source = editor.document.getText();
            const slice = statementAtOffset(
                source,
                editor.document.offsetAt(editor.selection.active)
            );
            if (slice && slice.text.trim() === sql.trim()) {
                this.sourceBlock = SqlBlock.fromDocumentSlice(source, slice.start, slice.end);
                return;
            }
        }
        if (this.sourceBlock && this.sourceBlock.originalText.trim() !== sql.trim()) {
            this.sourceBlock = undefined;
        }
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
        this.syncSqlSource(text);
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
        if (!this.result.readOnly && !(await confirmBigqueryScan(this.db, text, this.draftParams))) {
            return;
        }
        this.draftParams = mergeRunParams(text, this.draftParams);
        this.sqlOpen = true;
        if (this.result.readOnly) {
            await this.reloadExplain(text, this.draftParams, 'Explaining SQL…');
            return;
        }
        const ran = await this.reloadQuery(
            0,
            this.pageSize,
            undefined,
            'Running SQL…',
            text,
            this.draftParams
        );
        if (ran) {
            await this.db.rememberQuery(text);
        }
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
        this.panel.title = resultsTabTitle(result, false);
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
    ): Promise<boolean> {
        const querySql = sql ?? this.result.sql;
        const queryParams = params ?? this.result.params;
        if (this.result.readOnly) {
            await this.reloadExplain(querySql, queryParams, title);
            return false;
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
                return false;
            }
            this.applyResult(result);
            return true;
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

    private mutationHost(): ResultMutationHost {
        return {
            plan: this.plan,
            rows: this.rows,
            columns: this.columns,
            db: this.db,
            rowAt: (row) => this.rowAt(row),
            postStatus: (message, ok) => this.postStatus(message, ok),
            post: (message) => this.post(message as ExtToWebview),
            confirmAndRun: (title, sql, params, requireOneRow) =>
                this.confirmAndRun(title, sql, params, requireOneRow),
            refresh: () => this.handleRefresh()
        };
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
    ): Promise<ConfirmResult> {
        const choice = await vscode.window.showWarningMessage(
            title,
            { modal: true, detail: formatMutationPreview(sql, params) },
            'Apply'
        );
        if (choice !== 'Apply') {
            return 'cancelled';
        }
        const applied = await this.runMutation(sql, params, requireOneRow);
        return applied ? 'applied' : 'failed';
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
            rows: this.rows.map((row) => row.map((cell) => gridCellPreview(cell))),
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
            scanLabel: scanLabelForResult(this.result),
            readOnly: this.result.readOnly === true,
            cellWarning: longCellWarning(this.rows.flat().map((cell) => cell.length)),
            longCellChars: LONG_CELL_CHARS,
            maxStoredCellChars: MAX_STORED_CELL_CHARS,
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
        if (result.scanBytes !== undefined) {
            items.push({
                label: result.readOnly ? 'Estimated scan' : 'Scanned',
                text: `${formatScanBytes(result.scanBytes)}. LIMIT does not reduce bytes scanned.`
            });
        }
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
        if (hasParam(previous, name)) {
            out[name] = lookupParam(previous, name);
        }
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

setCellSaveHandler((uri, text) => ResultsPanel.saveCellFile(uri, text));

function scanLabelForResult(result: QueryResult): string | undefined {
    if (result.scanBytes === undefined) {
        return undefined;
    }
    const size = formatScanBytes(result.scanBytes);
    return result.readOnly ? `${size} estimated` : `${size} scanned`;
}

