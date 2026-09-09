import { BigQuery } from '@google-cloud/bigquery';
import { GoogleAuth } from 'google-auth-library';
import type { ColumnInfo, TableInfo } from './schemaTypes';

export interface BigqueryHandle {
    client: BigQuery;
    projectId: string;
}

export interface BigqueryDatasetRef {
    project: string;
    dataset: string;
}

/**
 * `dataset` is in the home project. `project.dataset` is an extra project.
 * Project ids have no dots, so one dot is enough.
 */
export function parseBigqueryDatasetRef(
    raw: string,
    homeProject: string
): BigqueryDatasetRef | undefined {
    const trimmed = raw.trim().replace(/`/g, '');
    if (!trimmed) {
        return undefined;
    }
    const parts = trimmed.split('.').filter((part) => part.length > 0);
    const home = homeProject.trim();
    if (parts.length === 1) {
        return home ? { project: home, dataset: parts[0] } : undefined;
    }
    if (parts.length === 2) {
        return { project: parts[0], dataset: parts[1] };
    }
    return undefined;
}

export function formatBigqueryDatasetRef(
    ref: BigqueryDatasetRef,
    homeProject: string
): string {
    if (ref.project.toLowerCase() === homeProject.trim().toLowerCase()) {
        return ref.dataset;
    }
    return `${ref.project}.${ref.dataset}`;
}

/** Search `other-proj.` or `other-proj.ds` means list that project. */
export function listProjectFromSearch(search: string, homeProject: string): string {
    const typed = search.trim().replace(/`/g, '');
    const dot = typed.indexOf('.');
    if (dot > 0) {
        return typed.slice(0, dot);
    }
    return homeProject.trim();
}

export function bigqueryLookupDefaults(
    homeProject: string,
    defaultRaw: string
): { database: string; schema: string } {
    const ref = parseBigqueryDatasetRef(defaultRaw, homeProject);
    return {
        database: ref?.project || homeProject.trim(),
        schema: ref?.dataset ?? ''
    };
}

/**
 * Rewrite stored dataset names when home changes. Bare names from the old
 * home become `old-project.dataset`. Names already in the new home become bare.
 */
export function retargetBigqueryHome(
    datasets: string[],
    defaultDatabase: string,
    oldHome: string,
    newHome: string
): { databases: string[]; database: string } {
    const prevHome = oldHome.trim();
    const nextHome = newHome.trim();
    const rewrite = (raw: string): string => {
        const trimmed = raw.trim();
        if (!trimmed) {
            return '';
        }
        const ref = parseBigqueryDatasetRef(trimmed, prevHome);
        if (!ref) {
            return trimmed;
        }
        return formatBigqueryDatasetRef(ref, nextHome);
    };
    const seen = new Set<string>();
    const databases: string[] = [];
    for (const raw of datasets) {
        const next = rewrite(raw);
        const key = next.toLowerCase();
        if (!next || seen.has(key)) {
            continue;
        }
        seen.add(key);
        databases.push(next);
    }
    const database = rewrite(defaultDatabase);
    return { databases, database };
}

interface SchemaRow {
    table_name: string;
    table_type: string;
    column_name: string;
    ordinal_position: number;
    data_type: string;
    is_nullable: string;
    is_generated: string;
}

export function createBigqueryHandle(projectId: string): BigqueryHandle {
    const trimmed = projectId.trim();
    return {
        client: new BigQuery({ projectId: trimmed }),
        projectId: trimmed
    };
}

export async function pingBigquery(handle: BigqueryHandle): Promise<string> {
    try {
        await handle.client.getDatasets({ maxResults: 1 });
        return `BigQuery project ${handle.projectId}`;
    } catch (error) {
        throw new Error(formatBigqueryAuthError(error));
    }
}

/** ponytail: 15 min in memory. List barely changes; Resource Manager is slow. Disk/account-key if ADC switches often. */
export const PROJECT_LIST_TTL_MS = 15 * 60 * 1000;

export function freshProjectList(
    cache: { at: number; projects: readonly string[] } | undefined,
    now: number,
    ttlMs: number = PROJECT_LIST_TTL_MS
): string[] | undefined {
    if (!cache || now - cache.at >= ttlMs) {
        return undefined;
    }
    return cache.projects.slice();
}

let projectListCache: { at: number; projects: string[] } | undefined;
let projectListInFlight: Promise<string[]> | undefined;

export function peekCachedAccessibleProjects(): string[] | undefined {
    return freshProjectList(projectListCache, Date.now());
}

/**
 * ponytail: first 1000 ACTIVE projects only. Resource Manager has no
 * "projects I use in BigQuery" filter. Raise the page cap if the list
 * is truncated.
 */
export async function listAccessibleProjects(): Promise<string[]> {
    const cached = peekCachedAccessibleProjects();
    if (cached) {
        return cached;
    }
    if (!projectListInFlight) {
        projectListInFlight = fetchAccessibleProjects()
            .then((projects) => {
                projectListCache = { at: Date.now(), projects };
                return projects;
            })
            .finally(() => {
                projectListInFlight = undefined;
            });
    }
    const projects = await projectListInFlight;
    return projects.slice();
}

async function fetchAccessibleProjects(): Promise<string[]> {
    try {
        const auth = new GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const client = await auth.getClient();
        const names: string[] = [];
        let pageToken = '';
        for (let page = 0; page < 5; page++) {
            const url = new URL('https://cloudresourcemanager.googleapis.com/v1/projects');
            url.searchParams.set('filter', 'lifecycleState:ACTIVE');
            url.searchParams.set('pageSize', '200');
            if (pageToken) {
                url.searchParams.set('pageToken', pageToken);
            }
            const response = await client.request<{
                projects?: Array<{ projectId?: string }>;
                nextPageToken?: string;
            }>({ url: url.toString() });
            const data = response.data;
            for (const project of data.projects ?? []) {
                const id = (project.projectId ?? '').trim();
                if (id) {
                    names.push(id);
                }
            }
            pageToken = data.nextPageToken ?? '';
            if (!pageToken) {
                break;
            }
        }
        names.sort((left, right) => left.localeCompare(right));
        return names;
    } catch (error) {
        throw new Error(formatBigqueryAuthError(error));
    }
}

export async function listBigqueryDatasets(
    handle: BigqueryHandle,
    listProject?: string
): Promise<string[]> {
    const home = handle.projectId;
    const project = (listProject || home).trim() || home;
    try {
        const client =
            project.toLowerCase() === home.toLowerCase()
                ? handle.client
                : new BigQuery({ projectId: project });
        const [datasets] = await client.getDatasets();
        return datasets
            .map((dataset) => dataset.id ?? '')
            .filter((name) => name.length > 0)
            .sort((left, right) => left.localeCompare(right))
            .map((dataset) => formatBigqueryDatasetRef({ project, dataset }, home));
    } catch (error) {
        throw new Error(formatBigqueryAuthError(error));
    }
}

/**
 * ponytail: one INFORMATION_SCHEMA query per dataset bills the 10 MB
 * boundary (fractions of a cent) but returns columns in one round trip.
 * Switch to getTables() + getMetadata() if billing must stay at zero;
 * that path is one HTTP call per table and is slower on large datasets.
 */
export async function loadBigquerySchema(
    handle: BigqueryHandle,
    datasets: string[],
    onSkip?: (dataset: string, message: string) => void
): Promise<TableInfo[]> {
    const tablesByQualified = new Map<string, TableInfo>();
    for (const dataset of datasets) {
        const name = dataset.trim();
        if (!name) {
            continue;
        }
        const ref = parseBigqueryDatasetRef(name, handle.projectId);
        if (!ref) {
            onSkip?.(name, 'Use dataset or project.dataset');
            continue;
        }
        try {
            const rows = await queryDatasetColumns(handle, ref);
            for (const row of rows) {
                addColumn(tablesByQualified, ref.project, ref.dataset, row);
            }
        } catch (error) {
            onSkip?.(
                formatBigqueryDatasetRef(ref, handle.projectId),
                formatBigqueryAuthError(error)
            );
        }
    }
    return [...tablesByQualified.values()];
}

export interface BigqueryDryRunStats {
    totalBytesProcessed?: string;
    totalBytesProcessedAccuracy?: string;
    estimatedBytesProcessed?: string;
    statementType?: string;
    cacheHit?: boolean;
    referencedTables?: Array<{
        projectId?: string;
        datasetId?: string;
        tableId?: string;
    }>;
    schema?: { fields?: Array<{ name?: string }> };
}

export interface BigqueryQueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    rowsAffected: number | undefined;
    scanBytes?: number;
}

/**
 * BigQuery rejects a null named param unless the type is set. Every bind we
 * send is `string | null`, so STRING covers both.
 */
export function bigqueryQueryParams(params: Record<string, string | null>): {
    params?: Record<string, string | null>;
    types?: Record<string, string>;
} {
    const names = Object.keys(params);
    if (names.length === 0) {
        return {};
    }
    const types: Record<string, string> = {};
    for (const name of names) {
        types[name] = 'STRING';
    }
    return { params, types };
}

export function parseScanBytes(raw: string | number | undefined): number | undefined {
    if (raw === undefined || raw === '') {
        return undefined;
    }
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes < 0) {
        return undefined;
    }
    return bytes;
}

/** True when the dry-run estimate is strictly above the threshold. */
export function shouldConfirmScan(
    bytes: number | undefined,
    thresholdMb: number
): boolean {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
        return false;
    }
    if (!Number.isFinite(thresholdMb) || thresholdMb < 0) {
        return false;
    }
    return bytes > thresholdMb * 1024 * 1024;
}

export function formatScanBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const shown =
        unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
    return `${shown} ${units[unit]}`;
}

export function explainRowsFromDryRun(stats: BigqueryDryRunStats): unknown[][] {
    const bytes = parseScanBytes(stats.totalBytesProcessed);
    const tables = (stats.referencedTables ?? [])
        .map((table) =>
            [table.projectId, table.datasetId, table.tableId].filter(Boolean).join('.')
        )
        .filter((name) => name.length > 0);
    const columns = (stats.schema?.fields ?? [])
        .map((field) => field.name ?? '')
        .filter((name) => name.length > 0);
    return [
        ['Statement type', stats.statementType ?? ''],
        ['Estimated bytes', bytes === undefined ? '' : formatScanBytes(bytes)],
        ['Estimate accuracy', stats.totalBytesProcessedAccuracy ?? ''],
        ['Cache hit', stats.cacheHit === undefined ? '' : String(stats.cacheHit)],
        ['Referenced tables', tables.join(', ')],
        ['Output columns', columns.join(', ')]
    ];
}

export const BIGQUERY_EXPLAIN_NOTE =
    'BigQuery explain is a dry-run estimate. It does not run the query or return a stage plan.';

export async function dryRunBigquery(
    handle: BigqueryHandle,
    sql: string,
    params: Record<string, string | null>,
    defaultDataset: string
): Promise<BigqueryDryRunStats> {
    const [job] = await handle.client.createQueryJob(
        buildQuery(handle, sql, params, defaultDataset, { dryRun: true })
    );
    return bigqueryStatsFromMetadata(job.metadata);
}

/**
 * After a real run, `job.metadata` can still lack byte counts. Refresh once
 * when the first snapshot has no scan size.
 */
export async function finishedJobStats(
    metadata: unknown,
    refresh: () => Promise<unknown>
): Promise<BigqueryDryRunStats> {
    const first = bigqueryStatsFromMetadata(metadata);
    if (parseScanBytes(first.totalBytesProcessed) !== undefined) {
        return first;
    }
    try {
        return bigqueryStatsFromMetadata(await refresh());
    } catch {
        return first;
    }
}

export async function runBigqueryQuery(
    handle: BigqueryHandle,
    options: {
        sql: string;
        params: Record<string, string | null>;
        maxRows: number;
        defaultDataset: string;
        signal?: AbortSignal;
        jobTimeoutMs?: number;
    }
): Promise<BigqueryQueryResult> {
    if (options.signal?.aborted) {
        throw new Error('Cancelled.');
    }
    const [job] = await handle.client.createQueryJob(
        buildQuery(handle, options.sql, options.params, options.defaultDataset, {
            jobTimeoutMs: options.jobTimeoutMs,
            maxResults: options.maxRows
        })
    );
    if (options.signal?.aborted) {
        await cancelJob(job);
        throw new Error('Cancelled.');
    }
    const onAbort = () => {
        void cancelJob(job);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const [rows, , response] = await job.getQueryResults({
            maxResults: options.maxRows,
            autoPaginate: false,
            timeoutMs: options.jobTimeoutMs
        });
        const recordRows = (rows ?? []) as Record<string, unknown>[];
        let metadata: unknown = job.metadata;
        const stats = await finishedJobStats(metadata, async () => {
            const [next] = await job.getMetadata();
            metadata = next;
            return next;
        });
        return {
            columns: columnsFromResponse(recordRows, response),
            rows: recordRows,
            rowsAffected: dmlRowsAffected(metadata, response),
            scanBytes: parseScanBytes(stats.totalBytesProcessed)
        };
    } finally {
        options.signal?.removeEventListener('abort', onAbort);
    }
}

export function formatBigqueryAuthError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (
        lower.includes('default credentials') ||
        lower.includes('could not refresh access token') ||
        lower.includes('unable to authenticate') ||
        lower.includes('invalid_grant')
    ) {
        return `${message} Run: gcloud auth application-default login`;
    }
    if (
        lower.includes('cloudresourcemanager') ||
        lower.includes('resource manager') ||
        (lower.includes('has not been used') && lower.includes('project'))
    ) {
        return `${message} Enable the Cloud Resource Manager API, or type a project id.`;
    }
    return message;
}

async function queryDatasetColumns(
    handle: BigqueryHandle,
    ref: BigqueryDatasetRef
): Promise<SchemaRow[]> {
    const columns = infoSchema(ref.project, ref.dataset, 'COLUMNS');
    const tables = infoSchema(ref.project, ref.dataset, 'TABLES');
    const [rows] = await handle.client.query({
        query: `SELECT
  c.table_name,
  t.table_type,
  c.column_name,
  c.ordinal_position,
  c.data_type,
  c.is_nullable,
  c.is_generated
FROM ${columns} AS c
INNER JOIN ${tables} AS t
  ON t.table_name = c.table_name
ORDER BY c.table_name, c.ordinal_position`
    });
    return rows as SchemaRow[];
}

function infoSchema(projectId: string, dataset: string, view: string): string {
    return `\`${stripTicks(projectId)}.${stripTicks(dataset)}.INFORMATION_SCHEMA.${view}\``;
}

function stripTicks(value: string): string {
    return value.replace(/`/g, '');
}

function buildQuery(
    handle: BigqueryHandle,
    sql: string,
    params: Record<string, string | null>,
    defaultDatasetRaw: string,
    extra: { dryRun?: boolean; maxResults?: number; jobTimeoutMs?: number }
) {
    const named = bigqueryQueryParams(params);
    const defaultDataset = defaultDatasetOption(handle, defaultDatasetRaw);
    return {
        query: sql,
        useLegacySql: false,
        ...(named.params ? { params: named.params, types: named.types } : {}),
        ...(defaultDataset ? { defaultDataset } : {}),
        ...extra
    };
}

function defaultDatasetOption(
    handle: BigqueryHandle,
    defaultRaw: string
): { projectId: string; datasetId: string } | undefined {
    const ref = parseBigqueryDatasetRef(defaultRaw, handle.projectId);
    if (!ref) {
        return undefined;
    }
    return { projectId: ref.project, datasetId: ref.dataset };
}

/**
 * Dry-run and finished jobs put the byte count on `statistics` and/or
 * `statistics.query`. Prefer the query object, then the job total, then the
 * dry-run estimate.
 */
export function bigqueryStatsFromMetadata(metadata: unknown): BigqueryDryRunStats {
    const statistics = (
        metadata as {
            statistics?: {
                totalBytesProcessed?: string | number;
                query?: BigqueryDryRunStats & {
                    totalBytesProcessed?: string | number;
                    estimatedBytesProcessed?: string | number;
                };
            };
        }
    )?.statistics;
    const query = statistics?.query ?? {};
    const raw =
        query.totalBytesProcessed ??
        statistics?.totalBytesProcessed ??
        query.estimatedBytesProcessed;
    return {
        ...query,
        totalBytesProcessed: raw === undefined || raw === '' ? undefined : String(raw)
    };
}

function columnsFromResponse(
    rows: Record<string, unknown>[],
    response: unknown
): string[] {
    const fields = (response as { schema?: { fields?: Array<{ name?: string }> } })
        ?.schema?.fields;
    if (fields && fields.length > 0) {
        return fields.map((field) => field.name ?? '').filter((name) => name.length > 0);
    }
    const first = rows[0];
    return first ? Object.keys(first) : [];
}

function dmlRowsAffected(metadata: unknown, response: unknown): number | undefined {
    const fromStats = Number(
        (
            metadata as {
                statistics?: { query?: { numDmlAffectedRows?: string } };
            }
        )?.statistics?.query?.numDmlAffectedRows
    );
    if (Number.isFinite(fromStats)) {
        return fromStats;
    }
    const fromResponse = Number(
        (response as { numDmlAffectedRows?: string })?.numDmlAffectedRows
    );
    if (Number.isFinite(fromResponse)) {
        return fromResponse;
    }
    return undefined;
}

async function cancelJob(job: { cancel: () => Promise<unknown> }): Promise<void> {
    try {
        await job.cancel();
    } catch {
        // Best effort: the job may already have finished.
    }
}

function addColumn(
    tablesByQualified: Map<string, TableInfo>,
    projectId: string,
    dataset: string,
    row: SchemaRow
): void {
    const tableName = String(row.table_name);
    const qualifiedName = `${projectId}.${dataset}.${tableName}`;
    const key = qualifiedName.toLowerCase();
    let table = tablesByQualified.get(key);
    if (!table) {
        table = {
            database: projectId,
            schema: dataset,
            name: tableName,
            fullName: `${dataset}.${tableName}`,
            qualifiedName,
            isView: String(row.table_type).toUpperCase().includes('VIEW'),
            columns: [],
            columnsByLower: new Map<string, ColumnInfo>()
        };
        tablesByQualified.set(key, table);
    }
    const column: ColumnInfo = {
        name: String(row.column_name),
        ordinal: Number(row.ordinal_position) || 0,
        typeName: String(row.data_type),
        typeDisplay: String(row.data_type),
        isNullable: String(row.is_nullable).toUpperCase() === 'YES',
        isIdentity: false,
        isComputed: String(row.is_generated).toUpperCase() !== 'NEVER',
        isPrimaryKey: false
    };
    table.columns.push(column);
    table.columnsByLower.set(column.name.toLowerCase(), column);
}
