import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { DiagnosticsManager } from '../providers/diagnostics';
import { Commands } from './ids';

/**
 * QuickPick of GCP projects for the active BigQuery login.
 */
export async function switchProject(
    db: SqlServerService,
    diagnostics: DiagnosticsManager
): Promise<void> {
    if (db.getConfig().engine !== 'bigquery') {
        const choice = await vscode.window.showWarningMessage(
            'Switch Project is for BigQuery. Use Switch Connection for other logins.',
            'Switch Connection'
        );
        if (choice === 'Switch Connection') {
            await vscode.commands.executeCommand(Commands.switchConnection);
        }
        return;
    }

    const listed = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Loading Google Cloud projects…'
        },
        () => db.listAccessibleProjects()
    );
    if (!listed.ok) {
        vscode.window.showErrorMessage(listed.message);
        return;
    }
    if (listed.projects.length === 0) {
        vscode.window.showWarningMessage(listed.message);
        return;
    }

    const home = db.getConfig().server.trim();
    const selected = await vscode.window.showQuickPick(
        listed.projects.map((id) => ({
            label: id,
            description: home && id.toLowerCase() === home.toLowerCase() ? 'Home' : undefined,
            picked: home.length > 0 && id.toLowerCase() === home.toLowerCase()
        })),
        {
            title: 'Switch project',
            placeHolder: 'Google Cloud project'
        }
    );
    if (!selected) {
        return;
    }
    if (home && selected.label.toLowerCase() === home.toLowerCase()) {
        return;
    }

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Switching to ${selected.label}…`
        },
        () => db.switchBigqueryProject(selected.label)
    );
    if (!result.ok) {
        vscode.window.showErrorMessage(result.message);
        return;
    }
    await diagnostics.revalidateOpenDocuments(true);
    vscode.window.showInformationMessage(result.message);
}
