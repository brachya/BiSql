import { parseBigqueryDatasetRef, formatBigqueryDatasetRef } from './bigquery';
import { ExtensionConfig, selectedDatabases } from './config';
import { uniqueNames } from './explorerCatalog';
import { TableInfo } from './schemaTypes';

/** Warn before auto-adding this many datasets when pinning a project. */
export const BIGQUERY_DATASET_WARN = 50;

/** Soft cap on pinned projects beyond home. */
export const BIGQUERY_CACHE_PROJECT_MAX = 10;

export type ProjectCacheMeta = {
    fetchedAt: number;
    datasets: string[];
};

export function projectForDataset(raw: string, homeProject: string): string | undefined {
    const ref = parseBigqueryDatasetRef(raw, homeProject);
    return ref?.project;
}

/** Home is always cached; `cachedProjects` lists extra GCP projects. */
export function effectiveCachedProjects(homeProject: string, cachedProjects: readonly string[]): string[] {
    const home = homeProject.trim();
    const names = home ? [home, ...cachedProjects] : [...cachedProjects];
    return uniqueNames(names);
}

export function isCachedProject(
    projectId: string,
    homeProject: string,
    cachedProjects: readonly string[]
): boolean {
    const key = projectId.trim().toLowerCase();
    if (!key) {
        return false;
    }
    const home = homeProject.trim().toLowerCase();
    if (home && key === home) {
        return true;
    }
    return cachedProjects.some((project) => project.trim().toLowerCase() === key);
}

export function datasetsForProjects(
    config: Pick<ExtensionConfig, 'server' | 'database' | 'databases'>,
    projectIds: readonly string[]
): string[] {
    const home = config.server.trim();
    const wanted = new Set(projectIds.map((project) => project.trim().toLowerCase()).filter(Boolean));
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of selectedDatabases(config as ExtensionConfig)) {
        const ref = parseBigqueryDatasetRef(raw, home);
        if (!ref || !wanted.has(ref.project.toLowerCase())) {
            continue;
        }
        const key = `${ref.project.toLowerCase()}|${ref.dataset.toLowerCase()}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(formatBigqueryDatasetRef(ref, home));
    }
    return result.sort((left, right) => left.localeCompare(right));
}

export function datasetsForProject(
    config: Pick<ExtensionConfig, 'server' | 'database' | 'databases'>,
    projectId: string
): string[] {
    return datasetsForProjects(config, [projectId]);
}

export function tableBelongsToProject(table: TableInfo, projectId: string): boolean {
    return table.database.toLowerCase() === projectId.trim().toLowerCase();
}

export function datasetCacheKey(projectId: string, dataset: string): string {
    return `${projectId.trim().toLowerCase()}|${dataset.trim().toLowerCase()}`;
}

/**
 * Replace tables for the refreshed projects.
 * `failedDatasetKeys` keeps the old tables for a dataset whose fetch failed.
 * ponytail: a dataset BigQuery has dropped stays in the cache until a later fetch succeeds.
 */
export function mergeSchemaTables(
    existing: TableInfo[],
    incoming: TableInfo[],
    refreshedProjects: readonly string[],
    failedDatasetKeys?: ReadonlySet<string>
): TableInfo[] {
    const refreshSet = new Set(
        refreshedProjects.map((project) => project.trim().toLowerCase()).filter(Boolean)
    );
    const failed = failedDatasetKeys ?? new Set<string>();
    const kept = existing.filter((table) => {
        const project = table.database.toLowerCase();
        if (!refreshSet.has(project)) {
            return true;
        }
        return failed.has(datasetCacheKey(project, table.schema));
    });
    const byKey = new Map<string, TableInfo>();
    for (const table of kept) {
        byKey.set(table.qualifiedName.toLowerCase(), table);
    }
    for (const table of incoming) {
        byKey.set(table.qualifiedName.toLowerCase(), table);
    }
    return [...byKey.values()];
}

export function datasetNamesForProject(
    homeProject: string,
    projectId: string,
    tables: readonly TableInfo[],
    extraDatabases: readonly string[]
): string[] {
    const home = homeProject.trim();
    const key = projectId.trim().toLowerCase();
    const fromTables = tables
        .filter((table) => table.database.toLowerCase() === key)
        .map((table) => formatBigqueryDatasetRef({ project: table.database, dataset: table.schema }, home));
    const fromExtras = extraDatabases.filter((raw) => {
        const ref = parseBigqueryDatasetRef(raw, home);
        return ref?.project.toLowerCase() === key;
    });
    return uniqueNames([...fromTables, ...fromExtras]).sort((left, right) => left.localeCompare(right));
}

export function removeDatasetsForProject(
    homeProject: string,
    projectId: string,
    databases: readonly string[]
): string[] {
    const home = homeProject.trim();
    const key = projectId.trim().toLowerCase();
    return databases.filter((raw) => {
        const ref = parseBigqueryDatasetRef(raw, home);
        return ref?.project.toLowerCase() !== key;
    });
}

export function addUniqueDatasets(existing: readonly string[], toAdd: readonly string[]): string[] {
    return uniqueNames([...existing, ...toAdd]);
}
