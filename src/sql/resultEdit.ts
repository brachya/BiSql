import { ColumnInfo, DbEngine, TableInfo } from '../db/connection';
import { collectTableRefs, SqlToken, tokenizeSql } from '../parser/sqlExtractor';
import { quoteIdent } from './functions';

/** Display sentinel used by query results for database NULL. */
export const NULL_DISPLAY = 'NULL';

export interface ResultColumnEdit {
    displayName: string;
    sourceColumn: string | undefined;
    canEdit: boolean;
    canSetNull: boolean;
    canRename: boolean;
    isPrimaryKey: boolean;
    isIdentity: boolean;
    isComputed: boolean;
    isNullable: boolean;
    typeName: string;
    typeDisplay: string;
}

export interface ResultEditPlan {
    editable: boolean;
    reason: string;
    tableDisplay: string;
    table: TableInfo | undefined;
    engine: DbEngine;
    columns: ResultColumnEdit[];
    pkIndexes: number[];
}

export interface MutationSql {
    sql: string;
    params: Record<string, string | null>;
}

const SELECT_ITEM_END = new Set([
    'from',
    'into',
    'where',
    'group',
    'order',
    'having',
    'limit',
    'union',
    'except',
    'intersect',
    'window',
    'fetch',
    'for',
    'offset'
]);

const FROM_END = new Set([
    'where',
    'group',
    'order',
    'having',
    'limit',
    'union',
    'except',
    'intersect',
    'window',
    'fetch',
    'for',
    'offset'
]);

type SelectItem =
    | { kind: 'star'; qualifier?: string }
    | { kind: 'column'; qualifier?: string; column: string }
    | { kind: 'expression' };

/**
 * Decide whether this result set can be edited in the live database,
 * and map each result column to a real table column when possible.
 */
export function analyzeResultEdit(
    sql: string,
    resultColumns: string[],
    engine: DbEngine,
    findTable: (reference: string) => TableInfo | undefined
): ResultEditPlan {
    const locked = (reason: string, table?: TableInfo): ResultEditPlan => ({
        editable: false,
        reason,
        tableDisplay: table ? displayTableName(table, engine) : '',
        table,
        engine,
        columns: resultColumns.map((name) => displayOnlyColumn(name, table)),
        pkIndexes: []
    });

    if (resultColumns.length === 0) {
        return locked('No result rows to edit.');
    }

    const shape = inspectSelectShape(sql);
    if (!shape.ok) {
        return locked(shape.reason);
    }

    const { refs, hasCte, hasDerived, hasExec } = collectTableRefs(sql);
    if (hasCte) {
        return locked('This query uses WITH / a CTE, so rows cannot be edited.');
    }
    if (hasDerived) {
        return locked('This query uses a subquery in FROM, so rows cannot be edited.');
    }
    if (hasExec) {
        return locked('This query is not a simple SELECT, so rows cannot be edited.');
    }
    if (refs.length === 0) {
        return locked('Could not find a table in FROM.');
    }
    if (refs.length !== 1) {
        return locked('Only a SELECT from one table can be edited (no JOIN).');
    }

    const table = findTable(refs[0].table);
    if (!table) {
        return locked(
            `Table '${refs[0].table}' is not in the schema cache. Connect and refresh schema, then run the query again.`
        );
    }
    if (table.isView) {
        return locked(`'${displayTableName(table, engine)}' is a view. Views cannot be edited here.`, table);
    }

    const pkColumns = table.columns.filter((column) => column.isPrimaryKey);
    if (pkColumns.length === 0) {
        return locked(
            `'${displayTableName(table, engine)}' has no primary key, so a row cannot be identified.`,
            table
        );
    }

    const items = collectSelectItems(sql);
    if (items.length === 0) {
        return locked('Could not read the SELECT list.', table);
    }

    const aliasLower = refs[0].alias.toLowerCase();
    const tableNameLower = table.name.toLowerCase();
    const mapped = expandSelectItems(items, table, aliasLower, tableNameLower);
    if (!mapped) {
        return locked('Could not map the SELECT list to table columns.', table);
    }
    if (mapped.length !== resultColumns.length) {
        return locked(
            'The SELECT list does not match the result columns, so this table cannot be edited safely.',
            table
        );
    }

    const columns: ResultColumnEdit[] = mapped.map((item, index) =>
        toResultColumn(item, resultColumns[index], table)
    );

    const presentPk = new Set(
        columns
            .filter((column) => column.isPrimaryKey && column.sourceColumn)
            .map((column) => column.sourceColumn!.toLowerCase())
    );
    const missingPk = pkColumns.filter((column) => !presentPk.has(column.name.toLowerCase()));
    if (missingPk.length > 0) {
        const names = missingPk.map((column) => column.name).join(', ');
        return {
            editable: false,
            reason: `Add the primary key column(s) (${names}) to the SELECT to edit rows.`,
            tableDisplay: displayTableName(table, engine),
            table,
            engine,
            columns,
            pkIndexes: []
        };
    }

    const pkIndexes = columns
        .map((column, index) => (column.isPrimaryKey ? index : -1))
        .filter((index) => index >= 0);

    return {
        editable: true,
        reason: `Editing ${displayTableName(table, engine)}. Changes write to the live database.`,
        tableDisplay: displayTableName(table, engine),
        table,
        engine,
        columns,
        pkIndexes
    };
}

export function buildUpdateSql(
    plan: ResultEditPlan,
    sourceColumn: string,
    newValue: string | null,
    row: string[]
): MutationSql | { error: string } {
    const tableSql = qualifiedTableSql(plan);
    if ('error' in tableSql) {
        return tableSql;
    }
    const where = buildPkWhere(plan, row);
    if ('error' in where) {
        return where;
    }
    const col = quoteIdent(sourceColumn, plan.engine);
    const sql = `UPDATE ${tableSql.sql} SET ${col} = :v WHERE ${where.sql}`;
    return { sql, params: { v: newValue, ...where.params } };
}

export function buildDeleteSql(plan: ResultEditPlan, row: string[]): MutationSql | { error: string } {
    const tableSql = qualifiedTableSql(plan);
    if ('error' in tableSql) {
        return tableSql;
    }
    const where = buildPkWhere(plan, row);
    if ('error' in where) {
        return where;
    }
    return {
        sql: `DELETE FROM ${tableSql.sql} WHERE ${where.sql}`,
        params: where.params
    };
}

export function buildInsertSql(plan: ResultEditPlan, row: string[]): MutationSql | { error: string } {
    const tableSql = qualifiedTableSql(plan);
    if ('error' in tableSql) {
        return tableSql;
    }
    const names: string[] = [];
    const placeholders: string[] = [];
    const params: Record<string, string | null> = {};
    let next = 0;
    for (let i = 0; i < plan.columns.length; i++) {
        const column = plan.columns[i];
        if (!column.sourceColumn || column.isIdentity || column.isComputed) {
            continue;
        }
        const raw = row[i];
        const value = raw === undefined || raw === NULL_DISPLAY ? null : raw;
        if (value === null && !column.isNullable) {
            return { error: `Column '${column.sourceColumn}' is NOT NULL, so this row cannot be copied.` };
        }
        const param = `i${next++}`;
        names.push(quoteIdent(column.sourceColumn, plan.engine));
        placeholders.push(`:${param}`);
        params[param] = value;
    }
    if (names.length === 0) {
        return { error: 'No columns can be inserted for a duplicate row.' };
    }
    return {
        sql: `INSERT INTO ${tableSql.sql} (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
        params
    };
}

export function canDuplicateRow(plan: ResultEditPlan): boolean {
    return (
        plan.editable &&
        plan.columns.some((column) => column.sourceColumn && !column.isIdentity && !column.isComputed)
    );
}

export function buildRenameSql(
    plan: ResultEditPlan,
    oldName: string,
    newName: string
): { sql: string } | { error: string } {
    if (!plan.table) {
        return { error: 'No table to rename a column on.' };
    }
    if (!isSafeIdent(newName)) {
        return {
            error: 'New column name must start with a letter or underscore, then only letters, digits, or underscores.'
        };
    }
    if (newName.toLowerCase() === oldName.toLowerCase()) {
        return { error: 'That is already the column name.' };
    }
    if (plan.table.columnsByLower.has(newName.toLowerCase())) {
        return { error: `Column '${newName}' already exists on this table.` };
    }

    const table = plan.table;
    const engine = plan.engine;
    if (engine === 'mysql') {
        const tableSql = `${quoteIdent(table.database, engine)}.${quoteIdent(table.name, engine)}`;
        const sql =
            `ALTER TABLE ${tableSql} RENAME COLUMN ${quoteIdent(oldName, engine)} ` +
            `TO ${quoteIdent(newName, engine)}`;
        return { sql };
    }

    const db = quoteIdent(table.database, engine);
    const objectName = `${table.schema}.${table.name}.${oldName}`.replace(/'/g, "''");
    const newEscaped = newName.replace(/'/g, "''");
    return {
        sql: `EXEC ${db}.sys.sp_rename N'${objectName}', N'${newEscaped}', N'COLUMN'`
    };
}

export function formatMutationPreview(sql: string, params: Record<string, string | null>): string {
    const keys = Object.keys(params);
    if (keys.length === 0) {
        return sql;
    }
    const lines = keys.map((key) => {
        const value = params[key];
        return `:${key} = ${value === null ? 'NULL' : value}`;
    });
    return `${sql}\n\n${lines.join('\n')}`;
}

export function isSafeIdent(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function displayTableName(table: TableInfo, engine: DbEngine): string {
    if (engine === 'mysql') {
        return `${table.database}.${table.name}`;
    }
    return table.qualifiedName;
}

function qualifiedTableSql(plan: ResultEditPlan): { sql: string } | { error: string } {
    if (!plan.table) {
        return { error: 'No table to write to.' };
    }
    const table = plan.table;
    const engine = plan.engine;
    if (engine === 'mysql') {
        return {
            sql: `${quoteIdent(table.database, engine)}.${quoteIdent(table.name, engine)}`
        };
    }
    return {
        sql:
            `${quoteIdent(table.database, engine)}.` +
            `${quoteIdent(table.schema, engine)}.` +
            `${quoteIdent(table.name, engine)}`
    };
}

function buildPkWhere(
    plan: ResultEditPlan,
    row: string[]
): MutationSql | { error: string } {
    if (plan.pkIndexes.length === 0) {
        return { error: 'Primary key columns are missing from the result.' };
    }
    const parts: string[] = [];
    const params: Record<string, string | null> = {};
    for (let i = 0; i < plan.pkIndexes.length; i++) {
        const index = plan.pkIndexes[i];
        const column = plan.columns[index];
        if (!column?.sourceColumn) {
            return { error: 'A primary key column is not mapped to the table.' };
        }
        const value = row[index];
        if (value === undefined || value === NULL_DISPLAY) {
            return { error: 'A primary key value is NULL, so this row cannot be updated.' };
        }
        const param = `pk${i}`;
        parts.push(`${quoteIdent(column.sourceColumn, plan.engine)} = :${param}`);
        params[param] = value;
    }
    return { sql: parts.join(' AND '), params };
}

function lockedColumn(displayName: string): ResultColumnEdit {
    return {
        displayName,
        sourceColumn: undefined,
        canEdit: false,
        canSetNull: false,
        canRename: false,
        isPrimaryKey: false,
        isIdentity: false,
        isComputed: false,
        isNullable: false,
        typeName: '',
        typeDisplay: ''
    };
}

function displayOnlyColumn(displayName: string, table?: TableInfo): ResultColumnEdit {
    if (!table) {
        return lockedColumn(displayName);
    }
    const info = table.columnsByLower.get(displayName.toLowerCase());
    if (!info) {
        return lockedColumn(displayName);
    }
    return {
        ...columnEditFromInfo(info, displayName),
        canEdit: false,
        canSetNull: false,
        canRename: false
    };
}

function toResultColumn(
    item: SelectItem,
    displayName: string,
    table: TableInfo
): ResultColumnEdit {
    if (item.kind !== 'column') {
        return lockedColumn(displayName);
    }
    const info = table.columnsByLower.get(item.column.toLowerCase());
    if (!info) {
        return lockedColumn(displayName);
    }
    return columnEditFromInfo(info, displayName);
}

function columnEditFromInfo(info: ColumnInfo, displayName: string): ResultColumnEdit {
    const canEdit = !info.isPrimaryKey && !info.isIdentity && !info.isComputed;
    return {
        displayName,
        sourceColumn: info.name,
        canEdit,
        canSetNull: canEdit && info.isNullable,
        canRename: true,
        isPrimaryKey: info.isPrimaryKey,
        isIdentity: info.isIdentity,
        isComputed: info.isComputed,
        isNullable: info.isNullable,
        typeName: info.typeName,
        typeDisplay: info.typeDisplay
    };
}

function expandSelectItems(
    items: SelectItem[],
    table: TableInfo,
    aliasLower: string,
    tableNameLower: string
): SelectItem[] | undefined {
    const out: SelectItem[] = [];
    for (const item of items) {
        if (item.kind !== 'star') {
            if (item.kind === 'column' && item.qualifier) {
                const q = item.qualifier.toLowerCase();
                if (q !== aliasLower && q !== tableNameLower) {
                    out.push({ kind: 'expression' });
                    continue;
                }
            }
            out.push(item);
            continue;
        }
        if (item.qualifier) {
            const q = item.qualifier.toLowerCase();
            if (q !== aliasLower && q !== tableNameLower) {
                return undefined;
            }
        }
        const ordered = [...table.columns].sort((a, b) => a.ordinal - b.ordinal);
        for (const column of ordered) {
            out.push({ kind: 'column', column: column.name });
        }
    }
    return out;
}

function inspectSelectShape(sql: string): { ok: true } | { ok: false; reason: string } {
    const tokens = tokenizeSql(sql);
    if (tokens.length === 0) {
        return { ok: false, reason: 'No SQL to edit from.' };
    }

    const first = tokens[0];
    if (first.kind !== 'keyword' || first.value.toLowerCase() !== 'select') {
        return { ok: false, reason: 'Only a simple SELECT from one table can be edited.' };
    }

    let depth = 0;
    let seenFrom = false;
    for (const tok of tokens) {
        if (tok.text === '(') {
            depth++;
            continue;
        }
        if (tok.text === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0) {
            continue;
        }

        const lower = tok.value.toLowerCase();
        if (tok.kind === 'keyword' && lower === 'distinct') {
            return { ok: false, reason: 'DISTINCT results cannot be edited.' };
        }
        if (tok.kind === 'keyword' && (lower === 'union' || lower === 'except' || lower === 'intersect')) {
            return { ok: false, reason: 'UNION / EXCEPT / INTERSECT results cannot be edited.' };
        }
        if (tok.kind === 'keyword' && lower === 'join') {
            return { ok: false, reason: 'Only a SELECT from one table can be edited (no JOIN).' };
        }
        if (tok.kind === 'keyword' && lower === 'apply') {
            return { ok: false, reason: 'APPLY queries cannot be edited.' };
        }
        if (tok.kind === 'keyword' && lower === 'into') {
            return { ok: false, reason: 'SELECT INTO cannot be edited.' };
        }
        if (tok.kind === 'keyword' && lower === 'group') {
            return { ok: false, reason: 'GROUP BY results cannot be edited.' };
        }
        if (tok.kind === 'keyword' && lower === 'for' && seenFrom) {
            return { ok: false, reason: 'This SELECT shape cannot be edited.' };
        }
        if (tok.kind === 'keyword' && lower === 'from') {
            seenFrom = true;
        }
    }

    if (!seenFrom) {
        return { ok: false, reason: 'Could not find a table in FROM.' };
    }
    if (hasCommaJoin(tokens)) {
        return { ok: false, reason: 'Only a SELECT from one table can be edited (no JOIN).' };
    }
    return { ok: true };
}

function hasCommaJoin(tokens: SqlToken[]): boolean {
    let depth = 0;
    let afterFrom = false;
    for (const tok of tokens) {
        if (tok.text === '(') {
            depth++;
            continue;
        }
        if (tok.text === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0) {
            continue;
        }
        const lower = tok.value.toLowerCase();
        if (tok.kind === 'keyword' && lower === 'from') {
            afterFrom = true;
            continue;
        }
        if (afterFrom && tok.kind === 'keyword' && FROM_END.has(lower)) {
            afterFrom = false;
            continue;
        }
        if (afterFrom && tok.text === ',') {
            return true;
        }
    }
    return false;
}

function collectSelectItems(sql: string): SelectItem[] {
    const tokens = tokenizeSql(sql);
    let i = 0;
    while (i < tokens.length) {
        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'select') {
            i++;
            break;
        }
        i++;
    }
    if (i >= tokens.length) {
        return [];
    }

    while (i < tokens.length) {
        const lower = tokens[i].value.toLowerCase();
        if (tokens[i].kind === 'keyword' && (lower === 'all' || lower === 'distinct')) {
            i++;
            continue;
        }
        if (tokens[i].kind === 'keyword' && lower === 'top') {
            i++;
            if (i < tokens.length && tokens[i].kind === 'number') {
                i++;
            }
            if (
                i < tokens.length &&
                tokens[i].kind === 'keyword' &&
                tokens[i].value.toLowerCase() === 'percent'
            ) {
                i++;
            }
            continue;
        }
        break;
    }

    const items: SelectItem[] = [];
    while (i < tokens.length) {
        if (isSelectItemEnd(tokens[i])) {
            break;
        }
        const start = i;
        let depth = 0;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (tok.text === '(') {
                depth++;
                i++;
                continue;
            }
            if (tok.text === ')') {
                depth = Math.max(0, depth - 1);
                i++;
                continue;
            }
            if (depth === 0 && tok.text === ',') {
                break;
            }
            if (depth === 0 && isSelectItemEnd(tok)) {
                break;
            }
            i++;
        }
        const slice = tokens.slice(start, i);
        if (slice.length > 0) {
            items.push(classifySelectItem(slice));
        }
        if (i < tokens.length && tokens[i].text === ',') {
            i++;
            continue;
        }
        break;
    }
    return items;
}

function isSelectItemEnd(tok: SqlToken): boolean {
    return tok.kind === 'keyword' && SELECT_ITEM_END.has(tok.value.toLowerCase());
}

function classifySelectItem(tokens: SqlToken[]): SelectItem {
    const expr = stripTrailingAlias(tokens);
    if (expr.length === 0) {
        return { kind: 'expression' };
    }
    if (expr.length === 1 && expr[0].text === '*') {
        return { kind: 'star' };
    }
    if (
        expr.length === 3 &&
        isNameToken(expr[0]) &&
        expr[1].text === '.' &&
        expr[2].text === '*'
    ) {
        return { kind: 'star', qualifier: expr[0].value };
    }
    if (isDottedName(expr)) {
        const names = expr.filter((tok) => isNameToken(tok)).map((tok) => tok.value);
        const column = names[names.length - 1];
        const qualifier = names.length >= 2 ? names[names.length - 2] : undefined;
        return { kind: 'column', column, qualifier };
    }
    return { kind: 'expression' };
}

function stripTrailingAlias(tokens: SqlToken[]): SqlToken[] {
    if (tokens.length < 2) {
        return tokens;
    }
    const last = tokens[tokens.length - 1];
    const prev = tokens[tokens.length - 2];
    if (isAliasToken(last) && prev.kind === 'keyword' && prev.value.toLowerCase() === 'as') {
        return tokens.slice(0, -2);
    }
    if (isAliasToken(last) && prev.text !== '.' && tokens.length >= 2) {
        return tokens.slice(0, -1);
    }
    return tokens;
}

function isAliasToken(tok: SqlToken): boolean {
    if (isSelectItemEnd(tok)) {
        return false;
    }
    return tok.kind === 'ident' || tok.kind === 'keyword';
}

function isNameToken(tok: SqlToken): boolean {
    return tok.kind === 'ident' || tok.kind === 'keyword';
}

function isDottedName(tokens: SqlToken[]): boolean {
    if (tokens.length === 0 || tokens.length % 2 === 0) {
        return false;
    }
    for (let i = 0; i < tokens.length; i++) {
        if (i % 2 === 0) {
            if (!isNameToken(tokens[i])) {
                return false;
            }
        } else if (tokens[i].text !== '.') {
            return false;
        }
    }
    return true;
}
