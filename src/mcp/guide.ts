import { McpServer } from '@modelcontextprotocol/server';

export const GUIDE_URI = 'bisql://docs/guide';

export const MCP_INSTRUCTIONS = [
    'BiSql already holds the live database login and schema cache. Do not ask for a connection string in the editor; bisql-mcp uses BISQL_URL.',
    'Read bisql://docs/guide for the tool list.',
    'Typical order: bisql_status (refresh when stale), bisql_search_schema or bisql_list_tables, bisql_describe_table, then bisql_validate_sql / bisql_explain_sql, then bisql_run_sql for SELECT.',
    'Writes stay blocked unless the host allows them (bisql.mcpAllowMutating in the editor, BISQL_ALLOW_MUTATING=true for bisql-mcp) and allow_mutating is true.',
    'On BigQuery, a scan above the host scan limit needs allow_large_scan: true. LIMIT does not reduce bytes scanned.',
    'Chat rows are capped. Use offset for the next page. SQL NULL is JSON null.'
].join(' ');

export const GUIDE_MARKDOWN = `# BiSql MCP

The host already holds the live login and schema cache.
In the editor that is the BiSql extension. For bisql-mcp, set \`BISQL_URL\`.
Do not ask for a connection string when the host is configured.

## Tools

- \`bisql_status\` — engine, server, database, connection state, cache age. For BigQuery, \`server\` is the project id and \`database\` is the default dataset.
- \`bisql_refresh_schema\` — reload tables and columns from the live connection
- \`bisql_list_databases\` — databases this login can see (datasets on BigQuery)
- \`bisql_list_tables\` — tables in the schema cache
- \`bisql_describe_table\` — columns, types, nullability, keys
- \`bisql_search_schema\` — find tables or columns by name
- \`bisql_compare_schema\` — diff two databases already in the cache (SQL Server / MySQL / BigQuery datasets)
- \`bisql_validate_sql\` — check SQL against the cached schema
- \`bisql_explain_sql\` — dry-run / explain without changing data. On BigQuery this is a byte estimate, not a stage plan.
- \`bisql_run_sql\` — run SQL and return one page of rows. On BigQuery, a large scan needs \`allow_large_scan: true\`.

## Order

1. \`bisql_status\` if you need engine or connection state. Call \`bisql_refresh_schema\` when \`stale\` is true, after DDL, or when a table is missing.
2. \`bisql_search_schema\` or \`bisql_list_tables\`, then \`bisql_describe_table\`, before writing SQL.
3. \`bisql_compare_schema\` to diff two cached databases. PostgreSQL has one database per login. BigQuery can load extra projects as \`project.dataset\` on the same login.
4. \`bisql_validate_sql\` or \`bisql_explain_sql\` before a risky query. BigQuery explain is a dry-run estimate; \`LIMIT\` does not reduce bytes scanned.
5. \`bisql_run_sql\` for SELECT. On BigQuery, if the dry-run estimate is above the host scan limit, pass \`allow_large_scan: true\`.

## Writes

\`INSERT\`, \`UPDATE\`, \`DELETE\`, \`DROP\`, and other DDL stay blocked unless the host allows mutating (\`bisql.mcpAllowMutating\` in the editor, \`BISQL_ALLOW_MUTATING=true\` for bisql-mcp) and you pass \`allow_mutating: true\`. Do not try to force them.

## Results

Chat results are capped. Ask for another page with \`offset\` if you need more rows.
SQL NULL arrives as JSON \`null\`, not the string \`"NULL"\`.
\`show_results\` opens the results tab in the editor only; bisql-mcp ignores it.
`;

export function registerBisqlDocs(server: McpServer): void {
    server.registerResource(
        'bisql_guide',
        GUIDE_URI,
        {
            title: 'BiSql MCP guide',
            description: 'How to use BiSql MCP tools with the live connection and schema cache.',
            mimeType: 'text/markdown'
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    mimeType: 'text/markdown',
                    text: GUIDE_MARKDOWN
                }
            ]
        })
    );
}
