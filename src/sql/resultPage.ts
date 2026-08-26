import { SqlToken, tokenizeSql } from '../parser/sqlExtractor';
import { isMutatingSql } from './parameters';

type Engine = 'mssql' | 'mysql' | 'postgres';

export const DEFAULT_PAGE_SIZE = 1000;
export const PAGE_SIZE_CHOICES = [50, 100, 250, 500, 1000] as const;
export const MAX_PAGE_SIZE = 10000;

export type SortDirection = 'ASC' | 'DESC';

export interface ResultSort {
    columnIndex: number;
    direction: SortDirection;
}

export interface QueryPageOptions {
    offset?: number;
    limit?: number;
    sort?: ResultSort;
    /** When true, also fill `QueryResult.rawRows` with JSON-safe values (real nulls). */
    raw?: boolean;
    /** Stop the live query when aborted (Cancel on the progress toast). */
    signal?: AbortSignal;
}

const BODY_RESET = new Set([
    'select',
    'from',
    'where',
    'group',
    'having',
    'join',
    'union',
    'except',
    'intersect',
    'with',
    'into',
    'apply',
    'pivot',
    'unpivot'
]);

/**
 * True when this batch is a single SELECT/CTE we can wrap with ORDER BY / LIMIT.
 */
export function canPageSelect(sql: string): boolean {
    if (isMutatingSql(sql)) {
        return false;
    }
    const tokens = tokenizeSql(sql);
    if (tokens.length === 0) {
        return false;
    }
    const first = tokens.find((token) => token.kind === 'keyword' || token.kind === 'ident');
    if (!first || first.kind !== 'keyword') {
        return false;
    }
    const lead = first.value.toLowerCase();
    if (lead !== 'select' && lead !== 'with') {
        return false;
    }

    let depth = 0;
    let seenFrom = false;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.text === '(') {
            depth++;
            continue;
        }
        if (token.text === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0) {
            continue;
        }
        if (token.text === ';') {
            return !tokens.slice(i + 1).some((next) => next.kind === 'keyword' || next.kind === 'ident');
        }
        if (token.kind === 'keyword' && token.value.toLowerCase() === 'from') {
            seenFrom = true;
        }
        if (seenFrom && token.kind === 'keyword' && token.value.toLowerCase() === 'for') {
            return false;
        }
        if (token.kind === 'keyword' && token.value.toLowerCase() === 'option') {
            return false;
        }
    }
    return true;
}

export function clampPageSize(value: number, fallback = DEFAULT_PAGE_SIZE): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(value)));
}

export function clampOffset(value: number): number {
    if (!Number.isFinite(value) || value < 0) {
        return 0;
    }
    return Math.min(Math.floor(value), 1_000_000_000);
}

export function nextSort(current: ResultSort | undefined, columnIndex: number): ResultSort | undefined {
    if (!Number.isInteger(columnIndex) || columnIndex < 0) {
        return current;
    }
    if (!current || current.columnIndex !== columnIndex) {
        return { columnIndex, direction: 'ASC' };
    }
    if (current.direction === 'ASC') {
        return { columnIndex, direction: 'DESC' };
    }
    return undefined;
}

export function compareResultCells(
    a: string | undefined,
    b: string | undefined,
    direction: SortDirection,
    nullDisplay: string
): number {
    const aNull = a === undefined || a === nullDisplay;
    const bNull = b === undefined || b === nullDisplay;
    if (aNull && bNull) {
        return 0;
    }
    if (aNull) {
        return 1;
    }
    if (bNull) {
        return -1;
    }
    const left = a as string;
    const right = b as string;
    const numA = Number(left);
    const numB = Number(right);
    const bothNumeric =
        left.trim() !== '' &&
        right.trim() !== '' &&
        Number.isFinite(numA) &&
        Number.isFinite(numB);
    const cmp = bothNumeric
        ? numA - numB
        : left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'DESC' ? -cmp : cmp;
}

/**
 * Wrap a SELECT so the engine only returns one page, optionally sorted.
 * Outer ORDER BY uses 1-based column indexes from the result.
 */
export function buildPagedSelect(
    sql: string,
    engine: Engine,
    offset: number,
    fetchLimit: number,
    sort?: ResultSort
): string {
    const split = splitOuterPaging(sql);
    const inner = split.body.trim() || sql.trim();
    const pageOffset = clampOffset(offset);
    // Keep the query's own LIMIT/OFFSET. We used to drop them and apply only
    // the UI/MCP page size, so `LIMIT 10` returned the whole table whenever
    // that table was smaller than queryMaxRows / mcpMaxResultRows.
    const off = pageOffset + (split.offset ?? 0);
    const lim = pageFetchCount(fetchLimit, split.limit, pageOffset);
    const orderSql = buildOrderBy(engine, sort, split.orderBy);

    const usesLimit = engine === 'mysql' || engine === 'postgres';

    // Column-index sort must wrap so ORDER BY N matches the result shape.
    if (sort) {
        if (usesLimit) {
            return (
                `SELECT * FROM (\n${inner}\n) AS _spv_page\n` +
                `${orderSql}` +
                `LIMIT ${lim} OFFSET ${off}`
            );
        }
        const order = orderSql || 'ORDER BY (SELECT NULL)\n';
        return (
            `SELECT * FROM (\n${inner}\n) AS [_spv_page]\n` +
            `${order}` +
            `OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`
        );
    }

    // Append LIMIT/OFFSET so the engine can stop after N rows.
    // A derived-table wrap often scans the whole table first.
    if (usesLimit) {
        return `${inner}\n${orderSql}LIMIT ${lim} OFFSET ${off}`;
    }
    // SQL Server OFFSET FETCH needs ORDER BY. ORDER BY (SELECT NULL) often
    // sorts the whole table before returning the first page. TOP does not.
    if (off === 0) {
        const order = split.orderBy?.trim()
            ? `ORDER BY ${split.orderBy.trim()}\n`
            : '';
        return `SELECT TOP (${lim}) * FROM (\n${inner}\n) AS [_spv_page]\n${order}`.trimEnd();
    }
    const order = orderSql || 'ORDER BY (SELECT NULL)\n';
    return `${inner}\n${order}OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`;
}

function buildOrderBy(engine: Engine, sort: ResultSort | undefined, originalOrderBy?: string): string {
    if (sort && Number.isInteger(sort.columnIndex) && sort.columnIndex >= 0) {
        const dir = sort.direction === 'DESC' ? 'DESC' : 'ASC';
        return `ORDER BY ${sort.columnIndex + 1} ${dir}\n`;
    }
    if (originalOrderBy && originalOrderBy.trim()) {
        return `ORDER BY ${originalOrderBy.trim()}\n`;
    }
    return engine === 'mysql' || engine === 'postgres' ? '' : 'ORDER BY (SELECT NULL)\n';
}

export interface OuterPaging {
    body: string;
    orderBy?: string;
    limit?: number;
    offset?: number;
}

/**
 * Cut trailing ORDER BY / LIMIT / OFFSET / FETCH so the wrapper can apply its own.
 * Numeric LIMIT/OFFSET are kept so the page size cannot exceed what the SQL asked for.
 */
export function splitOuterPaging(sql: string): OuterPaging {
    const trimmed = sql.replace(/;+\s*$/, '');
    const tokens = tokenizeSql(trimmed);
    if (tokens.length === 0) {
        return { body: trimmed };
    }

    let depth = 0;
    let orderIndex = -1;
    let pagingIndex = -1;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.text === '(') {
            depth++;
            continue;
        }
        if (token.text === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0) {
            continue;
        }

        const lower = token.value.toLowerCase();
        if (token.kind === 'keyword' && BODY_RESET.has(lower)) {
            orderIndex = -1;
            pagingIndex = -1;
            continue;
        }
        if (token.kind === 'keyword' && lower === 'order' && isBy(tokens[i + 1])) {
            orderIndex = i;
            continue;
        }
        if (token.kind === 'keyword' && (lower === 'limit' || lower === 'offset' || lower === 'fetch')) {
            if (pagingIndex < 0) {
                pagingIndex = i;
            }
        }
    }

    const paging = pagingIndex >= 0 ? parsePagingClause(tokens, pagingIndex) : {};
    const cut = earliestPositive(orderIndex, pagingIndex);
    if (cut < 0) {
        return { body: trimmed };
    }

    const body = trimmed.slice(0, tokens[cut].start).trimEnd();
    if (orderIndex < 0) {
        return { body, ...paging };
    }

    const orderStart = skipOrderBy(tokens, orderIndex);
    const orderEnd = pagingIndex > orderIndex ? tokens[pagingIndex].start : trimmed.length;
    const orderBy = trimmed.slice(orderStart, orderEnd).trim();
    return { body, orderBy: orderBy || undefined, ...paging };
}

/** How many rows to ask the engine for, after the SQL's own LIMIT. */
export function pageFetchCount(
    fetchLimit: number,
    userLimit: number | undefined,
    pageOffset: number
): number {
    const capped = clampPageSize(fetchLimit);
    if (userLimit === undefined) {
        return capped;
    }
    const remaining = userLimit - clampOffset(pageOffset);
    if (remaining <= 0) {
        return 0;
    }
    return Math.min(capped, remaining);
}

function parsePagingClause(
    tokens: SqlToken[],
    start: number
): { limit?: number; offset?: number } {
    let limit: number | undefined;
    let offset: number | undefined;
    let i = start;
    while (i < tokens.length) {
        const lower = tokens[i].value.toLowerCase();
        if (tokens[i].kind === 'keyword' && lower === 'limit') {
            const first = readUnsignedIntAt(tokens, i + 1);
            if (!first) {
                i += 1;
                continue;
            }
            i = first.next;
            if (tokens[i]?.text === ',') {
                const second = readUnsignedIntAt(tokens, i + 1);
                if (second) {
                    offset = first.value;
                    limit = second.value;
                    i = second.next;
                    continue;
                }
            }
            limit = first.value;
            continue;
        }
        if (tokens[i].kind === 'keyword' && lower === 'offset') {
            const value = readUnsignedIntAt(tokens, i + 1);
            if (!value) {
                i += 1;
                continue;
            }
            offset = value.value;
            i = value.next;
            if (isWord(tokens[i], 'row') || isWord(tokens[i], 'rows')) {
                i += 1;
            }
            continue;
        }
        if (tokens[i].kind === 'keyword' && lower === 'fetch') {
            i += 1;
            if (isWord(tokens[i], 'first') || isWord(tokens[i], 'next')) {
                i += 1;
            }
            const value = readUnsignedIntAt(tokens, i);
            if (value) {
                limit = value.value;
                i = value.next;
            }
            continue;
        }
        i += 1;
    }
    return { limit, offset };
}

function readUnsignedIntAt(
    tokens: SqlToken[],
    index: number
): { value: number; next: number } | undefined {
    let i = index;
    const wrapped = tokens[i]?.text === '(';
    if (wrapped) {
        i += 1;
    }
    const token = tokens[i];
    if (!token || token.kind !== 'number') {
        return undefined;
    }
    const n = Number(token.value);
    if (!Number.isFinite(n) || n < 0) {
        return undefined;
    }
    i += 1;
    if (wrapped) {
        if (tokens[i]?.text !== ')') {
            return undefined;
        }
        i += 1;
    }
    return { value: Math.floor(n), next: i };
}

function isWord(token: SqlToken | undefined, word: string): boolean {
    return !!token && token.value.toLowerCase() === word;
}

function isBy(token: SqlToken | undefined): boolean {
    return !!token && token.kind === 'keyword' && token.value.toLowerCase() === 'by';
}

function skipOrderBy(tokens: SqlToken[], orderIndex: number): number {
    const by = tokens[orderIndex + 1];
    if (by && isBy(by)) {
        return by.end;
    }
    return tokens[orderIndex].end;
}

function earliestPositive(a: number, b: number): number {
    if (a < 0) {
        return b;
    }
    if (b < 0) {
        return a;
    }
    return Math.min(a, b);
}
