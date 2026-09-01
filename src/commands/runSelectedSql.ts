import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { isSqlDocument } from '../parser/sqlExtractor';
import { applyPlaceholders, isMutatingSql } from '../sql/parameters';
import {
    pickLensArgs,
    resolveSqlTargetFromArgs,
    resolveSqlTargetFromEditor,
    SqlLensArgs,
    SqlTarget
} from '../sql/sqlTarget';
import { ResultsPanel } from '../ui/resultsPanel';
import { Commands } from './ids';
import { promptRunParams } from './promptRunParams';

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
            existing.linkSqlSource(target.block);
            await existing.runFromEditor(sql);
            return;
        }
    }

    const params = await promptRunParams(sql, 'Run Selected SQL');
    if (params === undefined) {
        return;
    }

    const filledSql = applyPlaceholders(sql, params);
    if (isMutatingSql(filledSql)) {
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
    view.linkSqlSource(target.block);
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
        vscode.window.showErrorMessage(view.displayError(result));
    }
}
