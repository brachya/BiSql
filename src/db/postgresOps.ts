import * as pg from 'pg';
import { ExtensionConfig } from './config';
import { LogPort } from './ports';

export const POSTGRES_COLUMN_QUERY = `SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    (c.relkind IN ('v', 'm')) AS is_view,
                    a.attname AS column_name,
                    a.attnum AS column_id,
                    t.typname AS type_name,
                    format_type(a.atttypid, a.atttypmod) AS type_display,
                    NOT a.attnotnull AS is_nullable,
                    (a.attidentity <> '' OR COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '') LIKE 'nextval(%') AS is_identity,
                    (a.attgenerated <> '') AS is_computed
                 FROM pg_catalog.pg_class c
                 INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 INNER JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
                 INNER JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
                 LEFT JOIN pg_catalog.pg_attrdef ad
                        ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                 WHERE c.relkind IN ('r', 'p', 'v', 'm')
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                   AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
                   AND a.attnum > 0
                   AND NOT a.attisdropped
                 ORDER BY n.nspname, c.relname, a.attnum`;

export const POSTGRES_KEY_QUERY = `SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    a.attname AS column_name
                 FROM pg_catalog.pg_index i
                 INNER JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
                 INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 INNER JOIN pg_catalog.pg_attribute a
                         ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
                 WHERE i.indisprimary
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                   AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'`;

export const POSTGRES_FOREIGN_KEY_QUERY = `SELECT
                    current_database() AS database_name,
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    con.conname AS constraint_name,
                    a.attname AS column_name,
                    current_database() AS ref_database_name,
                    nr.nspname AS ref_schema_name,
                    cr.relname AS ref_table_name,
                    ar.attname AS ref_column_name,
                    u.ord AS ordinal
                 FROM pg_catalog.pg_constraint con
                 INNER JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
                 INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 INNER JOIN pg_catalog.pg_class cr ON cr.oid = con.confrelid
                 INNER JOIN pg_catalog.pg_namespace nr ON nr.oid = cr.relnamespace
                 INNER JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(attnum, refattnum, ord) ON true
                 INNER JOIN pg_catalog.pg_attribute a
                         ON a.attrelid = c.oid AND a.attnum = u.attnum
                 INNER JOIN pg_catalog.pg_attribute ar
                         ON ar.attrelid = cr.oid AND ar.attnum = u.refattnum
                 WHERE con.contype = 'f'
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                   AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
                 ORDER BY n.nspname, c.relname, con.conname, u.ord`;

export function buildPostgresPool(
    config: ExtensionConfig,
    password: string,
    output: LogPort
): pg.Pool {
    const ssl = config.encrypt
        ? { rejectUnauthorized: !config.trustServerCertificate }
        : false;
    const pool = new pg.Pool({
        host: config.server,
        port: config.port,
        user: config.user,
        password,
        database: config.database,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: config.connectionTimeout,
        application_name: 'BiSql',
        ssl
    });
    pool.on('error', (err: Error) => {
        output.appendLine(`[pool] ${err.message}`);
    });
    return pool;
}
