import { ConnectionProfile } from '../db/connectionProfiles';
import { parseBigqueryDatasetRef } from '../db/bigquery';
import {
    datasetNamesForProject,
    effectiveCachedProjects,
    isCachedProject
} from '../db/bigqueryCache';
import { DbEngine } from '../db/engines';
import { ExplorerProfileCache, uniqueNames } from '../db/explorerCatalog';
import { ColumnInfo, TableInfo } from '../db/schemaTypes';
import { connectionSwitchDetail } from '../commands/switchConnectionPicks';

export const ADD_CONNECTION_ID = 'add';
export const HINT_LABEL = 'Switch and Refresh to cache schema.';

/** When a parent has more than this many databases, the tree groups by letter prefix. */
export const DB_TREE_GROUP_THRESHOLD = 50;

export type TreeKind =
    | 'connection'
    | 'hint'
    | 'status'
    | 'projects'
    | 'project'
    | 'databaseGroup'
    | 'database'
    | 'schema'
    | 'tablesFolder'
    | 'viewsFolder'
    | 'table'
    | 'view'
    | 'column'
    | 'addConnection';

export type TreeNode = {
    id: string;
    kind: TreeKind;
    label: string;
    description?: string;
    tooltip?: string;
    contextValue: string;
    collapsible: boolean;
    parentId?: string;
    profileId: string;
    copyText?: string;
    qualifiedName?: string;
    projectId?: string;
    database?: string;
    /** Names in this letter group (only on databaseGroup nodes). */
    groupDatabaseNames?: string[];
    schemaName?: string;
    columnName?: string;
    active?: boolean;
    cached?: boolean;
};

export function usesSchemaLevel(engine: DbEngine): boolean {
    return engine === 'mssql' || engine === 'postgres';
}

export function databaseGroupKey(
    table: TableInfo,
    engine: DbEngine,
    homeProject: string
): string {
    if (engine === 'bigquery') {
        const home = homeProject.trim();
        if (home && table.database.toLowerCase() === home.toLowerCase()) {
            return table.schema;
        }
        if (table.database && table.schema) {
            return `${table.database}.${table.schema}`;
        }
        return table.schema || table.database;
    }
    return table.database;
}

/** Group key the schema map uses. BigQuery is project.dataset, even when the tree shows only the dataset. */
export function schemaMapGroupKey(
    table: { database: string; schema: string },
    engine: DbEngine
): string {
    if (engine === 'bigquery') {
        return `${table.database}.${table.schema}`;
    }
    if (engine === 'postgres') {
        return table.schema;
    }
    return table.database;
}

/**
 * Map group for a tree node. A BigQuery home dataset is stored as the dataset
 * name alone; the map needs project.dataset.
 */
export function schemaMapGroupFromNode(
    node: { database?: string; schemaName?: string; qualifiedName?: string },
    engine: DbEngine,
    tables: readonly { database: string; schema: string; qualifiedName: string }[],
    homeProject = ''
): string | undefined {
    if (node.qualifiedName) {
        const key = node.qualifiedName.toLowerCase();
        const table = tables.find((item) => item.qualifiedName.toLowerCase() === key);
        if (table) {
            return schemaMapGroupKey(table, engine);
        }
    }
    if (engine === 'bigquery') {
        return bigqueryMapGroup(node, tables, homeProject);
    }
    if (engine === 'postgres') {
        return node.schemaName || node.database;
    }
    return node.database;
}

function bigqueryMapGroup(
    node: { database?: string; schemaName?: string },
    tables: readonly { database: string; schema: string }[],
    homeProject: string
): string | undefined {
    if (node.database && node.schemaName) {
        return `${node.database}.${node.schemaName}`;
    }
    const label = node.database;
    if (!label) {
        return undefined;
    }
    const lower = label.toLowerCase();
    const exact = tables.find(
        (table) => schemaMapGroupKey(table, 'bigquery').toLowerCase() === lower
    );
    if (exact) {
        return schemaMapGroupKey(exact, 'bigquery');
    }
    const home = homeProject.trim().toLowerCase();
    if (home) {
        const homeHit = tables.find(
            (table) =>
                table.database.toLowerCase() === home && table.schema.toLowerCase() === lower
        );
        if (homeHit) {
            return schemaMapGroupKey(homeHit, 'bigquery');
        }
    }
    return label;
}

export function connectionNode(
    profile: ConnectionProfile,
    active: boolean,
    cache: ExplorerProfileCache
): TreeNode {
    const cached = cache.hasSchema && (!active || cache.stale);
    return {
        id: connectionId(profile.id),
        kind: 'connection',
        label: profile.name,
        description: active ? 'Active' : cache.hasSchema ? 'Cached' : undefined,
        tooltip: connectionSwitchDetail(profile),
        contextValue: active ? 'connectionActive' : 'connectionInactive',
        collapsible: true,
        profileId: profile.id,
        copyText: profile.name,
        active,
        cached
    };
}

export function addConnectionNode(): TreeNode {
    return {
        id: ADD_CONNECTION_ID,
        kind: 'addConnection',
        label: 'Add connection…',
        contextValue: 'connectionAdd',
        collapsible: false,
        profileId: ''
    };
}

export function connectionChildren(
    profile: ConnectionProfile,
    active: boolean,
    cache: ExplorerProfileCache,
    options: {
        connectionState?: string;
        lastError?: string;
        /** When set, only these databases appear under the connection. */
        sidebarDatabases?: string[];
    } = {}
): TreeNode[] {
    const parentId = connectionId(profile.id);
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const hasProjects = profile.engine === 'bigquery' && (cache.projects.length > 0 || active);
    const allDatabases = databaseNames(profile.engine, home, cache);
    const databases = options.sidebarDatabases
        ? allDatabases.filter((name) =>
              options.sidebarDatabases!.some((item) => item.toLowerCase() === name.toLowerCase())
          )
        : allDatabases;
    const nodes: TreeNode[] = [];

    if (active) {
        nodes.push(statusNode(profile.id, parentId, options.connectionState, options.lastError, cache));
    }

    if (profile.engine === 'bigquery' && hasProjects) {
        nodes.push({
            id: `${parentId}:projects`,
            kind: 'projects',
            label: 'Projects',
            description: cache.projects.length ? String(cache.projects.length) : undefined,
            contextValue: 'projects',
            collapsible: true,
            parentId,
            profileId: profile.id,
            active
        });
    }

    nodes.push(...databaseTreeNodes(profile, parentId, databases, cache, active));

    if (!cache.hasSchema && allDatabases.length === 0 && !hasProjects) {
        nodes.push({
            id: `${parentId}:hint`,
            kind: 'hint',
            label: HINT_LABEL,
            contextValue: 'hint',
            collapsible: false,
            parentId,
            profileId: profile.id
        });
    }

    return nodes;
}

export function projectNodes(
    profile: ConnectionProfile,
    cache: ExplorerProfileCache,
    active: boolean
): TreeNode[] {
    const parentId = `${connectionId(profile.id)}:projects`;
    const homeProject = cache.homeProject || profile.server;
    const cachedList = effectiveCachedProjects(homeProject, cache.cachedProjects);
    return cache.projects.map((projectId) => {
        const cached = cachedList.some(
            (project) => project.toLowerCase() === projectId.toLowerCase()
        );
        const home = homeProject.trim().toLowerCase();
        const isHome = home.length > 0 && projectId.toLowerCase() === home;
        return {
            id: projectNodeId(profile.id, projectId),
            kind: 'project' as const,
            label: projectId,
            description: projectDescription(projectId, homeProject, cache),
            contextValue: isHome ? 'projectHomeCached' : cached ? 'projectCached' : 'project',
            collapsible: cached && !isHome,
            parentId,
            profileId: profile.id,
            projectId,
            copyText: projectId,
            active,
            cached
        };
    });
}

export function projectDatasetNodes(
    profile: ConnectionProfile,
    projectId: string,
    cache: ExplorerProfileCache,
    active: boolean,
    sidebarDatabases?: string[]
): TreeNode[] {
    const homeProject = cache.homeProject || profile.server;
    if (homeProject.trim() && projectId.toLowerCase() === homeProject.trim().toLowerCase()) {
        return [];
    }
    const parentId = projectNodeId(profile.id, projectId);
    let datasets = datasetNamesForProject(
        homeProject,
        projectId,
        cache.tables,
        cache.extraDatabases
    );
    if (sidebarDatabases) {
        const allowed = new Set(sidebarDatabases.map((name) => name.toLowerCase()));
        datasets = datasets.filter((name) => allowed.has(name.toLowerCase()));
    }
    return databaseTreeNodes(profile, parentId, datasets, cache, active);
}

function projectDescription(
    projectId: string,
    homeProject: string,
    cache: ExplorerProfileCache
): string | undefined {
    const home = homeProject.trim().toLowerCase();
    const key = projectId.toLowerCase();
    const cached = isCachedProject(projectId, homeProject, cache.cachedProjects);
    if (key === home) {
        return 'Home';
    }
    if (!cached) {
        return undefined;
    }
    const meta = cache.projectMeta[key];
    const tablesHere = cache.tables.some((table) => table.database.toLowerCase() === key);
    if (!meta?.fetchedAt && !tablesHere) {
        return 'Cached · not loaded';
    }
    if (cache.stale || projectMetaIsStale(cache, meta?.fetchedAt)) {
        return 'Cached · stale';
    }
    return 'Cached';
}

/** A project is stale when a later refresh updated some other project and skipped this one. */
function projectMetaIsStale(cache: ExplorerProfileCache, fetchedAt: number | undefined): boolean {
    let latest = 0;
    for (const meta of Object.values(cache.projectMeta)) {
        if (meta.fetchedAt > latest) {
            latest = meta.fetchedAt;
        }
    }
    if (latest === 0) {
        return false;
    }
    return fetchedAt === undefined || fetchedAt < latest;
}

function projectNodeId(profileId: string, projectId: string): string {
    return `${connectionId(profileId)}:projects:p:${encodeURIComponent(projectId)}`;
}

export function databaseChildren(
    profile: ConnectionProfile,
    database: string,
    cache: ExplorerProfileCache,
    active: boolean,
    dbNodeId: string
): TreeNode[] {
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const tables = tablesInDatabase(cache.tables, profile.engine, home, database);
    if (!usesSchemaLevel(profile.engine)) {
        return objectFolders(profile.id, dbNodeId, database, undefined, tables, active);
    }
    const schemas = uniqueNames(tables.map((table) => table.schema)).sort(compareNames);
    return schemas.map((schemaName) => ({
        id: `${dbNodeId}:s:${encodeURIComponent(schemaName)}`,
        kind: 'schema' as const,
        label: schemaName,
        contextValue: 'schema',
        collapsible: true,
        parentId: dbNodeId,
        profileId: profile.id,
        database,
        schemaName,
        copyText: schemaName,
        active,
        cached: !active || cache.stale
    }));
}

export function schemaChildren(
    profile: ConnectionProfile,
    database: string,
    schemaName: string,
    cache: ExplorerProfileCache,
    active: boolean,
    schemaNodeId: string
): TreeNode[] {
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const tables = tablesInDatabase(cache.tables, profile.engine, home, database).filter(
        (table) => table.schema.toLowerCase() === schemaName.toLowerCase()
    );
    return objectFolders(profile.id, schemaNodeId, database, schemaName, tables, active);
}

export function objectChildren(
    profile: ConnectionProfile,
    database: string,
    schemaName: string | undefined,
    views: boolean,
    cache: ExplorerProfileCache,
    active: boolean,
    folderNodeId: string
): TreeNode[] {
    const home = profile.engine === 'bigquery' ? profile.server : '';
    return tablesInDatabase(cache.tables, profile.engine, home, database)
        .filter((table) => {
            if (schemaName !== undefined && table.schema.toLowerCase() !== schemaName.toLowerCase()) {
                return false;
            }
            return table.isView === views;
        })
        .sort((left, right) => compareNames(left.name, right.name))
        .map((table) => tableNode(profile, folderNodeId, table, active, cache.stale));
}

export function columnChildren(
    profile: ConnectionProfile,
    table: TableInfo,
    active: boolean,
    tableNodeId: string
): TreeNode[] {
    const parentId = tableNodeId;
    const columns = [...table.columns].sort(
        (left, right) => left.ordinal - right.ordinal || compareNames(left.name, right.name)
    );
    return columns.map((column) => columnNode(profile.id, parentId, table, column, active));
}

export function findTable(
    cache: ExplorerProfileCache,
    qualifiedName: string
): TableInfo | undefined {
    const key = qualifiedName.toLowerCase();
    return cache.tables.find((table) => table.qualifiedName.toLowerCase() === key);
}

export function nodePathToTable(
    profile: ConnectionProfile,
    active: boolean,
    cache: ExplorerProfileCache,
    qualifiedName: string,
    sidebarDatabases?: string[]
): TreeNode[] {
    const table = findTable(cache, qualifiedName);
    if (!table) {
        return [];
    }
    const conn = connectionNode(profile, active, cache);
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const database = databaseGroupKey(table, profile.engine, home);
    const otherProject =
        profile.engine === 'bigquery' &&
        home.length > 0 &&
        table.database.toLowerCase() !== home.toLowerCase() &&
        cache.projects.length > 0;
    let dbParentId = conn.id;
    const path: TreeNode[] = [conn];
    if (otherProject) {
        const projectsId = `${conn.id}:projects`;
        path.push({
            id: projectsId,
            kind: 'projects',
            label: 'Projects',
            contextValue: 'projects',
            collapsible: true,
            parentId: conn.id,
            profileId: profile.id,
            active
        });
        const projectNode = projectNodes(profile, cache, active).find(
            (node) => node.projectId?.toLowerCase() === table.database.toLowerCase()
        );
        if (!projectNode) {
            return [];
        }
        path.push(projectNode);
        dbParentId = projectNode.id;
    }
    const homeForList = profile.engine === 'bigquery' ? profile.server : '';
    let namesForTree = databaseNames(profile.engine, homeForList, cache);
    if (otherProject && table.database) {
        namesForTree = datasetNamesForProject(
            homeForList,
            table.database,
            cache.tables,
            cache.extraDatabases
        );
    }
    if (sidebarDatabases) {
        const allowed = new Set(sidebarDatabases.map((name) => name.toLowerCase()));
        namesForTree = namesForTree.filter((name) => allowed.has(name.toLowerCase()));
    }
    if (
        !appendDatabasePath(path, profile, dbParentId, database, cache, active, namesForTree)
    ) {
        return [];
    }
    const dbNode = path[path.length - 1];
    let folderParent = dbNode.id;
    let schemaName: string | undefined;
    if (usesSchemaLevel(profile.engine)) {
        const schemaNode = databaseChildren(profile, database, cache, active, dbNode.id).find(
            (node) => node.schemaName?.toLowerCase() === table.schema.toLowerCase()
        );
        if (schemaNode) {
            path.push(schemaNode);
            folderParent = schemaNode.id;
            schemaName = table.schema;
        }
    }
    const folders = objectFolders(profile.id, folderParent, database, schemaName, [table], active);
    const folder = folders.find((node) => node.kind === (table.isView ? 'viewsFolder' : 'tablesFolder'));
    if (folder) {
        path.push(folder);
    }
    path.push(tableNode(profile, folder?.id ?? folderParent, table, active, cache.stale));
    return path;
}

export function connectionDatabaseNames(
    engine: DbEngine,
    homeProject: string,
    cache: ExplorerProfileCache
): string[] {
    return databaseNames(engine, homeProject, cache);
}

/** Every database/dataset name that can appear under this connection in the explorer. */
export function allSidebarFilterDatabaseNames(
    profile: ConnectionProfile,
    cache: ExplorerProfileCache
): string[] {
    const home = profile.engine === 'bigquery' ? profile.server : '';
    let names = connectionDatabaseNames(profile.engine, home, cache);
    if (profile.engine !== 'bigquery' || cache.projects.length === 0) {
        return names;
    }
    const merged = uniqueNames([...names]);
    const homeKey = home.trim().toLowerCase();
    for (const projectId of cache.projects) {
        if (homeKey.length > 0 && projectId.toLowerCase() === homeKey) {
            continue;
        }
        const datasets = datasetNamesForProject(
            home,
            projectId,
            cache.tables,
            cache.extraDatabases
        );
        for (const dataset of datasets) {
            if (!merged.some((name) => name.toLowerCase() === dataset.toLowerCase())) {
                merged.push(dataset);
            }
        }
    }
    return merged.sort(compareNames);
}

export function databaseTreeNodes(
    profile: ConnectionProfile,
    parentId: string,
    names: readonly string[],
    cache: ExplorerProfileCache,
    active: boolean
): TreeNode[] {
    const sorted = uniqueNames([...names]).sort(compareNames);
    if (sorted.length <= DB_TREE_GROUP_THRESHOLD) {
        return sorted.map((name) => databaseNode(profile, parentId, name, cache, active));
    }
    return splitDatabaseGroupsForTree(sorted).map((group) =>
        databaseGroupNode(profile, parentId, group.label, group.names, cache, active)
    );
}

/** Letter buckets for large database lists (exported for tests). */
export function splitDatabaseGroupsForTree(names: readonly string[]): { label: string; names: string[] }[] {
    if (names.length <= DB_TREE_GROUP_THRESHOLD) {
        return [{ label: '', names: [...names] }];
    }
    const byLetter = new Map<string, string[]>();
    for (const name of names) {
        const label = databaseGroupLetter(name);
        const bucket = byLetter.get(label) ?? [];
        bucket.push(name);
        byLetter.set(label, bucket);
    }
    const groups: { label: string; names: string[] }[] = [];
    for (const [label, bucket] of byLetter.entries()) {
        const sorted = bucket.sort(compareNames);
        if (sorted.length <= DB_TREE_GROUP_THRESHOLD) {
            groups.push({ label, names: sorted });
            continue;
        }
        const byPrefix = new Map<string, string[]>();
        for (const name of sorted) {
            const prefix = databaseGroupPrefix(name);
            const sub = byPrefix.get(prefix) ?? [];
            sub.push(name);
            byPrefix.set(prefix, sub);
        }
        let prefixSplit = false;
        for (const subNames of byPrefix.values()) {
            if (subNames.length > DB_TREE_GROUP_THRESHOLD) {
                prefixSplit = true;
                break;
            }
        }
        if (prefixSplit) {
            for (const chunk of chunkDatabaseNames(sorted)) {
                groups.push({ label: `${label} · ${chunk.label}`, names: chunk.names });
            }
            continue;
        }
        for (const [prefix, subNames] of byPrefix.entries()) {
            groups.push({ label: prefix, names: subNames.sort(compareNames) });
        }
    }
    return groups.sort((left, right) => compareNames(left.label, right.label));
}

function chunkDatabaseNames(names: string[]): { label: string; names: string[] }[] {
    const sorted = [...names].sort(compareNames);
    const chunks: { label: string; names: string[] }[] = [];
    for (let start = 0; start < sorted.length; start += DB_TREE_GROUP_THRESHOLD) {
        const slice = sorted.slice(start, start + DB_TREE_GROUP_THRESHOLD);
        const first = slice[0];
        const last = slice[slice.length - 1];
        chunks.push({
            label: first === last ? first : `${first}–${last}`,
            names: slice
        });
    }
    return chunks;
}

function databaseGroupLetter(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        return '#';
    }
    const ch = trimmed[0];
    if (/[a-zA-Z]/.test(ch)) {
        return ch.toUpperCase();
    }
    return '#';
}

function databaseGroupPrefix(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length >= 2) {
        return trimmed.slice(0, 2).toUpperCase();
    }
    return databaseGroupLetter(name);
}

function databaseGroupNode(
    profile: ConnectionProfile,
    parentId: string,
    label: string,
    names: string[],
    cache: ExplorerProfileCache,
    active: boolean
): TreeNode {
    return {
        id: `${parentId}:g:${encodeURIComponent(label)}`,
        kind: 'databaseGroup',
        label,
        description: String(names.length),
        contextValue: 'databaseGroup',
        collapsible: true,
        parentId,
        profileId: profile.id,
        groupDatabaseNames: names,
        active,
        cached: !active || cache.stale
    };
}

function appendDatabasePath(
    path: TreeNode[],
    profile: ConnectionProfile,
    parentId: string,
    database: string,
    cache: ExplorerProfileCache,
    active: boolean,
    names: readonly string[]
): boolean {
    const nodes = databaseTreeNodes(profile, parentId, names, cache, active);
    for (const node of nodes) {
        if (node.kind === 'database' && node.database && sameDatabaseName(node.database, database)) {
            path.push(node);
            return true;
        }
    }
    for (const node of nodes) {
        if (node.kind !== 'databaseGroup' || !node.groupDatabaseNames) {
            continue;
        }
        if (!node.groupDatabaseNames.some((name) => sameDatabaseName(name, database))) {
            continue;
        }
        path.push(node);
        if (
            appendDatabasePath(path, profile, node.id, database, cache, active, node.groupDatabaseNames)
        ) {
            return true;
        }
        path.pop();
    }
    return false;
}

function sameDatabaseName(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

function databaseNames(
    engine: DbEngine,
    homeProject: string,
    cache: ExplorerProfileCache
): string[] {
    const fromTables = cache.tables.map((table) => databaseGroupKey(table, engine, homeProject));
    let names = uniqueNames([...fromTables, ...cache.extraDatabases]);
    if (engine === 'bigquery' && homeProject.trim() && cache.projects.length > 0) {
        const home = homeProject.trim().toLowerCase();
        names = names.filter((name) => {
            const ref = parseBigqueryDatasetRef(name, homeProject);
            return ref?.project.toLowerCase() === home;
        });
    }
    return names.sort(compareNames);
}

function tablesInDatabase(
    tables: TableInfo[],
    engine: DbEngine,
    homeProject: string,
    database: string
): TableInfo[] {
    const key = database.toLowerCase();
    return tables.filter((table) => databaseGroupKey(table, engine, homeProject).toLowerCase() === key);
}

function databaseNode(
    profile: ConnectionProfile,
    parentId: string,
    name: string,
    cache: ExplorerProfileCache,
    active: boolean
): TreeNode {
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const count = tablesInDatabase(cache.tables, profile.engine, home, name).length;
    return {
        id: `${parentId}:d:${encodeURIComponent(name)}`,
        kind: 'database',
        label: name,
        description: count ? String(count) : undefined,
        contextValue: 'database',
        collapsible: true,
        parentId,
        profileId: profile.id,
        database: name,
        copyText: name,
        active,
        cached: !active || cache.stale
    };
}

function objectFolders(
    profileId: string,
    parentId: string,
    database: string,
    schemaName: string | undefined,
    tables: TableInfo[],
    active: boolean
): TreeNode[] {
    const nodes: TreeNode[] = [];
    const tableCount = tables.filter((table) => !table.isView).length;
    const viewCount = tables.filter((table) => table.isView).length;
    if (tableCount > 0) {
        nodes.push({
            id: `${parentId}:tables`,
            kind: 'tablesFolder',
            label: 'Tables',
            description: String(tableCount),
            contextValue: 'tablesFolder',
            collapsible: true,
            parentId,
            profileId,
            database,
            schemaName,
            active
        });
    }
    if (viewCount > 0) {
        nodes.push({
            id: `${parentId}:views`,
            kind: 'viewsFolder',
            label: 'Views',
            description: String(viewCount),
            contextValue: 'viewsFolder',
            collapsible: true,
            parentId,
            profileId,
            database,
            schemaName,
            active
        });
    }
    return nodes;
}

function tableNode(
    profile: ConnectionProfile,
    parentId: string,
    table: TableInfo,
    active: boolean,
    stale: boolean
): TreeNode {
    const cached = !active || stale;
    return {
        id: `${parentId}:t:${encodeURIComponent(table.name)}`,
        kind: table.isView ? 'view' : 'table',
        label: table.name,
        description: cached ? 'Cached' : undefined,
        tooltip: table.qualifiedName,
        contextValue: table.isView ? 'view' : 'table',
        collapsible: table.columns.length > 0,
        parentId,
        profileId: profile.id,
        database: table.database,
        schemaName: table.schema,
        qualifiedName: table.qualifiedName,
        copyText: table.qualifiedName,
        active,
        cached
    };
}

function columnNode(
    profileId: string,
    parentId: string,
    table: TableInfo,
    column: ColumnInfo,
    active: boolean
): TreeNode {
    const flags: string[] = [];
    if (column.isPrimaryKey) {
        flags.push('PK');
    }
    flags.push(column.isNullable ? 'NULL' : 'NOT NULL');
    return {
        id: `${parentId}:col:${encodeURIComponent(column.name)}`,
        kind: 'column',
        label: column.name,
        description: `${column.typeDisplay}${flags.length ? ' · ' + flags.join(' · ') : ''}`,
        contextValue: column.isPrimaryKey ? 'columnPK' : 'column',
        collapsible: false,
        parentId,
        profileId,
        qualifiedName: table.qualifiedName,
        columnName: column.name,
        copyText: column.name,
        active
    };
}

function statusNode(
    profileId: string,
    parentId: string,
    state: string | undefined,
    lastError: string | undefined,
    cache: ExplorerProfileCache
): TreeNode {
    let label = 'Disconnected';
    if (state === 'connected') {
        label = cache.stale ? 'Connected · cached' : 'Connected';
    } else if (state === 'connecting') {
        label = 'Connecting…';
    } else if (state === 'error') {
        label = lastError ? `Error · ${lastError}` : 'Error';
    } else if (state === 'unconfigured') {
        label = 'Login needed';
    } else if (state === 'disabled') {
        label = 'Off';
    } else if (cache.hasSchema) {
        label = cache.stale ? 'Cached' : 'Ready';
    }
    return {
        id: `${parentId}:status`,
        kind: 'status',
        label,
        contextValue: 'status',
        collapsible: false,
        parentId,
        profileId
    };
}

function compareNames(left: string, right: string): number {
    return left.localeCompare(right);
}

export function connectionId(profileId: string): string {
    return `c:${profileId}`;
}

/** Stable id for reveal-in-sidebar when the tree path is unknown. */
export function tableId(profileId: string, qualifiedName: string): string {
    return `${connectionId(profileId)}:t:${encodeURIComponent(qualifiedName)}`;
}
