import { bracketIdent } from '../db/mssqlOps';
import { DbEngine } from '../db/engines';
import { ColumnInfo, TableInfo } from '../db/schemaTypes';
import { quoteIdent } from './functions';
import { formatQualifiedTable } from './qualifyTables';
import { QueryResult } from '../db/queryCells';

/** SQL that returns one row with the object DDL (or body) in a definition/ddl column. */
export function buildObjectDefinitionQuery(table: TableInfo, engine: DbEngine): string {
    if (engine === 'mysql') {
        const target = formatQualifiedTable(table, engine);
        return table.isView ? `SHOW CREATE VIEW ${target}` : `SHOW CREATE TABLE ${target}`;
    }
    if (engine === 'postgres') {
        const schema = table.schema.replace(/'/g, "''");
        const name = table.name.replace(/'/g, "''");
        if (table.isView) {
            return `SELECT pg_get_viewdef(format('%I.%I', '${schema}', '${name}')::regclass, true) AS definition`;
        }
        // Columns, nullability, and the primary key. Defaults, indexes, and foreign keys are left out.
        return (
            `SELECT 'CREATE TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || E' (\\n' ||\n` +
            `  string_agg(\n` +
            `    '    ' || quote_ident(a.attname) || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) ||\n` +
            `    CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,\n` +
            `    E',\\n' ORDER BY a.attnum\n` +
            `  ) || COALESCE((\n` +
            `    SELECT E',\\n    PRIMARY KEY (' || string_agg(quote_ident(pk.attname), ', ' ORDER BY cols.ord) || ')'\n` +
            `    FROM pg_catalog.pg_index i\n` +
            `    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS cols(attnum, ord) ON true\n` +
            `    JOIN pg_catalog.pg_attribute pk ON pk.attrelid = c.oid AND pk.attnum = cols.attnum\n` +
            `    WHERE i.indrelid = c.oid AND i.indisprimary AND cols.attnum > 0\n` +
            `  ), '') || E'\\n);' AS definition\n` +
            `FROM pg_catalog.pg_class c\n` +
            `JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n` +
            `JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid\n` +
            `WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped\n` +
            `  AND n.nspname = '${schema}' AND c.relname = '${name}'\n` +
            `GROUP BY n.nspname, c.relname, c.oid`
        );
    }
    if (engine === 'mssql') {
        if (table.isView) {
            const obj = `${bracketIdent(table.schema)}.${bracketIdent(table.name)}`;
            return `SELECT OBJECT_DEFINITION(OBJECT_ID(N'${obj.replace(/'/g, "''")}')) AS definition`;
        }
        return '';
    }
    if (engine === 'bigquery') {
        const info = `\`${table.database}.${table.schema}\`.INFORMATION_SCHEMA.TABLES`;
        const tableName = table.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const type = table.isView ? 'VIEW' : 'BASE TABLE';
        return (
            `SELECT ddl AS definition FROM ${info}\n` +
            `WHERE table_name = '${tableName}' AND table_type = '${type}'`
        );
    }
    return '';
}

function definitionColumnIndex(columns: string[]): number {
    const createIdx = columns.findIndex((column) => /^create\s/i.test(column));
    if (createIdx >= 0) {
        return createIdx;
    }
    const namedIdx = columns.findIndex((column) =>
        /^(definition|ddl|view_definition)$/i.test(column.trim())
    );
    if (namedIdx >= 0) {
        return namedIdx;
    }
    if (columns.length >= 2) {
        return columns.length - 1;
    }
    return 0;
}

/** SQL NULL is formatted as the word NULL. That is not a script. */
function textFromCell(value: unknown, formattedNull: boolean): string | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const text = (typeof value === 'string' ? value : String(value)).trim();
    if (!text || (formattedNull && text.toUpperCase() === 'NULL')) {
        return undefined;
    }
    return text;
}

export function extractDefinitionText(result: QueryResult): string | undefined {
    if (!result.ok || result.rows.length === 0) {
        return undefined;
    }
    const index = definitionColumnIndex(result.columns);
    if (result.rawRows && result.rawRows.length > 0) {
        return textFromCell(result.rawRows[0]?.[index], false);
    }
    return textFromCell(result.rows[0]?.[index], true);
}

export function formatDefinitionForEditor(
    table: TableInfo,
    engine: DbEngine,
    raw: string
): string {
    const text = raw.trim();
    if (!text) {
        return text;
    }
    if (engine === 'postgres' && table.isView) {
        const name = `${quoteIdent(table.schema, engine)}.${quoteIdent(table.name, engine)}`;
        if (/^create\s/i.test(text)) {
            return text;
        }
        return `CREATE OR REPLACE VIEW ${name} AS\n${text}`;
    }
    return text;
}

/** When the server has no one-shot DDL (SQL Server tables), build from cached columns. */
export function buildTableDefinitionFromCache(table: TableInfo, engine: DbEngine): string | undefined {
    if (table.isView || table.columns.length === 0) {
        return undefined;
    }
    if (engine === 'mssql') {
        return buildMssqlCreateTableFromCache(table);
    }
    return undefined;
}

function buildMssqlCreateTableFromCache(table: TableInfo): string {
    const lines = sortedColumns(table.columns).map((column) => lineForMssqlColumn(column));
    const pk = table.columns.filter((column) => column.isPrimaryKey);
    if (pk.length > 0) {
        lines.push(
            `    PRIMARY KEY (${pk.map((column) => bracketIdent(column.name)).join(', ')})`
        );
    }
    return (
        `CREATE TABLE ${bracketIdent(table.schema)}.${bracketIdent(table.name)} (\n` +
        `${lines.join(',\n')}\n);`
    );
}

function sortedColumns(columns: ColumnInfo[]): ColumnInfo[] {
    return [...columns].sort((left, right) => left.ordinal - right.ordinal);
}

function lineForMssqlColumn(column: ColumnInfo): string {
    let line = `    ${bracketIdent(column.name)} ${column.typeDisplay}`;
    if (!column.isNullable) {
        line += ' NOT NULL';
    }
    // The cache does not store the identity seed or step. Guessing (1,1) would
    // build a different table. The info message already says defaults are left out.
    return line;
}
