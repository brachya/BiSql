import * as vscode from 'vscode';
import { DbEngine, SqlServerService, TableInfo } from '../db/connection';
import { formatQualifiedTable, QualifiableTable } from '../sql/qualifyTables';
import { ResultsPanel } from './resultsPanel';

export function formatSelectStar(table: QualifiableTable, engine: DbEngine): string {
    return `SELECT * FROM ${formatQualifiedTable(table, engine)}`;
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
