import * as vscode from 'vscode';
import { formatScanBytes } from '../db/bigquery';
import { DiagnosticsManager } from '../providers/diagnostics';
import { pickLensArgs, resolveSqlTargetFromArgs } from '../sql/sqlTarget';

export async function validateSqlAt(
    diagnostics: DiagnosticsManager,
    ...args: unknown[]
): Promise<void> {
    const lens = pickLensArgs(...args);
    if (!lens) {
        vscode.window.showWarningMessage('Could not find that SQL statement.');
        return;
    }
    const target = await resolveSqlTargetFromArgs(lens);
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
            const scan =
                result.scanBytes !== undefined
                    ? ` Estimated scan ${formatScanBytes(result.scanBytes)}.`
                    : '';
            vscode.window.showInformationMessage(`No issues in this SQL.${scan}`);
        }
        return;
    }
    vscode.window.showInformationMessage(
        `Found ${result.issues} issue${result.issues === 1 ? '' : 's'} in this SQL.`
    );
}
