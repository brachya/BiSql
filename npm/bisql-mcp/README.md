# bisql-mcp

BiSql MCP server for Cursor, Claude Desktop, and other MCP hosts. It runs as a Node process over **stdio** and talks to your database using the same schema-aware tools as the BiSql VS Code extension.

## Requirements

- Node.js 20+
- Network access from the machine that runs this process to your database (VPN or private networks may block cloud agents)
- A database login; prefer **read-only** unless you need writes

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `BISQL_URL` | yes | Connection URL (see below) |
| `BISQL_ALLOW_MUTATING` | no | `true` / `1` to allow `INSERT` / `UPDATE` / `DELETE` / DDL when the tool also passes `allow_mutating: true`. Default: off |
| `BISQL_MAX_ROWS` | no | Max rows per MCP reply (1–1000). Default: `50` |
| `BISQL_BIGQUERY_CONFIRM_SCAN_MB` | no | BigQuery dry-run scan threshold in MB. Default: `1024` |
| `BISQL_CACHE_DIR` | no | Where to store the schema snapshot. Default: `~/.cache/bisql`. Set to `off` to load from the database on every new process. A snapshot younger than 30 minutes is reused. `bisql_refresh_schema` always reloads from the database. |

BigQuery uses [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials). Set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file, or run `gcloud auth application-default login` on your machine.

## `BISQL_URL` formats

**PostgreSQL / Supabase**

`sslmode=require` (the default when `sslmode` is left out) encrypts and does not check the server certificate. That matches libpq and a Supabase dashboard URL. `sslmode=verify-full` checks the certificate. `trustServerCertificate=false` checks it even with `sslmode=require`. `trustServerCertificate=true` skips the check. Use `sslmode=disable` only on a trusted local network.

```text
postgresql://user:password@host:5432/dbname
postgresql://user:password@host:5432/dbname?trustServerCertificate=true
```

**MySQL**

```text
mysql://user:password@host:3306/dbname?databases=db1,db2
```

**SQL Server**

Named instances use a backslash in the host: `host\INSTANCE`.

```text
mssql://user:password@host:1433/dbname?encrypt=true&trustServerCertificate=true&databases=db1,db2
mssql://user:password@localhost\SQLEXPRESS/WideWorld?trustServerCertificate=true
```

**BigQuery**

```text
bigquery://my-gcp-project/my_dataset?projects=other-project
```

## Run

```bash
export BISQL_URL='postgresql://user:pass@host:5432/mydb'
npx bisql-mcp
```

## Cursor / Claude `mcp.json` example

```json
{
  "mcpServers": {
    "bisql": {
      "command": "npx",
      "args": ["-y", "bisql-mcp@0.1.0"],
      "env": {
        "BISQL_URL": "postgresql://user:password@host:5432/dbname"
      }
    }
  }
}
```

## Tools

`bisql_status`, `bisql_refresh_schema`, `bisql_list_databases`, `bisql_list_tables`, `bisql_describe_table`, `bisql_search_schema`, `bisql_compare_schema`, `bisql_validate_sql`, `bisql_explain_sql`, `bisql_run_sql`.

See the `bisql://docs/guide` resource after connect.

## Security

- Use a read-only database user when agents only need `SELECT`.
- Writes need `BISQL_ALLOW_MUTATING=true` **and** `allow_mutating: true` on the tool call.
- Do not commit `BISQL_URL` to git; pass it as a secret in your MCP host config.
- The schema cache stores table and column names, not passwords or query rows.
