import * as mysql from 'mysql2/promise';
import { ExtensionConfig } from './config';

export function buildMysqlPool(config: ExtensionConfig, password: string): mysql.Pool {
    const ssl =
        config.encrypt
            ? config.trustServerCertificate
                ? { rejectUnauthorized: false }
                : {}
            : undefined;

    return mysql.createPool({
        host: config.server,
        port: config.port,
        user: config.user,
        password,
        database: config.database,
        waitForConnections: true,
        connectionLimit: 4,
        maxIdle: 2,
        idleTimeout: 60_000,
        connectTimeout: config.connectionTimeout,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
        // DATE as a JS Date is local midnight; toISOString() then shifts it.
        dateStrings: true,
        ...(ssl ? { ssl } : {})
    });
}

export function mysqlSchemaQuery(placeholderCount: number): string {
    const placeholders = Array.from({ length: placeholderCount }, () => '?').join(', ');
    return `SELECT
                c.TABLE_SCHEMA AS schema_name,
                c.TABLE_NAME AS table_name,
                t.TABLE_TYPE AS table_type,
                c.COLUMN_NAME AS column_name,
                c.ORDINAL_POSITION AS column_id,
                c.DATA_TYPE AS type_name,
                c.COLUMN_TYPE AS column_type,
                c.IS_NULLABLE AS is_nullable,
                c.EXTRA AS extra,
                c.COLUMN_KEY AS column_key
             FROM information_schema.COLUMNS c
             INNER JOIN information_schema.TABLES t
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
             WHERE c.TABLE_SCHEMA IN (${placeholders})
             ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;
}

export function mysqlForeignKeyQuery(placeholderCount: number): string {
    const placeholders = Array.from({ length: placeholderCount }, () => '?').join(', ');
    return `SELECT
                kcu.TABLE_SCHEMA AS database_name,
                kcu.TABLE_SCHEMA AS schema_name,
                kcu.TABLE_NAME AS table_name,
                kcu.CONSTRAINT_NAME AS constraint_name,
                kcu.COLUMN_NAME AS column_name,
                kcu.REFERENCED_TABLE_SCHEMA AS ref_database_name,
                kcu.REFERENCED_TABLE_SCHEMA AS ref_schema_name,
                kcu.REFERENCED_TABLE_NAME AS ref_table_name,
                kcu.REFERENCED_COLUMN_NAME AS ref_column_name,
                kcu.ORDINAL_POSITION AS ordinal
             FROM information_schema.KEY_COLUMN_USAGE kcu
             WHERE kcu.TABLE_SCHEMA IN (${placeholders})
               AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`;
}

export function isMysqlResultSetHeader(raw: unknown): raw is mysql.ResultSetHeader {
    return Boolean(
        raw && typeof raw === 'object' && !Array.isArray(raw) && 'affectedRows' in raw
    );
}

export function firstMysqlRowset(raw: unknown): mysql.RowDataPacket[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    if (raw.length === 0) {
        return [];
    }
    if (Array.isArray(raw[0])) {
        return (raw[0] as mysql.RowDataPacket[]) ?? [];
    }
    return raw as mysql.RowDataPacket[];
}

export function mysqlColumns(
    rows: mysql.RowDataPacket[],
    fields: unknown
): string[] {
    if (Array.isArray(fields) && fields.length > 0) {
        const first = fields[0];
        const list = Array.isArray(first)
            ? (first as mysql.FieldPacket[])
            : (fields as mysql.FieldPacket[]);
        const names = list
            .map((field) => field?.name)
            .filter((name): name is string => typeof name === 'string' && name.length > 0);
        if (names.length > 0) {
            return names;
        }
    }
    if (rows.length > 0) {
        return Object.keys(rows[0]);
    }
    return [];
}
