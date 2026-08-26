---
name: use-bisql-db
description: Use BiSql MCP tools to inspect this workspace database and run SQL. Use when the user asks about tables, columns, schema, comparing databases, or to run or explain a query.
---

When the user asks about this project's database, use the BiSql MCP tools (`bisql_*`).

Do not ask for a connection string. The BiSql extension already holds the live login and schema cache.

Prefer this order:

1. `bisql_status` if you need engine or connection state. Call `bisql_refresh_schema` when `stale` is true, after DDL, or when a table is missing from list/describe.
2. `bisql_search_schema` or `bisql_list_tables`, then `bisql_describe_table`, before writing SQL
3. `bisql_compare_schema` to diff two databases already in the schema cache (SQL Server / MySQL; PostgreSQL has one database per login)
4. `bisql_validate_sql` or `bisql_explain_sql` before a risky query
5. `bisql_run_sql` for SELECT

Writes (`INSERT`, `UPDATE`, `DELETE`, `DROP`, ...) are blocked unless the user turned on `bisql.mcpAllowMutating` and you pass `allow_mutating: true`. Do not try to force them.

Results in chat are capped. Ask for another page with `offset` if you need more rows. SQL NULL arrives as JSON `null`, not the string `"NULL"`.
