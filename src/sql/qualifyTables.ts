import { quoteIdent } from './functions';

export type QualifyEngine = 'mysql' | 'mssql' | 'postgres';

export interface QualifiableTable {
    database: string;
    schema: string;
    name: string;
}

export interface TableSpan {
    table: string;
    start: number;
    end: number;
}

export function splitRefParts(reference: string): string[] {
    return reference
        .split('.')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

export function alreadyHasDatabase(reference: string, engine: QualifyEngine): boolean {
    const parts = splitRefParts(reference);
    if (engine === 'mysql' || engine === 'postgres') {
        // MySQL: database.table. Postgres: schema.table (one database per connection).
        return parts.length >= 2;
    }
    return parts.length >= 3;
}

export function formatQualifiedTable(table: QualifiableTable, engine: QualifyEngine): string {
    if (engine === 'mysql') {
        return `${quoteIdent(table.database, engine)}.${quoteIdent(table.name, engine)}`;
    }
    if (engine === 'postgres') {
        return `${quoteIdent(table.schema, engine)}.${quoteIdent(table.name, engine)}`;
    }
    return (
        `${quoteIdent(table.database, engine)}.` +
        `${quoteIdent(table.schema, engine)}.` +
        `${quoteIdent(table.name, engine)}`
    );
}

export function qualifierForRef(
    reference: string,
    table: QualifiableTable | undefined,
    engine: QualifyEngine,
    defaultDatabase: string,
    cteNames: Set<string> = new Set()
): string | undefined {
    if (!table) {
        return undefined;
    }
    const parts = splitRefParts(reference);
    if (parts.length === 0) {
        return undefined;
    }
    const bare = parts[parts.length - 1].toLowerCase();
    if (cteNames.has(bare)) {
        return undefined;
    }
    if (alreadyHasDatabase(reference, engine)) {
        return undefined;
    }
    const defaultDb = defaultDatabase.trim().toLowerCase();
    if (defaultDb && table.database.toLowerCase() === defaultDb) {
        return undefined;
    }
    return formatQualifiedTable(table, engine);
}

/**
 * Prefixes unqualified table names with the catalog they actually live in.
 * Used so MySQL EXPLAIN / live queries do not look in the default database only.
 */
export function qualifyCrossDatabaseSql(
    sql: string,
    refs: TableSpan[],
    resolve: (reference: string) => QualifiableTable | undefined,
    engine: QualifyEngine,
    defaultDatabase: string,
    cteNames: Set<string> = new Set()
): string {
    const replacements: { start: number; end: number; text: string }[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        const key = `${ref.start}:${ref.end}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const qualified = qualifierForRef(
            ref.table,
            resolve(ref.table),
            engine,
            defaultDatabase,
            cteNames
        );
        if (!qualified) {
            continue;
        }
        const written = sql.slice(ref.start, ref.end);
        if (written === qualified) {
            continue;
        }
        replacements.push({ start: ref.start, end: ref.end, text: qualified });
    }
    replacements.sort((a, b) => b.start - a.start);
    let result = sql;
    for (const item of replacements) {
        result = result.slice(0, item.start) + item.text + result.slice(item.end);
    }
    return result;
}
