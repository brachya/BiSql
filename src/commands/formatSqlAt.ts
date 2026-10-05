import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { isSqlDocument } from '../parser/sqlExtractor';
import { collectSqlFormatEdits } from '../providers/sqlFormat';
import { pickLensArgs, resolveSqlTargetFromArgs, SqlTarget } from '../sql/sqlTarget';

export async function formatSqlTarget(
    db: SqlServerService,
    target: SqlTarget
): Promise<void> {
    const config = db.getConfig();
    if (!config.enabled) {
        vscode.window.showWarningMessage('BiSql is disabled.');
        return;
    }

    const result = collectSqlFormatEdits(target.document, config, { range: target.range });
    if (
        result.formatted === 0 &&
        result.unchanged === 0 &&
        result.skippedConcat === 0 &&
        result.failures.length === 0
    ) {
        vscode.window.showInformationMessage('No SQL to format.');
        return;
    }

    if (result.edits.length > 0) {
        const edit = new vscode.WorkspaceEdit();
        for (const textEdit of result.edits) {
            edit.replace(target.document.uri, textEdit.range, textEdit.newText);
        }
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage('Could not apply SQL formatting.');
            return;
        }
    }

    if (result.failures.length > 0 && result.formatted === 0) {
        vscode.window.showWarningMessage(`Could not format: ${result.failures[0]}`);
        return;
    }
    if (result.skippedConcat > 0 && result.formatted === 0) {
        vscode.window.showWarningMessage(
            'Skipped concatenated SQL strings (format those as one triple-quoted string).'
        );
        return;
    }
    vscode.window.showInformationMessage(
        result.formatted > 0
            ? isSqlDocument(target.document)
                ? 'Formatted SQL.'
                : 'Formatted SQL string.'
            : 'SQL is already formatted.'
    );
}

export async function formatSqlAt(db: SqlServerService, ...args: unknown[]): Promise<void> {
    const target = await targetFromLensArgs(...args);
    if (!target) {
        return;
    }
    await formatSqlTarget(db, target);
}

async function targetFromLensArgs(...args: unknown[]): Promise<SqlTarget | undefined> {
    const lens = pickLensArgs(...args);
    if (!lens) {
        vscode.window.showWarningMessage('Could not find that SQL statement.');
        return undefined;
    }
    const target = await resolveSqlTargetFromArgs(lens);
    if (!target) {
        vscode.window.showWarningMessage('Could not find that SQL statement.');
    }
    return target;
}
