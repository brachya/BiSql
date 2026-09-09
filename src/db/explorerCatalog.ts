import { SchemaCache } from './schemaCache';
import { TableInfo } from './schemaTypes';

export const CATALOG_VERSION = 1;

export type CatalogFile = {
    version: number;
    connectionKey: string;
    fetchedAt: number;
    databases: string[];
    projects: string[];
};

export type ExplorerProfileCache = {
    tables: TableInfo[];
    fetchedAt: number;
    stale: boolean;
    extraDatabases: string[];
    projects: string[];
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

export function parseCatalogJson(raw: unknown): CatalogFile | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const value = raw as Record<string, unknown>;
    if (value.version !== CATALOG_VERSION) {
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
        projects: uniqueNames(Array.isArray(value.projects) ? value.projects.map(String) : [])
    };
}

export function mergeCatalogPatch(
    existing: CatalogFile | undefined,
    connectionKey: string,
    patch: { databases?: string[]; projects?: string[] },
    fetchedAt = Date.now()
): CatalogFile {
    return {
        version: CATALOG_VERSION,
        connectionKey,
        fetchedAt,
        databases:
            patch.databases !== undefined
                ? uniqueNames(patch.databases)
                : (existing?.databases ?? []),
        projects:
            patch.projects !== undefined ? uniqueNames(patch.projects) : (existing?.projects ?? [])
    };
}

export function mergeExplorerCache(input: {
    tables: TableInfo[];
    fetchedAt: number;
    stale: boolean;
    catalog?: CatalogFile;
}): ExplorerProfileCache {
    const catalog = input.catalog;
    return {
        tables: input.tables,
        fetchedAt: input.fetchedAt || catalog?.fetchedAt || 0,
        stale: input.stale,
        extraDatabases: catalog?.databases ?? [],
        projects: catalog?.projects ?? [],
        hasSchema: input.tables.length > 0
    };
}

export function tablesFromSchema(schema: SchemaCache | undefined): TableInfo[] {
    return schema?.tables ?? [];
}
