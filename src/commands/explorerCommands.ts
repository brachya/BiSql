import * as vscode from 'vscode';
import { BIGQUERY_DATASET_WARN } from '../db/bigqueryCache';
import { SqlServerService } from '../db/connection';
import { DiagnosticsManager } from '../providers/diagnostics';
import { ConnectionPanel } from '../ui/connectionPanel';
import { pruneAndPersistExplorerDbFilter } from '../ui/explorerDbFilter';
import { ExplorerDbFilterPanel } from '../ui/explorerDbFilterPanel';
import { allSidebarFilterDatabaseNames } from '../ui/schemaTreeModel';
import { BisqlExplorerProvider, BisqlTreeItem } from '../ui/explorerTree';
import { copyText, formatSelectStar, previewTable } from '../ui/schemaActions';
import { SchemaExplorer } from '../ui/schemaExplorer';
import { findTable } from '../ui/schemaTreeModel';
import { refreshSchemaWithPicker } from './refreshSchema';
import { Commands } from './ids';

export function registerExplorerCommands(
    context: vscode.ExtensionContext,
    db: SqlServerService,
    diagnostics: DiagnosticsManager,
    explorer: BisqlExplorerProvider,
    treeView: vscode.TreeView<BisqlTreeItem>
): void {
    const openLogin = (profileId?: string) => {
        ConnectionPanel.show(context, db, diagnostics, profileId ? { profileId } : undefined);
    };

    const revealInSidebar = (qualifiedName: string) => {
        void explorer.revealQualifiedName(treeView, qualifiedName);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(Commands.explorerSwitchConnection, async (item?: BisqlTreeItem) => {
            const node = item?.node;
            if (!node?.profileId) {
                return;
            }
            if (node.profileId === db.getActiveConnectionId()) {
                return;
            }
            await db.switchActive(node.profileId, db.isActivePinnedToWorkspace());
            await diagnostics.revalidateOpenDocuments(true);
        }),
        vscode.commands.registerCommand(Commands.explorerEditConnection, (item?: BisqlTreeItem) => {
            openLogin(item?.node.profileId);
        }),
        vscode.commands.registerCommand(Commands.explorerAddConnection, async () => {
            const id = await db.addProfile();
            openLogin(id);
        }),
        vscode.commands.registerCommand(Commands.explorerTestConnection, async (item?: BisqlTreeItem) => {
            if (!(await ensureActive(db, diagnostics, item?.node.profileId))) {
                return;
            }
            const result = await db.testConnection();
            if (result.ok) {
                vscode.window.showInformationMessage(`Connected: ${result.message}`);
                await refreshSchemaWithPicker(db, diagnostics, { silent: true });
            } else {
                vscode.window.showErrorMessage(`Connection failed: ${result.message}`);
            }
        }),
        vscode.commands.registerCommand(Commands.explorerPinWorkspace, async (item?: BisqlTreeItem) => {
            const profileId = item?.node.profileId || db.getActiveConnectionId();
            if (!profileId) {
                return;
            }
            if (!db.hasWorkspaceFolder()) {
                vscode.window.showWarningMessage('Open a folder to pin this login to the workspace.');
                return;
            }
            await db.switchActive(profileId, true);
            await diagnostics.revalidateOpenDocuments(true);
            vscode.window.showInformationMessage('This folder stays on that login.');
        }),
        vscode.commands.registerCommand(Commands.explorerSwitchProject, async (item?: BisqlTreeItem) => {
            const projectId = item?.node.projectId;
            if (!projectId) {
                return;
            }
            if (!(await ensureActive(db, diagnostics, item?.node.profileId))) {
                return;
            }
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Switching to ${projectId}…`
                },
                () => db.switchBigqueryProject(projectId)
            );
            if (!result.ok) {
                vscode.window.showErrorMessage(result.message);
                return;
            }
            explorer.refresh();
            await diagnostics.revalidateOpenDocuments(true);
            vscode.window.showInformationMessage(result.message);
        }),
        vscode.commands.registerCommand(Commands.explorerRefreshProjects, async (item?: BisqlTreeItem) => {
            if (!(await ensureActive(db, diagnostics, item?.node.profileId))) {
                return;
            }
            const listed = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Loading Google Cloud projects…'
                },
                () => db.listAccessibleProjects()
            );
            explorer.refresh();
            if (!listed.ok) {
                vscode.window.showErrorMessage(listed.message);
                return;
            }
            vscode.window.showInformationMessage(listed.message);
        }),
        vscode.commands.registerCommand(
            Commands.explorerRefreshProjectSchema,
            async (item?: BisqlTreeItem) => {
                const projectId = item?.node.projectId;
                if (!projectId) {
                    return;
                }
                if (!(await ensureActive(db, diagnostics, item?.node.profileId))) {
                    return;
                }
                const refreshed = await refreshSchemaWithPicker(db, diagnostics, {
                    projects: [projectId]
                });
                if (refreshed.updated) {
                    explorer.refresh();
                }
            }
        ),
        vscode.commands.registerCommand(Commands.explorerPinProjectCache, async (item?: BisqlTreeItem) => {
            const projectId = item?.node.projectId;
            if (!projectId) {
                return;
            }
            if (!(await ensureActive(db, diagnostics, item?.node.profileId))) {
                return;
            }
            const listed = await db.listDatabases(projectId);
            if (!listed.ok) {
                vscode.window.showErrorMessage(listed.message);
                return;
            }
            if (listed.databases.length > BIGQUERY_DATASET_WARN) {
                const choice = await vscode.window.showWarningMessage(
                    `${projectId} has ${listed.databases.length} datasets. Cache all of them?`,
                    'Cache all',
                    'Cancel'
                );
                if (choice !== 'Cache all') {
                    return;
                }
            }
            const result = await db.pinBigqueryProjectForCache(projectId, { confirmLarge: false });
            if (!result.ok) {
                vscode.window.showErrorMessage(result.message);
                return;
            }
            explorer.refresh();
            await diagnostics.revalidateOpenDocuments(false);
            vscode.window.showInformationMessage(result.message);
        }),
        vscode.commands.registerCommand(Commands.explorerUnpinProjectCache, async (item?: BisqlTreeItem) => {
            const projectId = item?.node.projectId;
            if (!projectId) {
                return;
            }
            if (!(await ensureActive(db, diagnostics, item?.node.profileId))) {
                return;
            }
            const result = await db.setBigqueryProjectCached(projectId, false);
            if (!result.ok) {
                vscode.window.showErrorMessage(result.message);
                return;
            }
            explorer.refresh();
            vscode.window.showInformationMessage(result.message);
        }),
        vscode.commands.registerCommand(Commands.explorerPreviewTable, async (item?: BisqlTreeItem) => {
            const qualifiedName = item?.node.qualifiedName;
            if (!qualifiedName) {
                return;
            }
            if (!(await ensureActive(db, diagnostics, item?.node.profileId))) {
                return;
            }
            await previewTable(db, qualifiedName);
        }),
        vscode.commands.registerCommand(Commands.explorerOpenSchema, (item?: BisqlTreeItem) => {
            SchemaExplorer.show(db, () => openLogin(), {
                focusTable: item?.node.qualifiedName,
                revealInSidebar,
                diagnostics
            });
        }),
        vscode.commands.registerCommand(Commands.explorerRevealInSidebar, (qualifiedName?: string) => {
            if (typeof qualifiedName === 'string' && qualifiedName) {
                void explorer.revealQualifiedName(treeView, qualifiedName);
            }
        }),
        vscode.commands.registerCommand(Commands.explorerCopyName, async (item?: BisqlTreeItem) => {
            const text = item?.node.copyText;
            if (!text) {
                return;
            }
            await copyText(text);
        }),
        vscode.commands.registerCommand(Commands.explorerCopySelect, async (item?: BisqlTreeItem) => {
            const qualifiedName = item?.node.qualifiedName;
            const profileId = item?.node.profileId;
            if (!qualifiedName || !profileId) {
                return;
            }
            const profile = db.getProfile(profileId);
            if (!profile) {
                return;
            }
            const cache = await db.getExplorerCache(profile);
            const table = findTable(cache, qualifiedName);
            if (!table) {
                return;
            }
            await copyText(formatSelectStar(table, profile.engine));
        }),
        vscode.commands.registerCommand(Commands.explorerFilterDatabases, (item?: BisqlTreeItem) => {
            ExplorerDbFilterPanel.show(context, db, explorer, item?.node.profileId);
        }),
        vscode.commands.registerCommand(Commands.explorerRefreshSchema, async (item?: BisqlTreeItem) => {
            if (!(await ensureActive(db, diagnostics, item?.node.profileId))) {
                return;
            }
            const refreshed = await refreshSchemaWithPicker(db, diagnostics);
            if (refreshed.updated) {
                explorer.refresh();
                const profileId = item?.node.profileId || db.getActiveConnectionId();
                const profile = profileId ? db.getProfile(profileId) : undefined;
                if (profile) {
                    const cache = await db.getExplorerCache(profile);
                    await pruneAndPersistExplorerDbFilter(
                        context,
                        profile.id,
                        allSidebarFilterDatabaseNames(profile, cache),
                        profile.database
                    );
                    explorer.refreshSidebarFilter();
                }
            }
        })
    );
}

async function ensureActive(
    db: SqlServerService,
    diagnostics: DiagnosticsManager,
    profileId: string | undefined
): Promise<boolean> {
    if (!profileId || profileId === db.getActiveConnectionId()) {
        return true;
    }
    const choice = await vscode.window.showInformationMessage(
        'Switch to this connection first?',
        'Switch'
    );
    if (choice !== 'Switch') {
        return false;
    }
    await db.switchActive(profileId, db.isActivePinnedToWorkspace());
    await diagnostics.revalidateOpenDocuments(true);
    return true;
}
