import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { collectSqlFormatEdits } from '../providers/sqlFormat';

/**
 * Formats every detected single-string SQL block in the open Python file.
 */
export async function formatSqlInFile(db: SqlServerService): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showWarningMessage('Open a Python file first.');
        return;
    }

    const config = db.getConfig();
    if (!config.enabled) {
        vscode.window.showWarningMessage('BiSql is disabled.');
        return;
    }

    const document = editor.document;
    const result = collectSqlFormatEdits(document, config);

    if (
        result.formatted === 0 &&
        result.unchanged === 0 &&
        result.skippedConcat === 0 &&
        result.failures.length === 0
    ) {
        vscode.window.showInformationMessage('No SQL strings to format in this file.');
        return;
    }

    if (result.edits.length > 0) {
        const edit = new vscode.WorkspaceEdit();
        for (const textEdit of result.edits) {
            edit.replace(document.uri, textEdit.range, textEdit.newText);
        }
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage('Could not apply SQL formatting.');
            return;
        }
    }

    const parts: string[] = [];
    if (result.formatted > 0) {
        parts.push(
            `Formatted ${result.formatted} SQL string${result.formatted === 1 ? '' : 's'}.`
        );
    } else if (result.unchanged > 0) {
        parts.push('SQL strings are already formatted.');
    }
    if (result.skippedConcat > 0) {
        parts.push(
            `Skipped ${result.skippedConcat} concatenated SQL string` +
                `${result.skippedConcat === 1 ? '' : 's'} (format those as one triple-quoted string).`
        );
    }
    if (result.failures.length > 0) {
        parts.push(`Could not format ${result.failures.length}: ${result.failures[0]}`);
    }

    const message = parts.join(' ');
    if (result.failures.length > 0 && result.formatted === 0) {
        vscode.window.showWarningMessage(message);
    } else {
        vscode.window.showInformationMessage(message);
    }
}
