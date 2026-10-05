import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { ConnectionProfile } from '../db/connectionProfiles';
import { ExplorerProfileCache } from '../db/explorerCatalog';
import {
    readExplorerDbFilter,
    sidebarDatabaseNames,
    type ExplorerDbFilterMap
} from './explorerDbFilter';
import {
    ADD_CONNECTION_ID,
    TreeKind,
    TreeNode,
    addConnectionNode,
    allSidebarFilterDatabaseNames,
    columnChildren,
    connectionChildren,
    databaseChildren,
    databaseTreeNodes,
    connectionNode,
    findTable,
    nodePathToTable,
    objectChildren,
    projectDatasetNodes,
    projectNodes,
    schemaChildren
} from './schemaTreeModel';

export class BisqlTreeItem extends vscode.TreeItem {
    constructor(public readonly node: TreeNode) {
        super(
            node.label,
            node.collapsible
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );
        this.id = node.id;
        this.contextValue = node.contextValue;
        this.description = node.description;
        this.tooltip = node.tooltip ?? node.label;
        this.iconPath = new vscode.ThemeIcon(iconFor(node.kind, node));
    }
}

export class BisqlExplorerProvider
    implements vscode.TreeDataProvider<BisqlTreeItem>, vscode.Disposable
{
    private readonly change = new vscode.EventEmitter<BisqlTreeItem | undefined>();
    public readonly onDidChangeTreeData = this.change.event;
    private readonly items = new Map<string, BisqlTreeItem>();
    private readonly cacheByProfile = new Map<string, ExplorerProfileCache>();
    private readonly disposables: vscode.Disposable[] = [];
    private projectsLoading = new Set<string>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly db: SqlServerService
    ) {
        this.disposables.push(
            this.db.onDidChangeState(() => this.refresh()),
            this.db.onDidChangeSchema(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration('bisql.connections') ||
                    event.affectsConfiguration('bisql.activeConnectionId')
                ) {
                    this.refresh();
                }
            })
        );
    }

    public refresh(): void {
        this.cacheByProfile.clear();
        this.change.fire(undefined);
    }

    public refreshSidebarFilter(): void {
        this.change.fire(undefined);
    }

    public getTreeItem(element: BisqlTreeItem): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: BisqlTreeItem): Promise<BisqlTreeItem[]> {
        if (!element) {
            return this.remember(await this.rootNodes());
        }
        return this.remember(await this.childNodes(element.node));
    }

    public getParent(element: BisqlTreeItem): BisqlTreeItem | undefined {
        const parentId = element.node.parentId;
        if (!parentId) {
            return undefined;
        }
        return this.items.get(parentId);
    }

    public async revealQualifiedName(
        treeView: vscode.TreeView<BisqlTreeItem>,
        qualifiedName: string
    ): Promise<void> {
        const profile = this.activeProfile();
        if (!profile) {
            return;
        }
        const cache = await this.cacheFor(profile);
        const sidebar = this.sidebarNames(profile, cache);
        const path = nodePathToTable(profile, true, cache, qualifiedName, sidebar);
        if (path.length === 0) {
            const table = findTable(cache, qualifiedName);
            if (table) {
                const unfiltered = nodePathToTable(profile, true, cache, qualifiedName);
                if (unfiltered.length > 0) {
                    void vscode.window.showWarningMessage(
                        'That database is hidden by the sidebar filter. Use Filter Sidebar Databases to show it.'
                    );
                }
            }
            return;
        }
        const items = this.remember(path.map((node) => new BisqlTreeItem(node)));
        const target = items[items.length - 1];
        await treeView.reveal(target, { expand: true, select: true, focus: true });
    }

    public nodeItem(node: TreeNode): BisqlTreeItem {
        return this.items.get(node.id) ?? new BisqlTreeItem(node);
    }

    public dispose(): void {
        this.change.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async rootNodes(): Promise<BisqlTreeItem[]> {
        const activeId = this.db.getActiveConnectionId();
        const items: BisqlTreeItem[] = [];
        for (const profile of this.db.listProfiles()) {
            const cache = await this.cacheFor(profile);
            items.push(new BisqlTreeItem(connectionNode(profile, profile.id === activeId, cache)));
        }
        items.push(new BisqlTreeItem(addConnectionNode()));
        return items;
    }

    private async childNodes(node: TreeNode): Promise<BisqlTreeItem[]> {
        if (node.id === ADD_CONNECTION_ID) {
            return [];
        }
        const profile = this.db.getProfile(node.profileId);
        if (!profile) {
            return [];
        }
        const active = profile.id === this.db.getActiveConnectionId();
        let cache = await this.cacheFor(profile);

        const sidebar = this.sidebarNames(profile, cache);
        if (node.kind === 'connection') {
            return connectionChildren(profile, active, cache, {
                connectionState: active ? this.db.connectionState : undefined,
                lastError: active ? this.db.lastErrorMessage : undefined,
                sidebarDatabases: sidebar
            }).map((child) => new BisqlTreeItem(child));
        }
        if (node.kind === 'projects') {
            cache = await this.ensureProjects(profile, cache, active);
            return projectNodes(profile, cache, active).map((child) => new BisqlTreeItem(child));
        }
        if (node.kind === 'project' && node.projectId) {
            return projectDatasetNodes(profile, node.projectId, cache, active, sidebar).map(
                (child) => new BisqlTreeItem(child)
            );
        }
        if (node.kind === 'databaseGroup' && node.groupDatabaseNames) {
            return databaseTreeNodes(profile, node.id, node.groupDatabaseNames, cache, active).map(
                (child) => new BisqlTreeItem(child)
            );
        }
        if (node.kind === 'database' && node.database) {
            return databaseChildren(profile, node.database, cache, active, node.id).map(
                (child) => new BisqlTreeItem(child)
            );
        }
        if (node.kind === 'schema' && node.database && node.schemaName) {
            return schemaChildren(profile, node.database, node.schemaName, cache, active, node.id).map(
                (child) => new BisqlTreeItem(child)
            );
        }
        if ((node.kind === 'tablesFolder' || node.kind === 'viewsFolder') && node.database) {
            return objectChildren(
                profile,
                node.database,
                node.schemaName,
                node.kind === 'viewsFolder',
                cache,
                active,
                node.id
            ).map((child) => new BisqlTreeItem(child));
        }
        if ((node.kind === 'table' || node.kind === 'view') && node.qualifiedName) {
            const table = findTable(cache, node.qualifiedName);
            if (!table) {
                return [];
            }
            return columnChildren(profile, table, active, node.id).map(
                (child) => new BisqlTreeItem(child)
            );
        }
        return [];
    }

    private async ensureProjects(
        profile: ConnectionProfile,
        cache: ExplorerProfileCache,
        active: boolean
    ): Promise<ExplorerProfileCache> {
        if (cache.projects.length > 0 || !active || profile.engine !== 'bigquery') {
            return cache;
        }
        if (this.projectsLoading.has(profile.id)) {
            return cache;
        }
        this.projectsLoading.add(profile.id);
        try {
            const listed = this.db.peekAccessibleProjects() ?? (await this.db.listAccessibleProjects());
            if (!listed.ok) {
                return cache;
            }
            const next = { ...cache, projects: listed.projects };
            this.cacheByProfile.set(profile.id, next);
            return next;
        } finally {
            this.projectsLoading.delete(profile.id);
        }
    }

    private async cacheFor(profile: ConnectionProfile): Promise<ExplorerProfileCache> {
        const hit = this.cacheByProfile.get(profile.id);
        if (hit) {
            return hit;
        }
        const cache = await this.db.getExplorerCache(profile);
        this.cacheByProfile.set(profile.id, cache);
        return cache;
    }

    private activeProfile(): ConnectionProfile | undefined {
        const id = this.db.getActiveConnectionId();
        return id ? this.db.getProfile(id) : undefined;
    }

    private filterMap(): ExplorerDbFilterMap {
        return readExplorerDbFilter(this.context);
    }

    private sidebarNames(profile: ConnectionProfile, cache: ExplorerProfileCache): string[] {
        const all = allSidebarFilterDatabaseNames(profile, cache);
        return sidebarDatabaseNames(profile.id, profile.database, all, this.filterMap());
    }

    private remember(items: BisqlTreeItem[]): BisqlTreeItem[] {
        for (const item of items) {
            this.items.set(item.node.id, item);
        }
        return items;
    }
}

function iconFor(kind: TreeKind, node: TreeNode): string {
    switch (kind) {
        case 'connection':
            return node.active ? 'database' : 'plug';
        case 'addConnection':
            return 'add';
        case 'hint':
            return 'info';
        case 'status':
            return 'circle-outline';
        case 'projects':
            return 'cloud';
        case 'project':
            return 'globe';
        case 'databaseGroup':
            return 'folder';
        case 'database':
            return 'server';
        case 'schema':
            return 'symbol-namespace';
        case 'tablesFolder':
        case 'viewsFolder':
            return 'folder';
        case 'table':
            return 'table';
        case 'view':
            return 'type-hierarchy';
        case 'column':
            return node.contextValue === 'columnPK' ? 'key' : 'symbol-field';
        default:
            return 'circle-outline';
    }
}
