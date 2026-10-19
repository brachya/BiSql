import * as vscode from 'vscode';
import { DbEngine, SqlServerService, TableInfo } from '../db/connection';
import { quoteIdent } from '../sql/functions';
import {
    buildObjectDefinitionQuery,
    buildTableDefinitionFromCache,
    extractDefinitionText,
    formatDefinitionForEditor
} from '../sql/objectDefinition';
import { formatQualifiedTable, QualifiableTable } from '../sql/qualifyTables';
import { ResultsPanel } from './resultsPanel';

export function formatSelectStar(table: QualifiableTable, engine: DbEngine): string {
    return `SELECT * FROM ${formatQualifiedTable(table, engine)}`;
}

export function formatSelectColumns(table: TableInfo, engine: DbEngine): string {
    const columns = [...table.columns]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((column) => quoteIdent(column.name, engine))
        .join(',\n    ');
    const from = formatQualifiedTable(table, engine);
    if (columns.length === 0) {
        return `SELECT *\nFROM ${from}`;
    }
    return `SELECT ${columns}\nFROM ${from}`;
}

export async function openSqlEditor(content = ''): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content
    });
    await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false
    });
}

export async function insertAtCursor(text: string): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        void vscode.window.showWarningMessage('Open an editor first.');
        return false;
    }
    await editor.edit((edit) => {
        edit.insert(editor.selection.active, text);
    });
    return true;
}

export async function copyText(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
}

export type PreviewTableResult = {
    ok: boolean;
    message: string;
    table?: TableInfo;
};

export async function previewTable(
    db: SqlServerService,
    qualifiedName: string
): Promise<PreviewTableResult> {
    const table = db.findTable(qualifiedName);
    if (!table) {
        return { ok: false, message: `Unknown table '${qualifiedName}'.` };
    }
    const engine = db.getConfig().engine;
    const sql = formatSelectStar(table, engine);
    const view = ResultsPanel.showRunning(db, sql, {});
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
                return await db.executeQuery(sql, {}, { signal: abort.signal });
            } finally {
                sub.dispose();
            }
        }
    );
    view.setResult(result);
    if (!result.ok) {
        vscode.window.showErrorMessage(result.error ?? 'The query failed.');
        return { ok: false, message: result.error ?? 'The query failed.', table };
    }
    return { ok: true, message: `Opened ${table.qualifiedName}.`, table };
}

export type ShowDefinitionResult = {
    ok: boolean;
    message: string;
};

export async function showObjectDefinition(
    db: SqlServerService,
    table: TableInfo
): Promise<ShowDefinitionResult> {
    const engine = db.getConfig().engine;
    let sql = buildObjectDefinitionQuery(table, engine);
    let fromCache = false;
    if (!sql.trim()) {
        const cached = buildTableDefinitionFromCache(table, engine);
        if (!cached) {
            const message = 'Show definition is not available for this object on this engine.';
            void vscode.window.showWarningMessage(message);
            return { ok: false, message };
        }
        await openSqlEditor(cached);
        return finishDefinition(table, true);
    }

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Loading definition for ${table.name}…`,
            cancellable: true
        },
        async (_progress, token) => {
            const abort = new AbortController();
            const sub = token.onCancellationRequested(() => abort.abort());
            try {
                return await db.executeQuery(sql, {}, { signal: abort.signal, limit: 1, raw: true });
            } finally {
                sub.dispose();
            }
        }
    );

    let text = extractDefinitionText(result);
    if (!text && !table.isView) {
        text = buildTableDefinitionFromCache(table, engine);
        fromCache = !!text;
    }
    if (!text) {
        const message = result.ok
            ? 'The server returned no definition.'
            : (result.error ?? 'The query failed.');
        if (!result.ok) {
            vscode.window.showErrorMessage(message);
        } else {
            vscode.window.showWarningMessage(message);
        }
        return { ok: false, message };
    }

    const editorText = fromCache ? text : formatDefinitionForEditor(table, engine, text);
    await openSqlEditor(editorText);
    const partial = fromCache || (engine === 'postgres' && !table.isView);
    return finishDefinition(table, partial);
}

function finishDefinition(table: TableInfo, partial: boolean): ShowDefinitionResult {
    const message = partial
        ? `Opened a column list for ${table.qualifiedName}. Defaults, indexes, and foreign keys are left out.`
        : `Opened definition for ${table.qualifiedName}.`;
    if (partial) {
        void vscode.window.showInformationMessage(message);
    }
    return { ok: true, message };
}
