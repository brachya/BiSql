# BiSql

Write SQL inside Python strings or in `.sql` files and get checks, completion, hover, and format from your real database schema.

Works with **Microsoft SQL Server**, **MySQL / MariaDB**, **PostgreSQL**, **Supabase**, and **BigQuery**.

## Features

- **Catch bad SQL early** — table and column names are checked while you type. On save, the query is dry-run (no data changes).
- **Completion and hover** — SQL keywords, tables, columns, and common SQL functions. Hover shows type, nullability, and primary keys.
- **SQL highlighting** inside matching Python strings, and in `.sql` files (VS Code’s SQL coloring).
- **Format SQL** in a Python file, a `.sql` file, or a selection. Your Python formatter still owns Format Document in `.py` files.
- **Run Selected SQL** — see rows in a table under the editor, page through results, sort columns, and export JSON or CSV.
- **Schema sidebar and map** — find a cached table, open its definition, and see how tables link. Real foreign keys are drawn solid. A name guess such as `customer_id` → `customers` is marked as a guess.
- **Edit the query in the real editor** — from results, **Edit** opens a SQL tab with the same suggestions as Python. Run again from that tab or from the results **Run** button.
- **Edit simple results** — on a plain `SELECT` from one table that includes the primary key, you can edit a cell, set NULL, delete a row, or rename a column. Each write asks for confirmation.
- **Works offline after the first connect** — schema is cached on disk.

## Get started

1. Open the Command Palette and run **BiSql: Switch Connection** (or click the SQL item in the status bar). Pick a saved login, or **Edit connections…** for the login page. **BiSql: Open Connection / Login** also opens that page.
2. Add or pick a saved connection. Only one is active at a time. Switching reconnects.
3. Pick one login kind. Only that kind’s fields are shown.
4. **SQL Server** / **MySQL** — host, port, databases, user, password.
   **PostgreSQL** — host, port, one database, user, password.
   **Supabase** — paste the `postgresql://` URL from Project Settings → Database. Prefer the Session pooler URL if the direct `db.…` host times out.
   **BigQuery** — Google Cloud project id (home project) and one or more datasets. Click **Load projects**, set home, and check **Cache** on other projects you want in the schema cache (home is always cached). Pick datasets per project, or cache all when pinning a project. **Refresh Database Schema** asks which cached project(s) to reload. The background timer refreshes the home project only. You can still type `other-project.dataset`. **BiSql: Switch Project** changes home on this login from the command palette. Sign in once with `gcloud auth application-default login`. Run / Explain / dry-run work. A scan above 1 GB (`bisql.bigqueryConfirmScanMb`) asks first. `LIMIT` does not reduce bytes scanned.
5. Click **Save & Connect**. Rename or delete from the list. Optional: pin this connection to the current project.

An older single login is copied into the list on first launch. The old settings stay as a fallback.

PostgreSQL and Supabase connect to **one database**. Schema loads from every user schema in that database (`public` and others). Extra databases cannot be queried on the same login.

The password is stored in the OS keychain, one secret per connection. Other fields are saved in user settings.

Use a **read-only** login when you can.

## Cursor AI (MCP)

When BiSql is connected inside **Cursor**, the agent can use the same live connection and schema cache. No `mcp.json` and no second login.

The agent can list tables, describe columns, compare two databases in the schema cache, refresh that cache, run `SELECT`, validate SQL, and explain a query. Writes are blocked unless you turn on `bisql.mcpAllowMutating`. `EXPLAIN ANALYZE` counts as a write. Plain `EXPLAIN` stays read-only. Chat results are capped (`bisql.mcpMaxResultRows`, default 50); the results tab still shows the full page and does not steal editor focus. Usage docs are at `bisql://docs/guide`.

Turn this off with `bisql.mcpEnabled`.

## When a string is treated as SQL

A Python string is treated as SQL if any of these are true:

1. It contains `--sql` or `/* sql */`
2. It is assigned to a name that contains `query`, `stmt`, or `statement` (`update_query`, `query_1`), or `sql` as its own word (`sql`, `raw_sql`, `sql_text`). `sqlite` and `sqlalchemy` are ignored.
3. It is passed to `.execute(`, `.executemany(`, `read_sql(`, `read_sql_query(`, or `text(`

A `.sql` file is treated as SQL. Column and table completions use the statement under the caret. Hover still reads the whole file. Run / Format / Explain / Validate sit above each statement. BiSql does not write query edits from results back into a Python string.

## Suggestions inside strings

Space, `.`, and `,` open the suggestion list on their own.

Typing letters inside a string does **not**, unless VS Code suggestions in strings are on for Python. BiSql offers to enable this once. You can also run **BiSql: Enable Suggestions Inside Python Strings**.

## Commands

| Command | What it does |
| --- | --- |
| **BiSql: Switch Connection** | Pick a saved login. Status bar click does the same. |
| **BiSql: Switch Project** | BigQuery: pick a Google Cloud project for this login. Old datasets stay as extras. |
| **BiSql: Open Connection / Login** | Open the login page |
| **BiSql: Run Selected SQL** | Run the SQL at the caret or in the selection and show results. In a `.sql` file with no selection, runs the statement under the caret. |
| **BiSql: Query History** | Open a query you ran before in a SQL tab. The last 100 are kept (`bisql.queryHistorySize`). A query longer than 20,000 characters is skipped. Set the size to 0 to turn history off. |
| **BiSql: Browse Cached Schema** | Search cached tables, compare two databases, or open the map. |
| **BiSql: Visualize Database Schema** | Open the schema map. With more than one database, schema, or dataset, you pick one. |
| **BiSql: Find Table** | Jump to a cached table in the sidebar. |
| **BiSql: Format SQL in File** | Pretty-print every detected SQL string in a Python file, or the whole `.sql` file |
| **BiSql: Refresh Database Schema** | Reload tables, columns, and foreign keys |
| **BiSql: Test Connection** | Check that the login works |
| **BiSql: Validate Current File** | Run checks on the open file now |
| **BiSql: Set Password** / **Clear Stored Password** | Update or remove the keychain password |
| **BiSql: Clear Cached Schema Snapshot** | Delete the local schema cache |
| **BiSql: Enable Suggestions Inside Python Strings** | Turn on letter suggestions inside Python strings |

**Format Selection** formats the SQL string under the caret or in the selection. In a `.sql` file it formats the selection, or the whole file if nothing is selected. Keyword, function, and type case can be set on their own. You can also set tab width, tabs, where `AND` / `OR` break, blank lines between statements, expression width, dense operators (`a=b`), and a semicolon on its own line.

Above each SQL string in Python, and above each statement in a `.sql` file, BiSql shows **Run | Format | Explain | Validate**. Those buttons use that query only.

**Run Selected SQL** asks for values for `{name}` placeholders and f-string calls like `{get_building_fields(...)}` (pasted into the SQL) and named binds (`:path`, `:search`). Empty `{name}` pastes nothing. Empty `:name` means `NULL`. Writes (`INSERT`, `UPDATE`, …) ask for confirmation. Plain `EXPLAIN` stays read-only. `EXPLAIN ANALYZE` runs the statement, so it asks too (`EXPLAIN (VERBOSE, ANALYZE)` counts as well). Default page size is 1000 rows (`bisql.queryMaxRows`). Click a column header to sort. A cell longer than 4,000 characters shows only the start in the grid. Copy and Open use the stored text. A cell past 1,000,000 characters is cut, and the rest is not loaded.

Right-click a table or view in the sidebar for **Show Data**, **New Query**, **Show Definition**, **Insert Name**, and **Copy SELECT \***. **New Query** lists the columns. **Show Definition** loads the server script when it can (MySQL `SHOW CREATE`, a Postgres view, BigQuery `ddl`, a SQL Server view). A SQL Server table or a Postgres table opens a column list. Defaults, indexes, foreign keys, and the identity seed are left out.

The map is one database, schema, or dataset at a time. Refresh schema once after an upgrade so foreign keys load into an older cache. BigQuery has no keys in the cache, so that map draws no links.

In a `.sql` tab, **Ctrl+Enter** (Cmd+Enter on Mac) runs the statement under the caret. Select all to run more than one. Results open in a group under the editor. If that file is already linked to a results view, the same results tab updates.

From **SQL Results**, **Edit** opens (or focuses) a real SQL editor. Params stay in the results tab. **Run** uses the statement at the caret in the linked editor. **Refresh** still re-runs the last successful query, not an unrun draft.

## Requirements

- A Python file with SQL in a string, or a `.sql` file
- A reachable SQL Server, MySQL / MariaDB, or PostgreSQL database, or a BigQuery project with Application Default Credentials

## Limits

- Placeholders (`%s`, `?`, `:name`, f-string `{value}`) are replaced with `NULL` for analysis. F-string bits after a finished expression (`{access_filters}`) are dropped — they are filter fragments, not values. That can still create extra info notes in odd spots (`TOP %s`).
- SQL built only by joining variables is only partly checked. Those pieces are also skipped when formatting.
- Offline column checks skip CTEs, derived tables, and `EXEC`.
- Highlighting in Python strings and the results preview covers less than the validator (patterns cannot span lines). `.sql` files use VS Code’s SQL coloring.
- Result edits only work for a simple `SELECT` from one real table that includes every primary key column. Joins, views, `GROUP BY`, and expression columns cannot be written back.
- Query history stores the SQL you ran in this workspace. It is not a place for passwords or tokens.
- Schema map guesses match a `*_id` column to a table name in the same database. The map marks them as guesses. They are not foreign keys.
- BigQuery: `LIMIT` does not reduce bytes scanned. A dry-run estimate above `bisql.bigqueryConfirmScanMb` (default 1 GB) asks before Run. Nested `STRUCT` / `ARRAY` fields show only as the top-level column in schema; query results show them as JSON. Each dataset schema load bills the 10 MB query minimum.
