import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { DiagnosticsManager } from '../providers/diagnostics';
import { pickLensArgs, resolveSqlTargetFromArgs } from '../sql/sqlTarget';

export async function validateSqlAt(
    db: SqlServerService,
    diagnostics: DiagnosticsManager,
    ...args: unknown[]
): Promise<void> {
    const lens = pickLensArgs(...args);
    if (!lens) {
        vscode.window.showWarningMessage('Could not find that SQL statement.');
        return;
    }
    const target = await resolveSqlTargetFromArgs(lens, db.getConfig().detectByKeyword);
    if (!target) {
        vscode.window.showWarningMessage('Could not find that SQL statement.');
        return;
    }

    const result = await diagnostics.validateTarget(target.document, target.block);
    if (result.notice) {
        vscode.window.showWarningMessage(result.notice);
    }
    if (result.issues === 0) {
        if (!result.notice) {
            vscode.window.showInformationMessage('No issues in this SQL.');
        }
        return;
    }
    vscode.window.showInformationMessage(
        `Found ${result.issues} issue${result.issues === 1 ? '' : 's'} in this SQL.`
    );
}
