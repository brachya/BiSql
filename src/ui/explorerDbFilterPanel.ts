import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import {
    hasSavedSidebarFilter,
    normalizeSidebarFilterVisible,
    readExplorerDbFilter,
    sidebarDatabaseNames,
    writeExplorerDbFilter
} from './explorerDbFilter';
import { fillWebviewPage, mediaRoot, tabIcon } from './media';
import { allSidebarFilterDatabaseNames } from './schemaTreeModel';
import { BisqlExplorerProvider } from './explorerTree';

type WebviewToExt = { type: 'ready' } | { type: 'save'; visible: string[] } | { type: 'cancel' };

export class ExplorerDbFilterPanel {
    private static current: ExplorerDbFilterPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly db: SqlServerService,
        private readonly explorer: BisqlExplorerProvider,
        private readonly profileId: string
    ) {
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (message: WebviewToExt) => void this.onMessage(message),
            null,
            this.disposables
        );
        this.panel.webview.html = fillWebviewPage('dbFilter', this.panel.webview, null);
    }

    public static show(
        context: vscode.ExtensionContext,
        db: SqlServerService,
        explorer: BisqlExplorerProvider,
        profileId?: string
    ): void {
        const id = profileId || db.getActiveConnectionId();
        if (!id) {
            void vscode.window.showWarningMessage('Choose a connection first.');
            return;
        }
        const profile = db.getProfile(id);
        if (!profile) {
            return;
        }
        if (ExplorerDbFilterPanel.current) {
            if (ExplorerDbFilterPanel.current.profileId === id) {
                ExplorerDbFilterPanel.current.panel.reveal();
                return;
            }
            ExplorerDbFilterPanel.current.panel.dispose();
        }
        const panel = vscode.window.createWebviewPanel(
            'bisqlDbFilter',
            'Sidebar databases',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot()] }
        );
        panel.iconPath = tabIcon('bisql-logo-light.svg', 'bisql-logo-dark.svg');
        ExplorerDbFilterPanel.current = new ExplorerDbFilterPanel(
            panel,
            context,
            db,
            explorer,
            id
        );
    }

    private async onMessage(message: WebviewToExt): Promise<void> {
        if (message.type === 'ready') {
            await this.postInit();
            return;
        }
        if (message.type === 'cancel') {
            this.panel.dispose();
            return;
        }
        if (message.type === 'save') {
            await this.saveFilter(message.visible);
        }
    }

    private async postInit(): Promise<void> {
        const profile = this.db.getProfile(this.profileId);
        if (!profile) {
            return;
        }
        const cache = await this.db.getExplorerCache(profile);
        const allNames = allSidebarFilterDatabaseNames(profile, cache);
        const filterMap = readExplorerDbFilter(this.context);
        const visibleNames = hasSavedSidebarFilter(this.profileId, filterMap)
            ? sidebarDatabaseNames(this.profileId, profile.database, allNames, filterMap)
            : allNames;
        await this.panel.webview.postMessage({
            type: 'init',
            connectionName: profile.name,
            defaultDatabase: profile.database,
            allNames,
            visibleNames
        });
    }

    private async saveFilter(visible: string[]): Promise<void> {
        const profile = this.db.getProfile(this.profileId);
        if (!profile) {
            return;
        }
        const cache = await this.db.getExplorerCache(profile);
        const allNames = allSidebarFilterDatabaseNames(profile, cache);
        const filterMap = { ...readExplorerDbFilter(this.context) };
        const normalized = normalizeSidebarFilterVisible(visible, allNames, profile.database);
        const showsAll =
            normalized.length >= allNames.length &&
            allNames.every((name) =>
                normalized.some((item) => item.toLowerCase() === name.toLowerCase())
            );
        if (showsAll) {
            delete filterMap[this.profileId];
        } else {
            filterMap[this.profileId] = normalized;
        }
        await writeExplorerDbFilter(this.context, filterMap);
        this.explorer.refreshSidebarFilter();
        this.panel.dispose();
        void vscode.window.showInformationMessage('Sidebar database filter saved.');
    }

    private dispose(): void {
        ExplorerDbFilterPanel.current = undefined;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }
}
