import type { ColumnInfo, TableInfo } from '../db/connection';
import {
    collectCteDefs,
    collectSelectLists,
    collectTableRefs,
    parseSelectItems,
    SqlToken,
    type CteDef
} from '../parser/sqlExtractor';

export {
    collectCteNames,
    collectTableRefs,
    parseSelectItems,
    tokenizeSql
} from '../parser/sqlExtractor';

/**
 * Builds a virtual table for each CTE, using the SELECT list and FROM tables.
 * Later CTEs can use earlier ones. Nested CTEs are resolved first.
 *
 * When the SELECT list is only placeholders (`NULL` from an f-string), columns
 * are copied from the FROM tables.
 */
export function resolveCteTables(
    tokens: SqlToken[],
    findTable: (reference: string) => TableInfo | undefined
): Map<string, TableInfo> {
    const result = new Map<string, TableInfo>();
    const defs = collectCteDefs(tokens);
    const resolving = new Set<string>();

    const lookup = (reference: string): TableInfo | undefined => {
        const bare = bareName(reference).toLowerCase();
        const parts = reference.split('.').filter((part) => part.length > 0);
        if (parts.length <= 1) {
            const cte = result.get(bare);
            if (cte) {
                return cte;
            }
        }
        return findTable(reference) ?? result.get(bare);
    };

    const resolveOne = (def: CteDef): TableInfo => {
        const key = def.name.toLowerCase();
        const existing = result.get(key);
        if (existing) {
            return existing;
        }
        if (resolving.has(key)) {
            return makeCteTable(def.name, []);
        }
        resolving.add(key);

        for (const other of defs) {
            if (other === def) {
                continue;
            }
            if (other.bodyOpen > def.bodyOpen && other.bodyClose < def.bodyClose) {
                resolveOne(other);
            }
        }

        const body = tokens.slice(def.bodyOpen + 1, def.bodyClose);
        const { refs } = collectTableRefs('', body);
        const items = parseSelectItems(body);
        const sourceTables: TableInfo[] = [];
        const aliasMap = new Map<string, TableInfo>();
        for (const ref of refs) {
            if (bareName(ref.table).toLowerCase() === key) {
                continue;
            }
            const table = lookup(ref.table);
            if (!table) {
                continue;
            }
            sourceTables.push(table);
            aliasMap.set(ref.alias.toLowerCase(), table);
            aliasMap.set(bareName(ref.table).toLowerCase(), table);
        }

        const columns = columnsForCte(def, items, sourceTables, aliasMap, lookup);
        const table = makeCteTable(def.name, columns);
        result.set(key, table);
        resolving.delete(key);
        return table;
    };

    for (const def of defs) {
        resolveOne(def);
    }
    return result;
}

export function findRelation(
    reference: string,
    findTable: (reference: string) => TableInfo | undefined,
    ctes: Map<string, TableInfo>
): TableInfo | undefined {
    const parts = reference.split('.').filter((part) => part.length > 0);
    if (parts.length === 1) {
        const cte = ctes.get(parts[0].toLowerCase());
        if (cte) {
            return cte;
        }
    }
    return findTable(reference);
}

export function isCteTable(table: TableInfo): boolean {
    return table.database.length === 0 && table.schema === 'cte';
}

/**
 * Python f-string column lists become `NULL` for analysis. MySQL EXPLAIN then
 * thinks a CTE has no columns. Replace those placeholder SELECT lists with `*`
 * so dry-run still sees the FROM table / CTE columns. Real `SELECT NULL` is kept.
 */
export function rewriteSyntheticSelectLists(
    sql: string,
    tokens: SqlToken[],
    isSynthetic: (offset: number) => boolean
): string {
    const replacements: { start: number; end: number; text: string }[] = [];
    for (const list of collectSelectLists(tokens)) {
        if (list.items.length === 0 || list.itemStart >= tokens.length) {
            continue;
        }
        const endTok = list.itemEnd < tokens.length ? tokens[list.itemEnd] : undefined;
        if (!endTok || endTok.value.toLowerCase() !== 'from') {
            continue;
        }
        if (!list.items.every((item) => item.kind === 'expr')) {
            continue;
        }
        let sawPlaceholder = false;
        let allSynthetic = true;
        for (let i = list.itemStart; i < list.itemEnd; i++) {
            const tok = tokens[i];
            if (tok.kind === 'punct') {
                continue;
            }
            if (tok.kind === 'keyword' && tok.value.toLowerCase() === 'null') {
                sawPlaceholder = true;
                if (!isSynthetic(tok.start)) {
                    allSynthetic = false;
                    break;
                }
                continue;
            }
            allSynthetic = false;
            break;
        }
        if (!sawPlaceholder || !allSynthetic) {
            continue;
        }
        replacements.push({
            start: tokens[list.itemStart].start,
            end: endTok.start,
            text: ' * '
        });
    }
    if (replacements.length === 0) {
        return sql;
    }
    replacements.sort((a, b) => b.start - a.start);
    let result = sql;
    for (const item of replacements) {
        result = result.slice(0, item.start) + item.text + result.slice(item.end);
    }
    return result;
}

function columnsForCte(
    def: CteDef,
    items: ReturnType<typeof parseSelectItems>,
    sourceTables: TableInfo[],
    aliasMap: Map<string, TableInfo>,
    lookup: (reference: string) => TableInfo | undefined
): ColumnInfo[] {
    if (def.declaredColumns.length > 0) {
        return uniqueColumns(
            def.declaredColumns.map((name, index) => {
                const fromSource = findColumnInSources(name, sourceTables);
                return fromSource
                    ? copyColumn(fromSource, name, index)
                    : syntheticColumn(name, index);
            })
        );
    }

    const named: ColumnInfo[] = [];
    let opaque = false;
    for (const item of items) {
        if (item.kind === 'star') {
            for (const table of sourceTables) {
                named.push(...table.columns);
            }
            continue;
        }
        if (item.kind === 'qualifiedStar') {
            const table =
                aliasMap.get(item.qualifier.toLowerCase()) ?? lookup(item.qualifier);
            if (table) {
                named.push(...table.columns);
            } else {
                opaque = true;
            }
            continue;
        }
        if (item.kind === 'column') {
            const table = item.qualifier
                ? aliasMap.get(item.qualifier.toLowerCase()) ?? lookup(item.qualifier)
                : ownerOfColumn(item.name, sourceTables);
            const col = table?.columnsByLower.get(item.name.toLowerCase());
            named.push(
                col ? copyColumn(col, item.name, named.length) : syntheticColumn(item.name, named.length)
            );
            continue;
        }
        opaque = true;
    }

    if (named.length === 0 || opaque) {
        return uniqueColumns([
            ...sourceTables.flatMap((table) => table.columns),
            ...named
        ]);
    }
    return uniqueColumns(named);
}

function ownerOfColumn(name: string, tables: TableInfo[]): TableInfo | undefined {
    const key = name.toLowerCase();
    return tables.find((table) => table.columnsByLower.has(key));
}

function findColumnInSources(name: string, tables: TableInfo[]): ColumnInfo | undefined {
    const key = name.toLowerCase();
    for (const table of tables) {
        const column = table.columnsByLower.get(key);
        if (column) {
            return column;
        }
    }
    return undefined;
}

function uniqueColumns(columns: ColumnInfo[]): ColumnInfo[] {
    const seen = new Set<string>();
    const result: ColumnInfo[] = [];
    for (const column of columns) {
        const key = column.name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(copyColumn(column, column.name, result.length));
    }
    return result;
}

function copyColumn(column: ColumnInfo, name: string, ordinal: number): ColumnInfo {
    return { ...column, name, ordinal };
}

function syntheticColumn(name: string, ordinal: number): ColumnInfo {
    return {
        name,
        ordinal,
        typeName: '',
        typeDisplay: '',
        isNullable: true,
        isIdentity: false,
        isComputed: true,
        isPrimaryKey: false
    };
}

function makeCteTable(name: string, columns: ColumnInfo[]): TableInfo {
    const columnsByLower = new Map<string, ColumnInfo>();
    for (const column of columns) {
        columnsByLower.set(column.name.toLowerCase(), column);
    }
    return {
        database: '',
        schema: 'cte',
        name,
        fullName: name,
        qualifiedName: name,
        isView: true,
        columns,
        columnsByLower
    };
}

function bareName(reference: string): string {
    const parts = reference.split('.').filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? reference;
}
