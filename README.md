# BiSql

Write SQL inside Python strings and get checks, completion, hover, and format from your real database schema.

Works with **Microsoft SQL Server** and **MySQL / MariaDB**.

## Features

- **Catch bad SQL early** — table and column names are checked while you type. On save, the query is dry-run (no data changes).
- **Completion and hover** — tables, columns, and common SQL functions. Hover shows type, nullability, and primary keys.
- **SQL highlighting** inside matching Python strings.
- **Format SQL** in a file or selection. Your Python formatter still owns Format Document.
- **Run Selected SQL** — see rows in a table, page through results, sort columns, and export JSON or CSV.
- **Edit simple results** — on a plain `SELECT` from one table that includes the primary key, you can edit a cell, set NULL, delete a row, or rename a column. Each write asks for confirmation.
- **Works offline after the first connect** — schema is cached on disk.

## Get started

1. Open the Command Palette and run **BiSql: Open Connection / Login** (or click the SQL item in the status bar).
2. Choose **SQL Server** or **MySQL / MariaDB**.
3. Enter server, port (`1433` / `3306`), database, username, and password.
4. Click **Save & Connect**.

The password is stored in the OS keychain. Other fields are saved in workspace settings.

Use a **read-only** login when you can.

## Cursor AI (MCP)

When BiSql is connected inside **Cursor**, the agent can use the same live connection and schema cache. No `mcp.json` and no second login.

The agent can list tables, describe columns, run `SELECT`, validate SQL, and explain a query. Writes are blocked unless you turn on `bisql.mcpAllowMutating`. Chat results are capped (`bisql.mcpMaxResultRows`, default 50); the results tab still shows the full page and does not steal editor focus.

Turn this off with `bisql.mcpEnabled`.

## When a string is treated as SQL

A Python string is treated as SQL if any of these are true:

1. It contains `--sql` or `/* sql */`
2. It is assigned to a name that contains `query`, `stmt`, or `statement` (`update_query`, `query_1`), or `sql` as its own word (`sql`, `raw_sql`, `sql_text`). `sqlite` and `sqlalchemy` are ignored.
3. It is passed to `.execute(`, `.executemany(`, `read_sql(`, `read_sql_query(`, or `text(`
4. It starts with a SQL keyword (`SELECT`, `INSERT`, …). You can turn this off with `bisql.detectByKeyword`.

## Suggestions inside strings

Space, `.`, and `,` open the suggestion list on their own.

Typing letters inside a string does **not**, unless VS Code suggestions in strings are on for Python. BiSql offers to enable this once. You can also run **BiSql: Enable Suggestions Inside Python Strings**.

## Commands

| Command | What it does |
| --- | --- |
| **BiSql: Open Connection / Login** | Open the login page |
| **BiSql: Run Selected SQL** | Run the selected text and show results |
| **BiSql: Format SQL in File** | Pretty-print every detected SQL string in the file |
| **BiSql: Refresh Database Schema** | Reload tables and columns |
| **BiSql: Test Connection** | Check that the login works |
| **BiSql: Validate Current File** | Run checks on the open file now |
| **BiSql: Set Password** / **Clear Stored Password** | Update or remove the keychain password |
| **BiSql: Clear Cached Schema Snapshot** | Delete the local schema cache |
| **BiSql: Enable Suggestions Inside Python Strings** | Turn on letter suggestions inside Python strings |

**Format Selection** formats the SQL string under the caret or in the selection.

**Run Selected SQL** asks for values for named binds (`:path`, `:search`). Empty means `NULL`. Python bits like `{replace_func}` are not filled in, so that selection will not run. Writes (`INSERT`, `UPDATE`, …) ask for confirmation. Default page size is 1000 rows (`bisql.queryMaxRows`). Click a column header to sort.

## Requirements

- A Python file with SQL in a string
- A reachable SQL Server or MySQL / MariaDB database

## Limits

- Placeholders (`%s`, `?`, `:name`, f-string `{value}`) are replaced with `NULL` for analysis. F-string bits after a finished expression (`{access_filters}`) are dropped — they are filter fragments, not values. That can still create extra info notes in odd spots (`TOP %s`).
- SQL built only by joining variables is only partly checked. Those pieces are also skipped when formatting.
- Offline column checks skip CTEs, derived tables, and `EXEC`.
- Highlighting covers less than the validator (patterns cannot span lines).
- Result edits only work for a simple `SELECT` from one real table that includes every primary key column. Joins, views, `GROUP BY`, and expression columns cannot be written back.
