import { ProjectCacheMeta } from './bigqueryCache';
import { SchemaCache } from './schemaCache';
import { TableInfo } from './schemaTypes';

export const CATALOG_VERSION = 2;

export type CatalogFile = {
    version: number;
    connectionKey: string;
    fetchedAt: number;
    databases: string[];
    projects: string[];
    projectMeta: Record<string, ProjectCacheMeta>;
};

export type ExplorerProfileCache = {
    tables: TableInfo[];
    fetchedAt: number;
    stale: boolean;
    extraDatabases: string[];
    projects: string[];
    cachedProjects: string[];
    projectMeta: Record<string, ProjectCacheMeta>;
    homeProject: string;
    hasSchema: boolean;
};

export function catalogFileName(connectionKey: string): string {
    return `catalog-${connectionKey}.json`;
}

export function schemaFileName(connectionKey: string): string {
    return `schema-${connectionKey}.json`;
}

export function emptyExplorerCache(): ExplorerProfileCache {
    return {
        tables: [],
        fetchedAt: 0,
        stale: false,
        extraDatabases: [],
        projects: [],
        cachedProjects: [],
        projectMeta: {},
        homeProject: '',
        hasSchema: false
    };
}

export function uniqueNames(names: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
        const trimmed = name.trim();
        if (!trimmed) {
            continue;
        }
        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(trimmed);
    }
    return result;
}

function normalizeProjectMeta(raw: unknown): Record<string, ProjectCacheMeta> {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const result: Record<string, ProjectCacheMeta> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        const entry = value as Record<string, unknown>;
        const fetchedAt = typeof entry.fetchedAt === 'number' ? entry.fetchedAt : 0;
        const datasets = uniqueNames(
            Array.isArray(entry.datasets) ? entry.datasets.map(String) : []
        );
        result[key.toLowerCase()] = { fetchedAt, datasets };
    }
    return result;
}

export function parseCatalogJson(raw: unknown): CatalogFile | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const value = raw as Record<string, unknown>;
    const version = value.version;
    if (version !== CATALOG_VERSION && version !== 1) {
        return undefined;
    }
    const connectionKey = typeof value.connectionKey === 'string' ? value.connectionKey.trim() : '';
    if (!connectionKey) {
        return undefined;
    }
    const fetchedAt = typeof value.fetchedAt === 'number' ? value.fetchedAt : 0;
    return {
        version: CATALOG_VERSION,
        connectionKey,
        fetchedAt,
        databases: uniqueNames(Array.isArray(value.databases) ? value.databases.map(String) : []),
        projects: uniqueNames(Array.isArray(value.projects) ? value.projects.map(String) : []),
        projectMeta: version === CATALOG_VERSION ? normalizeProjectMeta(value.projectMeta) : {}
    };
}

export function mergeCatalogPatch(
    existing: CatalogFile | undefined,
    connectionKey: string,
    patch: {
        databases?: string[];
        projects?: string[];
        projectMeta?: Record<string, ProjectCacheMeta>;
    },
    fetchedAt = Date.now()
): CatalogFile {
    const nextMeta = { ...(existing?.projectMeta ?? {}) };
    if (patch.projectMeta) {
        for (const [projectId, meta] of Object.entries(patch.projectMeta)) {
            nextMeta[projectId.toLowerCase()] = {
                fetchedAt: meta.fetchedAt,
                datasets: uniqueNames(meta.datasets)
            };
        }
    }
    return {
        version: CATALOG_VERSION,
        connectionKey,
        fetchedAt,
        databases:
            patch.databases !== undefined
                ? uniqueNames(patch.databases)
                : (existing?.databases ?? []),
        projects:
            patch.projects !== undefined ? uniqueNames(patch.projects) : (existing?.projects ?? []),
        projectMeta: nextMeta
    };
}

export function mergeExplorerCache(input: {
    tables: TableInfo[];
    fetchedAt: number;
    stale: boolean;
    catalog?: CatalogFile;
    cachedProjects?: string[];
    homeProject?: string;
}): ExplorerProfileCache {
    const catalog = input.catalog;
    return {
        tables: input.tables,
        fetchedAt: input.fetchedAt || catalog?.fetchedAt || 0,
        stale: input.stale,
        extraDatabases: catalog?.databases ?? [],
        projects: catalog?.projects ?? [],
        cachedProjects: input.cachedProjects ?? [],
        projectMeta: catalog?.projectMeta ?? {},
        homeProject: input.homeProject ?? '',
        hasSchema: input.tables.length > 0
    };
}

export function tablesFromSchema(schema: SchemaCache | undefined): TableInfo[] {
    return schema?.tables ?? [];
}
