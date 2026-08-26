import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { findFStringInterpolations } from '../sql/parameters';
import { explainResultToQuery } from '../sql/resultEdit';
import { pickLensArgs, resolveSqlTargetFromArgs } from '../sql/sqlTarget';
import { ResultsPanel } from '../ui/resultsPanel';
import { Commands } from './ids';
import { promptBindParams } from './runSelectedSql';

export async function explainSqlAt(db: SqlServerService, ...args: unknown[]): Promise<void> {
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

    const sql = target.sql;
    const interpolations = findFStringInterpolations(sql);
    if (interpolations.length > 0) {
        const sample = interpolations.slice(0, 3).join(', ');
        vscode.window.showErrorMessage(
            `This SQL still has Python interpolations (${sample}). Remove {…} first.`
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

    const params = await promptBindParams(sql, 'Explain SQL');
    if (params === undefined) {
        return;
    }

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Explaining SQL…',
            cancellable: false
        },
        () => db.explainQuery(sql, params)
    );

    const view = ResultsPanel.show(explainResultToQuery(result, params), db);
    view.setTitle(result.ok ? 'SQL Plan' : 'SQL Plan Error');
    if (!result.ok) {
        vscode.window.showErrorMessage(result.error ?? 'Explain failed.');
    } else if (result.note) {
        vscode.window.showInformationMessage(result.note);
    }
}
