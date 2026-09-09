import { ConnectionProfile } from '../db/connectionProfiles';
import { DbEngine } from '../db/engines';
import { ExplorerProfileCache, uniqueNames } from '../db/explorerCatalog';
import { ColumnInfo, TableInfo } from '../db/schemaTypes';
import { connectionSwitchDetail } from '../commands/switchConnectionPicks';

export const ADD_CONNECTION_ID = 'add';
export const HINT_LABEL = 'Switch and Refresh to cache schema.';

export type TreeKind =
    | 'connection'
    | 'hint'
    | 'status'
    | 'projects'
    | 'project'
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
    } = {}
): TreeNode[] {
    const parentId = connectionId(profile.id);
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const hasProjects = profile.engine === 'bigquery' && (cache.projects.length > 0 || active);
    const databases = databaseNames(profile.engine, home, cache);
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

    for (const name of databases) {
        nodes.push(databaseNode(profile, parentId, name, cache, active));
    }

    if (!cache.hasSchema && databases.length === 0 && !hasProjects) {
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
    const home = profile.server.trim().toLowerCase();
    return cache.projects.map((projectId) => ({
        id: `${parentId}:p:${encodeURIComponent(projectId)}`,
        kind: 'project' as const,
        label: projectId,
        description: home && projectId.toLowerCase() === home ? 'Home' : undefined,
        contextValue: 'project',
        collapsible: false,
        parentId,
        profileId: profile.id,
        projectId,
        copyText: projectId,
        active
    }));
}

export function databaseChildren(
    profile: ConnectionProfile,
    database: string,
    cache: ExplorerProfileCache,
    active: boolean
): TreeNode[] {
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const tables = tablesInDatabase(cache.tables, profile.engine, home, database);
    const parentId = databaseId(profile.id, database);
    if (!usesSchemaLevel(profile.engine)) {
        return objectFolders(profile.id, parentId, database, undefined, tables, active);
    }
    const schemas = uniqueNames(tables.map((table) => table.schema)).sort(compareNames);
    return schemas.map((schemaName) => ({
        id: schemaId(profile.id, database, schemaName),
        kind: 'schema' as const,
        label: schemaName,
        contextValue: 'schema',
        collapsible: true,
        parentId,
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
    active: boolean
): TreeNode[] {
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const tables = tablesInDatabase(cache.tables, profile.engine, home, database).filter(
        (table) => table.schema.toLowerCase() === schemaName.toLowerCase()
    );
    return objectFolders(
        profile.id,
        schemaId(profile.id, database, schemaName),
        database,
        schemaName,
        tables,
        active
    );
}

export function objectChildren(
    profile: ConnectionProfile,
    database: string,
    schemaName: string | undefined,
    views: boolean,
    cache: ExplorerProfileCache,
    active: boolean
): TreeNode[] {
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const parentId = objectFolderId(profile.id, database, schemaName, views);
    return tablesInDatabase(cache.tables, profile.engine, home, database)
        .filter((table) => {
            if (schemaName !== undefined && table.schema.toLowerCase() !== schemaName.toLowerCase()) {
                return false;
            }
            return table.isView === views;
        })
        .sort((left, right) => compareNames(left.name, right.name))
        .map((table) => tableNode(profile, parentId, table, active, cache.stale));
}

export function columnChildren(
    profile: ConnectionProfile,
    table: TableInfo,
    active: boolean
): TreeNode[] {
    const parentId = tableId(profile.id, table.qualifiedName);
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
    qualifiedName: string
): TreeNode[] {
    const table = findTable(cache, qualifiedName);
    if (!table) {
        return [];
    }
    const conn = connectionNode(profile, active, cache);
    const home = profile.engine === 'bigquery' ? profile.server : '';
    const database = databaseGroupKey(table, profile.engine, home);
    const dbNode = databaseNode(profile, conn.id, database, cache, active);
    const path: TreeNode[] = [conn, dbNode];
    let folderParent = dbNode.id;
    let schemaName: string | undefined;
    if (usesSchemaLevel(profile.engine)) {
        const schemaNode = databaseChildren(profile, database, cache, active).find(
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

function databaseNames(
    engine: DbEngine,
    homeProject: string,
    cache: ExplorerProfileCache
): string[] {
    const fromTables = cache.tables.map((table) => databaseGroupKey(table, engine, homeProject));
    return uniqueNames([...fromTables, ...cache.extraDatabases]).sort(compareNames);
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
        id: databaseId(profile.id, name),
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
            id: objectFolderId(profileId, database, schemaName, false),
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
            id: objectFolderId(profileId, database, schemaName, true),
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
        id: tableId(profile.id, table.qualifiedName),
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

function databaseId(profileId: string, database: string): string {
    return `${connectionId(profileId)}:d:${encodeURIComponent(database)}`;
}

function schemaId(profileId: string, database: string, schemaName: string): string {
    return `${databaseId(profileId, database)}:s:${encodeURIComponent(schemaName)}`;
}

function objectFolderId(
    profileId: string,
    database: string,
    schemaName: string | undefined,
    views: boolean
): string {
    const parent =
        schemaName !== undefined
            ? schemaId(profileId, database, schemaName)
            : databaseId(profileId, database);
    return `${parent}:${views ? 'views' : 'tables'}`;
}

export function tableId(profileId: string, qualifiedName: string): string {
    return `${connectionId(profileId)}:t:${encodeURIComponent(qualifiedName)}`;
}
