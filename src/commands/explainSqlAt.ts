import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { explainResultToQuery } from '../sql/resultEdit';
import { pickLensArgs, resolveSqlTargetFromArgs } from '../sql/sqlTarget';
import { ResultsPanel, resultsTabTitle } from '../ui/resultsPanel';
import { Commands } from './ids';
import { promptRunParams } from './promptRunParams';

export async function explainSqlAt(db: SqlServerService, ...args: unknown[]): Promise<void> {
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

    const sql = target.sql;

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

    const params = await promptRunParams(sql, 'Explain SQL');
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
    view.linkSqlSource(target.block);
    view.setTitle(resultsTabTitle({ ok: result.ok, sql, readOnly: true }, false));
    if (!result.ok) {
        vscode.window.showErrorMessage(view.displayError());
    } else if (result.note) {
        vscode.window.showInformationMessage(result.note);
    }
}
