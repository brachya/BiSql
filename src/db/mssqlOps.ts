import * as mssql from 'mssql';
import { ExtensionConfig } from './config';

export function bracketIdent(name: string): string {
    return `[${name.replace(/\]/g, ']]')}]`;
}

/**
 * Renders a SQL Server type the way it would appear in a CREATE TABLE statement.
 */
export function renderType(
    typeName: string,
    maxLength: number,
    precision: number,
    scale: number
): string {
    const name = typeName.toLowerCase();
    switch (name) {
        case 'char':
        case 'varchar':
        case 'binary':
        case 'varbinary':
            return maxLength === -1 ? `${name}(max)` : `${name}(${maxLength})`;
        case 'nchar':
        case 'nvarchar':
            return maxLength === -1 ? `${name}(max)` : `${name}(${Math.floor(maxLength / 2)})`;
        case 'decimal':
        case 'numeric':
            return `${name}(${precision},${scale})`;
        case 'datetime2':
        case 'time':
        case 'datetimeoffset':
            return `${name}(${scale})`;
        case 'float':
            return precision === 53 ? name : `${name}(${precision})`;
        default:
            return name;
    }
}

export function mssqlColumnQueryForDatabase(database: string): string {
    const db = bracketIdent(database);
    return `
SELECT
    N'${database.replace(/'/g, "''")}' AS database_name,
    s.name        AS schema_name,
    t.name        AS table_name,
    t.is_view     AS is_view,
    c.name        AS column_name,
    c.column_id   AS column_id,
    ty.name       AS type_name,
    c.max_length  AS max_length,
    c.precision   AS precision,
    c.scale       AS scale,
    c.is_nullable AS is_nullable,
    c.is_identity AS is_identity,
    c.is_computed AS is_computed
FROM (
    SELECT object_id, schema_id, name, CAST(0 AS bit) AS is_view FROM ${db}.sys.tables
    UNION ALL
    SELECT object_id, schema_id, name, CAST(1 AS bit) AS is_view FROM ${db}.sys.views
) AS t
INNER JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
INNER JOIN ${db}.sys.columns c ON c.object_id = t.object_id
INNER JOIN ${db}.sys.types   ty ON ty.user_type_id = c.user_type_id
ORDER BY s.name, t.name, c.column_id;
`;
}

export function mssqlPrimaryKeyQueryForDatabase(database: string): string {
    const db = bracketIdent(database);
    return `
SELECT
    N'${database.replace(/'/g, "''")}' AS database_name,
    s.name AS schema_name,
    t.name AS table_name,
    c.name AS column_name
FROM ${db}.sys.key_constraints kc
INNER JOIN ${db}.sys.tables  t  ON t.object_id = kc.parent_object_id
INNER JOIN ${db}.sys.schemas s  ON s.schema_id = t.schema_id
INNER JOIN ${db}.sys.index_columns ic
        ON ic.object_id = kc.parent_object_id
       AND ic.index_id  = kc.unique_index_id
INNER JOIN ${db}.sys.columns c
        ON c.object_id = ic.object_id
       AND c.column_id = ic.column_id
WHERE kc.type = 'PK';
`;
}

export function buildMssqlConfig(config: ExtensionConfig, password: string): mssql.config {
    const [host, instanceName] = config.server.split('\\');
    const options: mssql.config['options'] = {
        encrypt: config.encrypt,
        trustServerCertificate: config.trustServerCertificate,
        enableArithAbort: true,
        appName: 'BiSql'
    };
    if (instanceName) {
        options.instanceName = instanceName;
    }

    const poolConfig: mssql.config = {
        server: host,
        database: config.database,
        user: config.user,
        password,
        connectionTimeout: config.connectionTimeout,
        requestTimeout: config.connectionTimeout,
        options,
        pool: {
            max: 4,
            min: 0,
            idleTimeoutMillis: 30000
        }
    };
    if (!instanceName) {
        poolConfig.port = config.port;
    }
    return poolConfig;
}

export function firstMssqlRecordset(
    result: mssql.IResult<Record<string, unknown>>
): mssql.IRecordSet<Record<string, unknown>> | undefined {
    const sets = result.recordsets;
    if (Array.isArray(sets) && sets.length > 0 && Array.isArray(sets[0])) {
        return sets[0] as mssql.IRecordSet<Record<string, unknown>>;
    }
    return result.recordset as mssql.IRecordSet<Record<string, unknown>> | undefined;
}

export function mssqlColumns(
    recordset: mssql.IRecordSet<Record<string, unknown>> | undefined
): string[] {
    if (!recordset) {
        return [];
    }
    if (recordset.columns) {
        return Object.keys(recordset.columns);
    }
    if (recordset.length > 0) {
        return Object.keys(recordset[0]);
    }
    return [];
}

export function sumRowsAffected(values: number[] | undefined): number | undefined {
    if (!values || values.length === 0) {
        return undefined;
    }
    return values.reduce((sum, value) => sum + value, 0);
}

export function collectRequestErrors(error: unknown): mssql.RequestError[] {
    if (!(error instanceof Error)) {
        return [];
    }
    const candidate = error as mssql.RequestError & { precedingErrors?: unknown };
    const results: mssql.RequestError[] = [];
    if (Array.isArray(candidate.precedingErrors)) {
        for (const preceding of candidate.precedingErrors) {
            if (preceding instanceof Error) {
                results.push(preceding as mssql.RequestError);
            }
        }
    }
    if (typeof candidate.number === 'number' || candidate.name === 'RequestError') {
        results.push(candidate);
    }
    return results;
}
