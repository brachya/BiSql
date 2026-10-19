import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { QueryHistoryEntry, historyPickLabel } from '../sql/queryHistory';
import { openSqlEditor } from '../ui/schemaActions';

type HistoryPick = vscode.QuickPickItem & { action: 'open'; sql: string } | vscode.QuickPickItem & {
    action: 'clear';
};

export async function showQueryHistory(db: SqlServerService): Promise<void> {
    await db.enforceQueryHistoryLimit();
    const entries = db.listQueryHistory();
    if (entries.length === 0) {
        vscode.window.showInformationMessage(
            db.getConfig().queryHistorySize <= 0
                ? 'Query history is off. Set bisql.queryHistorySize above 0 to keep queries.'
                : 'No query history yet. Run a query first.'
        );
        return;
    }

    const names = new Map(db.listProfiles().map((profile) => [profile.id, profile.name]));
    const items: HistoryPick[] = entries.map((entry) => ({
        action: 'open',
        sql: entry.sql,
        label: historyPickLabel(entry.sql),
        description: historyDescription(entry, names.get(entry.connectionId)),
        detail: historyDetail(entry.sql)
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: 'clear' });
    items.push({ label: '$(trash) Clear history', action: 'clear', alwaysShow: true });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Query history',
        placeHolder: 'Open a past query',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) {
        return;
    }
    if (picked.action === 'clear') {
        const confirm = await vscode.window.showWarningMessage(
            'Clear query history?',
            { modal: true },
            'Clear'
        );
        if (confirm === 'Clear') {
            await db.clearQueryHistory();
        }
        return;
    }
    await openSqlEditor(picked.sql);
}

function historyDescription(entry: QueryHistoryEntry, connectionName: string | undefined): string {
    const when = new Date(entry.at).toLocaleString();
    return connectionName ? `${connectionName} · ${when}` : when;
}

function historyDetail(sql: string): string | undefined {
    if (!sql.includes('\n') && sql.length <= 80) {
        return undefined;
    }
    if (sql.length <= 400) {
        return sql;
    }
    return `${sql.slice(0, 400)}…`;
}
