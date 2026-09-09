import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { formatScanBytes, shouldConfirmScan } from '../db/bigquery';
import { SqlServerService, selectedDatabases } from '../db/connection';
import { isMutatingSql } from '../sql/parameters';
import {
    ChangeLevel,
    ColumnDiff,
    DiffFilter,
    SchemaDiff,
    TableDiff,
    compareDatabases,
    effectiveTableStatus,
    isChangeVisible,
    parseChangeLevel,
    parseDiffFilter,
    tableDiffMatches
} from '../sql/schemaDiff';
import { ResultsPanel } from '../ui/resultsPanel';

const LIST_TABLES_CAP = 200;
const SEARCH_CAP = 80;
const COMPARE_CAP = 200;

const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
} as const;

const mutating = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
} as const;

export class SerialGate {
    private tail: Promise<void> = Promise.resolve();

    public run<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.tail.then(fn, fn);
        this.tail = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }
}

export function registerBisqlTools(
    server: McpServer,
    db: SqlServerService,
    gate: SerialGate
): void {
    server.registerTool(
        'bisql_status',
        {
            title: 'BiSql connection status',
            description:
                'Show the current BiSql database engine, server, database, connection state, and schema cache age. Does not return the password.',
            annotations: readOnly
        },
        async () => jsonResult(statusPayload(db))
    );

    server.registerTool(
        'bisql_refresh_schema',
        {
            title: 'Refresh schema cache',
            description:
                'Reload tables and columns from the live connection into the BiSql schema cache. Use when status.stale is true, after DDL, or when a table is missing from list/describe.',
            annotations: readOnly
        },
        async () =>
            gate.run(async () => {
                const blocked = requireConfigured(db);
                if (blocked) {
                    return blocked;
                }
                db.requestLiveSchema();
                const ok = await db.refreshSchema();
                if (!ok) {
                    return jsonResult(
                        {
                            ok: false,
                            error: notConnectedMessage(db, 'Schema refresh failed'),
                            ...statusPayload(db)
                        },
                        true
                    );
                }
                return jsonResult({
                    ok: true,
                    ...statusPayload(db)
                });
            })
    );

    server.registerTool(
        'bisql_list_databases',
        {
            title: 'List databases',
            description:
                'List databases this login can see on the live connection (not only the ones loaded into the schema cache).',
            annotations: readOnly
        },
        async () =>
            gate.run(async () => {
                const blocked = requireConfigured(db);
                if (blocked) {
                    return blocked;
                }
                const result = await db.listDatabases();
                if (!result.ok) {
                    return jsonResult(
                        {
                            ok: false,
                            error: notConnectedMessage(db, result.message)
                        },
                        true
                    );
                }
                return jsonResult({
                    ok: true,
                    databases: result.databases,
                    message: result.message,
                    ...schemaMeta(db)
                });
            })
    );

    server.registerTool(
        'bisql_list_tables',
        {
            title: 'List tables',
            description:
                'List tables and views from the BiSql schema cache. Filter by database, schema, name substring, or views only. Does not hit the database unless the cache is empty.',
            inputSchema: z.object({
                database: z.string().optional().describe('Filter by database / catalog name.'),
                schema: z.string().optional().describe('Filter by schema (SQL Server / PostgreSQL). Ignored on MySQL.'),
                query: z.string().optional().describe('Case-insensitive substring of the table name.'),
                views_only: z.boolean().optional().describe('If true, return views only.'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .optional()
                    .describe(`Max tables to return. Default ${LIST_TABLES_CAP}.`)
            }),
            annotations: readOnly
        },
        async ({ database, schema, query, views_only, limit }) => {
            const ready = await gate.run(() => ensureSchema(db));
            if (!ready.ok) {
                return jsonResult({ ok: false, error: ready.message }, true);
            }
            const cap = Math.min(limit ?? LIST_TABLES_CAP, 500);
            const dbFilter = database?.trim().toLowerCase();
            const schemaFilter = schema?.trim().toLowerCase();
            const nameFilter = query?.trim().toLowerCase();
            const matched = db.schema.tables.filter((table) => {
                if (dbFilter && table.database.toLowerCase() !== dbFilter) {
                    return false;
                }
                if (schemaFilter && table.schema.toLowerCase() !== schemaFilter) {
                    return false;
                }
                if (nameFilter && !table.name.toLowerCase().includes(nameFilter)) {
                    return false;
                }
                if (views_only && !table.isView) {
                    return false;
                }
                return true;
            });
            return jsonResult({
                ok: true,
                ...schemaMeta(db),
                total: matched.length,
                returned: Math.min(matched.length, cap),
                tables: matched.slice(0, cap).map((table) => ({
                    database: table.database,
                    schema: table.schema,
                    name: table.name,
                    qualifiedName: table.qualifiedName,
                    isView: table.isView,
                    columnCount: table.columns.length
                }))
            });
        }
    );

    server.registerTool(
        'bisql_describe_table',
        {
            title: 'Describe table',
            description:
                'Show columns, types, nullability, primary key, and identity for one table from the schema cache. Accepts Users, dbo.Users, or database.schema.table.',
            inputSchema: z.object({
                table: z
                    .string()
                    .min(1)
                    .describe('Table name, optionally schema- or database-qualified.')
            }),
            annotations: readOnly
        },
        async ({ table }) => {
            const ready = await gate.run(() => ensureSchema(db));
            if (!ready.ok) {
                return jsonResult({ ok: false, error: ready.message }, true);
            }
            const matches = db.findTableMatches(table);
            const resolved = db.findTable(table);
            if (!resolved) {
                return jsonResult(
                    {
                        ok: false,
                        error: `No table named "${table}" in the schema cache.`,
                        ...schemaMeta(db)
                    },
                    true
                );
            }
            return jsonResult({
                ok: true,
                ...schemaMeta(db),
                ambiguous: matches.length > 1,
                matches:
                    matches.length > 1
                        ? matches.map((item) => item.qualifiedName)
                        : undefined,
                table: {
                    database: resolved.database,
                    schema: resolved.schema,
                    name: resolved.name,
                    qualifiedName: resolved.qualifiedName,
                    isView: resolved.isView,
                    columns: resolved.columns.map((column) => ({
                        name: column.name,
                        type: column.typeDisplay,
                        nullable: column.isNullable,
                        primaryKey: column.isPrimaryKey,
                        identity: column.isIdentity,
                        computed: column.isComputed
                    }))
                }
            });
        }
    );

    server.registerTool(
        'bisql_search_schema',
        {
            title: 'Search schema',
            description:
                'Find tables and columns in the schema cache whose names contain a substring.',
            inputSchema: z.object({
                query: z.string().min(1).describe('Case-insensitive substring to search for.'),
                limit: z.number().int().min(1).max(200).optional()
            }),
            annotations: readOnly
        },
        async ({ query, limit }) => {
            const ready = await gate.run(() => ensureSchema(db));
            if (!ready.ok) {
                return jsonResult({ ok: false, error: ready.message }, true);
            }
            const needle = query.trim().toLowerCase();
            const cap = Math.min(limit ?? SEARCH_CAP, 200);
            const tables: Array<{ qualifiedName: string; isView: boolean }> = [];
            const columns: Array<{ table: string; column: string; type: string }> = [];
            for (const table of db.schema.tables) {
                if (table.name.toLowerCase().includes(needle)) {
                    tables.push({
                        qualifiedName: table.qualifiedName,
                        isView: table.isView
                    });
                }
                if (columns.length >= cap) {
                    continue;
                }
                for (const column of table.columns) {
                    if (!column.name.toLowerCase().includes(needle)) {
                        continue;
                    }
                    columns.push({
                        table: table.qualifiedName,
                        column: column.name,
                        type: column.typeDisplay
                    });
                    if (columns.length >= cap) {
                        break;
                    }
                }
            }
            return jsonResult({
                ok: true,
                ...schemaMeta(db),
                tables: tables.slice(0, cap),
                tablesTotal: tables.length,
                columns: columns.slice(0, cap),
                columnsCapped: columns.length >= cap
            });
        }
    );

    server.registerTool(
        'bisql_compare_schema',
        {
            title: 'Compare schema',
            description:
                'Compare tables and columns in two databases from the BiSql schema cache. Same rules as Cached Schema. Does not hit the database unless the cache is empty. PostgreSQL has one database per login, so this is mainly useful on SQL Server and MySQL.',
            inputSchema: z.object({
                left: z.string().min(1).describe('Left database / catalog name from the schema cache.'),
                right: z
                    .string()
                    .min(1)
                    .describe('Right database / catalog name from the schema cache.'),
                filter: z
                    .enum(['all', 'diff', 'changed', 'left', 'right', 'identical'])
                    .optional()
                    .describe('Which tables to return. Default diff (skip identical).'),
                query: z
                    .string()
                    .optional()
                    .describe('Case-insensitive substring of a table or column name.'),
                depth: z
                    .enum(['table', 'column', 'type', 'size', 'flags'])
                    .optional()
                    .describe(
                        'How fine a difference counts. Default size (type and length). table = missing tables only.'
                    ),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .optional()
                    .describe(`Max tables to return. Default ${COMPARE_CAP}.`)
            }),
            annotations: readOnly
        },
        async ({ left, right, filter, query, depth, limit }) => {
            const ready = await gate.run(() => ensureSchema(db));
            if (!ready.ok) {
                return jsonResult({ ok: false, error: ready.message }, true);
            }
            const leftName = left.trim();
            const rightName = right.trim();
            if (leftName.toLowerCase() === rightName.toLowerCase()) {
                return jsonResult(
                    { ok: false, error: 'left and right must be different databases.' },
                    true
                );
            }
            const cached = cachedDatabaseNames(db);
            const missing: string[] = [];
            if (!hasCachedDatabase(cached, leftName)) {
                missing.push(leftName);
            }
            if (!hasCachedDatabase(cached, rightName)) {
                missing.push(rightName);
            }
            if (missing.length > 0) {
                return jsonResult(
                    {
                        ok: false,
                        error: `Not in the schema cache: ${missing.join(', ')}. Load them in BiSql: Open Connection / Login.`,
                        cachedDatabases: cached,
                        ...schemaMeta(db)
                    },
                    true
                );
            }
            const diffFilter = parseDiffFilter(filter);
            const changeDepth = parseChangeLevel(depth);
            const nameQuery = query ?? '';
            const diff = compareDatabases(
                db.schema.tables,
                leftName,
                rightName,
                db.getConfig().engine
            );
            return jsonResult(
                compactSchemaDiff(diff, {
                    filter: diffFilter,
                    query: nameQuery,
                    depth: changeDepth,
                    limit: Math.min(limit ?? COMPARE_CAP, 500),
                    cachedDatabases: cached,
                    ...schemaMeta(db)
                })
            );
        }
    );

    server.registerTool(
        'bisql_run_sql',
        {
            title: 'Run SQL',
            description:
                'Run SQL on the live BiSql connection and return one page of rows. SELECT is paged. Writes are blocked unless bisql.mcpAllowMutating is on and allow_mutating is true. On BigQuery, a dry-run estimate above bisql.bigqueryConfirmScanMb also needs allow_large_scan: true. Also opens the results tab without stealing editor focus.',
            inputSchema: z.object({
                sql: z.string().min(1).describe('SQL to run. Named binds use :name.'),
                params: z
                    .record(z.string(), z.union([z.string(), z.null()]))
                    .optional()
                    .describe('Values for :name binds. Empty string is stored as-is; use null for SQL NULL.'),
                offset: z.number().int().min(0).optional().describe('Row offset for the next page. Default 0.'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(1000)
                    .optional()
                    .describe('Rows to return to the agent. Capped by bisql.mcpMaxResultRows.'),
                allow_mutating: z
                    .boolean()
                    .optional()
                    .describe('Required together with bisql.mcpAllowMutating to run INSERT/UPDATE/DELETE/DDL.'),
                allow_large_scan: z
                    .boolean()
                    .optional()
                    .describe(
                        'Required on BigQuery when the dry-run estimate is above bisql.bigqueryConfirmScanMb. LIMIT does not reduce bytes scanned.'
                    ),
                show_results: z
                    .boolean()
                    .optional()
                    .describe('Open the BiSql results tab. Default true.')
            }),
            annotations: mutating
        },
        async ({ sql, params, offset, limit, allow_mutating, allow_large_scan, show_results }) =>
            gate.run(async () => {
                const blocked = requireConfigured(db);
                if (blocked) {
                    return blocked;
                }
                const config = db.getConfig();
                if (isMutatingSql(sql) && (!config.mcpAllowMutating || allow_mutating !== true)) {
                    return jsonResult(
                        {
                            ok: false,
                            error:
                                'This SQL may change data or schema. Set bisql.mcpAllowMutating to true and pass allow_mutating: true. Prefer a read-only database login.'
                        },
                        true
                    );
                }
                if (config.engine === 'bigquery' && allow_large_scan !== true) {
                    const estimate = await db.estimateBigqueryScan(sql, params ?? {});
                    const bytes = estimate?.bytes;
                    if (estimate && shouldConfirmScan(bytes, config.bigqueryConfirmScanMb) && bytes !== undefined) {
                        return jsonResult(
                            {
                                ok: false,
                                error:
                                    `This query may scan ${formatScanBytes(bytes)}. ` +
                                    'Pass allow_large_scan: true to run it. LIMIT does not reduce bytes scanned.',
                                estimatedBytes: bytes,
                                estimatedBytesAccuracy: estimate.accuracy
                            },
                            true
                        );
                    }
                }

                const pageSize = Math.min(
                    limit ?? config.mcpMaxResultRows,
                    config.mcpMaxResultRows,
                    config.queryMaxRows
                );
                const result = await db.executeQuery(sql, params ?? {}, {
                    offset: offset ?? 0,
                    limit: pageSize,
                    raw: true
                });

                if (show_results !== false) {
                    ResultsPanel.show(result, db, { preserveFocus: true });
                }

                if (!result.ok) {
                    return jsonResult(
                        {
                            ok: false,
                            error: result.error ?? 'The query failed.',
                            sql: result.sql,
                            executedSql: result.executedSql,
                            elapsedMs: result.elapsedMs
                        },
                        true
                    );
                }

                return jsonResult({
                    ok: true,
                    columns: result.columns,
                    rows: result.rawRows ?? result.rows,
                    rowCount: (result.rawRows ?? result.rows).length,
                    rowsAffected: result.rowsAffected,
                    truncated: result.truncated,
                    pageOffset: result.pageOffset,
                    maxRows: result.maxRows,
                    elapsedMs: result.elapsedMs,
                    paged: result.paged,
                    scanBytes: result.scanBytes
                });
            })
    );

    server.registerTool(
        'bisql_explain_sql',
        {
            title: 'Explain SQL',
            description:
                'Return a query plan without running the statement. MySQL and PostgreSQL use EXPLAIN. SQL Server uses SET SHOWPLAN_ALL on a dedicated connection so the query is not executed. BigQuery returns a dry-run estimate (bytes, tables, output columns), not a stage plan.',
            inputSchema: z.object({
                sql: z.string().min(1).describe('SQL to explain.'),
                params: z
                    .record(z.string(), z.union([z.string(), z.null()]))
                    .optional()
                    .describe('Values for :name binds.')
            }),
            annotations: readOnly
        },
        async ({ sql, params }) =>
            gate.run(async () => {
                const blocked = requireConfigured(db);
                if (blocked) {
                    return blocked;
                }
                const result = await db.explainQuery(sql, params ?? {});
                if (!result.ok) {
                    return jsonResult(
                        {
                            ok: false,
                            error: result.error ?? 'Explain failed.',
                            engine: result.engine,
                            elapsedMs: result.elapsedMs
                        },
                        true
                    );
                }
                return jsonResult({
                    ok: true,
                    engine: result.engine,
                    columns: result.columns,
                    rows: result.rows,
                    elapsedMs: result.elapsedMs,
                    note: result.note,
                    scanBytes: result.scanBytes
                });
            })
    );

    server.registerTool(
        'bisql_validate_sql',
        {
            title: 'Validate SQL',
            description:
                'Dry-run SQL without changing data. SQL Server uses SET NOEXEC ON. MySQL and PostgreSQL use EXPLAIN as a parse/plan check. BigQuery uses a dry-run job. Returns ok, errors, skipped, or unavailable.',
            inputSchema: z.object({
                sql: z.string().min(1).describe('SQL to validate.')
            }),
            annotations: readOnly
        },
        async ({ sql }) =>
            gate.run(async () => {
                const blocked = requireConfigured(db);
                if (blocked) {
                    return blocked;
                }
                const result = await db.dryRun(sql);
                return jsonResult({ ok: result.kind === 'ok', ...result });
            })
    );
}

function jsonResult(data: unknown, isError = false): {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
} {
    const payload = { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    return isError ? { ...payload, isError: true } : payload;
}

function schemaMeta(db: SqlServerService): {
    stale: boolean;
    fetchedAt: number | null;
    tableCount: number;
} {
    return {
        stale: db.schema.stale,
        fetchedAt: db.schema.fetchedAt || null,
        tableCount: db.schema.tables.length
    };
}

function cachedDatabaseNames(db: SqlServerService): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const table of db.schema.tables) {
        const key = table.database.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(table.database);
    }
    return names.sort((left, right) => left.localeCompare(right));
}

function hasCachedDatabase(names: string[], wanted: string): boolean {
    const key = wanted.trim().toLowerCase();
    return names.some((name) => name.toLowerCase() === key);
}

function compactSchemaDiff(
    diff: SchemaDiff,
    options: {
        filter: DiffFilter;
        query: string;
        depth: ChangeLevel;
        limit: number;
        cachedDatabases: string[];
        stale: boolean;
        fetchedAt: number | null;
        tableCount: number;
    }
): Record<string, unknown> {
    const matched = diff.tables.filter((table) =>
        tableDiffMatches(table, options.filter, options.query, options.depth)
    );
    return {
        ok: true,
        stale: options.stale,
        fetchedAt: options.fetchedAt,
        tableCount: options.tableCount,
        cachedDatabases: options.cachedDatabases,
        left: diff.left,
        right: diff.right,
        filter: options.filter,
        depth: options.depth,
        query: options.query.trim() || undefined,
        identical: diff.identical,
        changed: diff.changed,
        leftOnly: diff.leftOnly,
        rightOnly: diff.rightOnly,
        matched: matched.length,
        returned: Math.min(matched.length, options.limit),
        tables: matched.slice(0, options.limit).map((table) => compactTableDiff(table, options.depth))
    };
}

function compactTableDiff(table: TableDiff, depth: ChangeLevel): Record<string, unknown> {
    const status = effectiveTableStatus(table, depth);
    const payload: Record<string, unknown> = {
        name: table.displayName,
        status,
        changeLevel: table.changeLevel === 'none' ? undefined : table.changeLevel,
        left: table.left,
        right: table.right
    };
    if (status !== 'changed') {
        return payload;
    }
    if (table.kindChanged && isChangeVisible('table', depth)) {
        payload.kindChanged = true;
    }
    payload.columns = table.columns
        .filter(
            (column) =>
                column.status !== 'identical' && isChangeVisible(column.changeLevel, depth)
        )
        .map(compactColumnDiff);
    return payload;
}

function compactColumnDiff(column: ColumnDiff): Record<string, unknown> {
    return {
        name: column.name,
        status: column.status,
        changes: column.changes.length > 0 ? column.changes : undefined,
        leftType: column.left?.typeDisplay,
        rightType: column.right?.typeDisplay
    };
}

function statusPayload(db: SqlServerService): Record<string, unknown> {
    const config = db.getConfig();
    return {
        enabled: config.enabled,
        mcpEnabled: config.mcpEnabled,
        mcpAllowMutating: config.mcpAllowMutating,
        connectionState: db.connectionState,
        lastError: db.lastErrorMessage ?? null,
        connection: config.connectionName || null,
        engine: config.engine,
        server: config.server || null,
        port: config.engine === 'bigquery' ? null : config.port,
        database: config.database || null,
        databases: selectedDatabases(config),
        user: config.engine === 'bigquery' ? null : config.user || null,
        ...schemaMeta(db)
    };
}

function notConnectedMessage(db: SqlServerService, detail?: string): string {
    const extra = detail || db.lastErrorMessage;
    return extra
        ? `BiSql is not connected — ${extra}. Run BiSql: Open Connection / Login.`
        : 'BiSql is not connected — run BiSql: Open Connection / Login.';
}

function requireConfigured(db: SqlServerService): ReturnType<typeof jsonResult> | undefined {
    const config = db.getConfig();
    if (!config.enabled) {
        return jsonResult({ ok: false, error: 'BiSql is disabled (bisql.enabled).' }, true);
    }
    if (!config.server || !config.database) {
        return jsonResult({ ok: false, error: notConnectedMessage(db) }, true);
    }
    return undefined;
}

async function ensureSchema(
    db: SqlServerService
): Promise<{ ok: true } | { ok: false; message: string }> {
    const blocked = requireConfigured(db);
    if (blocked) {
        const parsed = JSON.parse(blocked.content[0].text) as { error?: string };
        return { ok: false, message: parsed.error ?? notConnectedMessage(db) };
    }
    if (!db.schema.isEmpty) {
        return { ok: true };
    }
    db.requestLiveSchema();
    await db.refreshSchema();
    if (!db.schema.isEmpty) {
        return { ok: true };
    }
    return { ok: false, message: notConnectedMessage(db, 'Schema cache is empty') };
}
