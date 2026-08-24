import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { SqlServerService, selectedDatabases } from '../db/connection';
import { isMutatingSql } from '../sql/parameters';
import { ResultsPanel } from '../ui/resultsPanel';

const LIST_TABLES_CAP = 200;
const SEARCH_CAP = 80;

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
                schema: z.string().optional().describe('Filter by schema (SQL Server). Ignored on MySQL.'),
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
        'bisql_run_sql',
        {
            title: 'Run SQL',
            description:
                'Run SQL on the live BiSql connection and return one page of rows. SELECT is paged. Writes are blocked unless bisql.mcpAllowMutating is on and allow_mutating is true. Also opens the results tab without stealing editor focus.',
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
                show_results: z
                    .boolean()
                    .optional()
                    .describe('Open the BiSql results tab. Default true.')
            }),
            annotations: mutating
        },
        async ({ sql, params, offset, limit, allow_mutating, show_results }) =>
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
                    paged: result.paged
                });
            })
    );

    server.registerTool(
        'bisql_explain_sql',
        {
            title: 'Explain SQL',
            description:
                'Return a query plan without running the statement. MySQL uses EXPLAIN. SQL Server uses SET SHOWPLAN_ALL on a dedicated connection so the query is not executed.',
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
                    note: result.note
                });
            })
    );

    server.registerTool(
        'bisql_validate_sql',
        {
            title: 'Validate SQL',
            description:
                'Dry-run SQL without changing data. SQL Server uses SET NOEXEC ON. MySQL uses EXPLAIN as a parse/plan check. Returns ok, errors, skipped, or unavailable.',
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

function statusPayload(db: SqlServerService): Record<string, unknown> {
    const config = db.getConfig();
    return {
        enabled: config.enabled,
        mcpEnabled: config.mcpEnabled,
        mcpAllowMutating: config.mcpAllowMutating,
        connectionState: db.connectionState,
        lastError: db.lastErrorMessage ?? null,
        engine: config.engine,
        server: config.server || null,
        port: config.port,
        database: config.database || null,
        databases: selectedDatabases(config),
        user: config.user || null,
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
