import { McpServer } from '@modelcontextprotocol/server';

export const GUIDE_URI = 'bisql://docs/guide';

export const MCP_INSTRUCTIONS = [
    'BiSql already holds the live database login and schema cache. Do not ask for a connection string.',
    'Read bisql://docs/guide for the tool list.',
    'Typical order: bisql_status (refresh when stale), bisql_search_schema or bisql_list_tables, bisql_describe_table, then bisql_validate_sql / bisql_explain_sql, then bisql_run_sql for SELECT.',
    'Writes stay blocked unless bisql.mcpAllowMutating is on and allow_mutating is true.',
    'Chat rows are capped. Use offset for the next page. SQL NULL is JSON null.'
].join(' ');

export const GUIDE_MARKDOWN = `# BiSql MCP

The BiSql extension already holds the live login and schema cache.
Do not ask for a connection string.

## Tools

- \`bisql_status\` — engine, server, database, connection state, cache age
- \`bisql_refresh_schema\` — reload tables and columns from the live connection
- \`bisql_list_databases\` — databases this login can see
- \`bisql_list_tables\` — tables in the schema cache
- \`bisql_describe_table\` — columns, types, nullability, keys
- \`bisql_search_schema\` — find tables or columns by name
- \`bisql_compare_schema\` — diff two databases already in the cache (SQL Server / MySQL)
- \`bisql_validate_sql\` — check SQL against the cached schema
- \`bisql_explain_sql\` — dry-run / explain without changing data
- \`bisql_run_sql\` — run SQL and return one page of rows

## Order

1. \`bisql_status\` if you need engine or connection state. Call \`bisql_refresh_schema\` when \`stale\` is true, after DDL, or when a table is missing.
2. \`bisql_search_schema\` or \`bisql_list_tables\`, then \`bisql_describe_table\`, before writing SQL.
3. \`bisql_compare_schema\` to diff two cached databases. PostgreSQL has one database per login.
4. \`bisql_validate_sql\` or \`bisql_explain_sql\` before a risky query.
5. \`bisql_run_sql\` for SELECT.

## Writes

\`INSERT\`, \`UPDATE\`, \`DELETE\`, \`DROP\`, and other DDL stay blocked unless the user turned on \`bisql.mcpAllowMutating\` and you pass \`allow_mutating: true\`. Do not try to force them.

## Results

Chat results are capped. Ask for another page with \`offset\` if you need more rows.
SQL NULL arrives as JSON \`null\`, not the string \`"NULL"\`.
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
