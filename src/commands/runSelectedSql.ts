import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { isSqlDocument } from '../parser/sqlExtractor';
import {
    findFStringInterpolations,
    isMutatingSql,
    uniqueBindNames
} from '../sql/parameters';
import {
    pickLensArgs,
    resolveSqlTargetFromArgs,
    resolveSqlTargetFromEditor,
    SqlLensArgs,
    SqlTarget
} from '../sql/sqlTarget';
import { ResultsPanel } from '../ui/resultsPanel';
import { Commands } from './ids';

/**
 * Runs SQL from a CodeLens, the caret, or the current selection.
 */
export async function runSelectedSql(
    db: SqlServerService,
    ...args: unknown[]
): Promise<void> {
    const target = await resolveRunTarget(db, pickLensArgs(...args));
    if (!target) {
        return;
    }
    await runSqlTarget(db, target);
}

export async function resolveRunTarget(
    db: SqlServerService,
    args?: SqlLensArgs
): Promise<SqlTarget | undefined> {
    const detectByKeyword = db.getConfig().detectByKeyword;
    if (args) {
        const target = await resolveSqlTargetFromArgs(args, detectByKeyword);
        if (!target) {
            vscode.window.showWarningMessage('Could not find that SQL statement.');
        }
        return target;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a file and select the SQL to run.');
        return undefined;
    }
    const target = resolveSqlTargetFromEditor(editor, detectByKeyword);
    if (!target) {
        vscode.window.showWarningMessage(
            isSqlDocument(editor.document)
                ? 'This SQL file is empty.'
                : 'Put the caret in a SQL string, or select the SQL to run.'
        );
        return undefined;
    }
    return target;
}

export async function runSqlTarget(db: SqlServerService, target: SqlTarget): Promise<void> {
    const sql = target.sql;
    if (sql.trim().length === 0) {
        vscode.window.showWarningMessage('There is no SQL to run.');
        return;
    }

    const interpolations = findFStringInterpolations(sql);
    if (interpolations.length > 0) {
        const sample = interpolations.slice(0, 3).join(', ');
        vscode.window.showErrorMessage(
            `This SQL still has Python interpolations (${sample}). ` +
                'Those are not filled in. Select SQL that is already valid, without {…}.'
        );
        return;
    }

    const connected = await db.ensureConnected();
    if (!connected) {
        const choice = await vscode.window.showErrorMessage(
            db.lastErrorMessage ??
                'No database connection. Open the login page, then try again.',
            'Open Login'
        );
        if (choice === 'Open Login') {
            await vscode.commands.executeCommand(Commands.openConnectionPanel);
        }
        return;
    }

    if (target.isSqlFile) {
        const existing = ResultsPanel.findByDocument(target.document.uri);
        if (existing) {
            await existing.runFromEditor(sql);
            return;
        }
    }

    const params = await promptBindParams(sql, 'Run Selected SQL');
    if (params === undefined) {
        return;
    }

    if (isMutatingSql(sql)) {
        const confirm = await vscode.window.showWarningMessage(
            'This SQL may change data or schema. Run it anyway?',
            { modal: true },
            'Run'
        );
        if (confirm !== 'Run') {
            return;
        }
    }

    const view = ResultsPanel.showRunning(db, sql, params);
    if (target.isSqlFile) {
        view.linkDocument(target.document);
    }
    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Running SQL…',
            cancellable: true
        },
        async (_progress, token) => {
            const abort = new AbortController();
            const sub = token.onCancellationRequested(() => abort.abort());
            try {
                return await db.executeQuery(sql, params, { signal: abort.signal });
            } finally {
                sub.dispose();
            }
        }
    );

    view.setResult(result);
    if (!result.ok) {
        vscode.window.showErrorMessage(result.error ?? 'The query failed.');
    }
}

export async function promptBindParams(
    sql: string,
    title: string
): Promise<Record<string, string | null> | undefined> {
    const params: Record<string, string | null> = {};
    for (const name of uniqueBindNames(sql)) {
        const value = await vscode.window.showInputBox({
            prompt: `Value for :${name}`,
            placeHolder: 'Leave empty for NULL',
            ignoreFocusOut: true,
            title
        });
        if (value === undefined) {
            return undefined;
        }
        params[name] = value === '' ? null : value;
    }
    return params;
}
