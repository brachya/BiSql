import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { DiagnosticsManager } from '../providers/diagnostics';
import { Commands } from './ids';
import {
    connectionSwitchPicks,
    EDIT_CONNECTIONS_ID
} from './switchConnectionPicks';

/**
 * QuickPick of saved logins. No profiles, or the edit row, opens the login page.
 * Keeps a workspace pin so this folder stays on the login you pick.
 */
export async function switchConnection(
    db: SqlServerService,
    diagnostics: DiagnosticsManager
): Promise<void> {
    const profiles = db.listProfiles();
    if (profiles.length === 0) {
        await vscode.commands.executeCommand(Commands.openConnectionPanel);
        return;
    }

    const activeId = db.getActiveConnectionId();
    const items: Array<vscode.QuickPickItem & { id?: string }> = [];
    for (const pick of connectionSwitchPicks(profiles, activeId)) {
        if (pick.id === EDIT_CONNECTIONS_ID && items.length > 0) {
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        }
        items.push({
            id: pick.id,
            label: pick.label,
            description: pick.description,
            picked: pick.picked,
            alwaysShow: pick.id === EDIT_CONNECTIONS_ID
        });
    }

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Switch connection',
        placeHolder: 'Saved login',
        matchOnDescription: true
    });
    if (!selected?.id) {
        return;
    }
    if (selected.id === EDIT_CONNECTIONS_ID) {
        await vscode.commands.executeCommand(Commands.openConnectionPanel);
        return;
    }
    if (selected.id === activeId) {
        return;
    }

    await db.switchActive(selected.id, db.isActivePinnedToWorkspace());
    await diagnostics.revalidateOpenDocuments(true);
}
