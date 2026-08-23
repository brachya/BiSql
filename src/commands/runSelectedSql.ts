import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import {
    findFStringInterpolations,
    isMutatingSql,
    uniqueBindNames
} from '../sql/parameters';
import { ResultsPanel } from '../ui/resultsPanel';
import { Commands } from './ids';

/**
 * Runs the current editor selection against the live database and opens a results tab.
 */
export async function runSelectedSql(db: SqlServerService): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a file and select the SQL to run.');
        return;
    }

    const sql = editor.document.getText(editor.selection);
    if (sql.trim().length === 0) {
        vscode.window.showWarningMessage('Select the SQL text to run first.');
        return;
    }

    const interpolations = findFStringInterpolations(sql);
    if (interpolations.length > 0) {
        const sample = interpolations.slice(0, 3).join(', ');
        vscode.window.showErrorMessage(
            `This selection still has Python interpolations (${sample}). ` +
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

    const names = uniqueBindNames(sql);
    const params: Record<string, string | null> = {};
    for (const name of names) {
        const value = await vscode.window.showInputBox({
            prompt: `Value for :${name}`,
            placeHolder: 'Leave empty for NULL',
            ignoreFocusOut: true,
            title: 'Run Selected SQL'
        });
        if (value === undefined) {
            return;
        }
        params[name] = value === '' ? null : value;
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

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Running SQL…',
            cancellable: false
        },
        async () => db.executeQuery(sql, params)
    );

    ResultsPanel.show(result, db);
    if (!result.ok) {
        vscode.window.showErrorMessage(result.error ?? 'The query failed.');
    }
}
