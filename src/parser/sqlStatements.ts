import { SqlToken, tokenizeSql } from './sqlTokens';

export interface SqlStatementSlice {
    start: number;
    end: number;
    text: string;
}

/**
 * Split a `.sql` file into statements on `;` and `GO`.
 * Comments and strings are ignored because tokenizeSql already skipped them.
 */
export function splitSqlStatements(sql: string): SqlStatementSlice[] {
    const tokens = tokenizeSql(sql);
    const slices: SqlStatementSlice[] = [];
    let sliceStart = 0;

    const flush = (sliceEnd: number, nextStart: number): void => {
        if (hasSqlContent(sql.slice(sliceStart, sliceEnd))) {
            slices.push({
                start: sliceStart,
                end: sliceEnd,
                text: sql.slice(sliceStart, sliceEnd)
            });
        }
        sliceStart = nextStart;
    };

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.kind === 'punct' && tok.text === ';') {
            // Keep space/newlines after `;` on this statement. End-of-line on
            // `select …;` is that newline — it must not start the next query.
            const next = skipSqlWhitespace(sql, tok.end);
            flush(next, next);
            continue;
        }
        if (isGoBatchSeparator(tokens, i, sliceStart)) {
            flush(tok.start, tok.end);
        }
    }
    flush(sql.length, sql.length);
    return slices;
}

const MYSQL_EXPLAINABLE = new Set([
    'select',
    'insert',
    'update',
    'delete',
    'replace',
    'with',
    'table',
    'values'
]);

const POSTGRES_EXPLAINABLE = new Set([
    'select',
    'insert',
    'update',
    'delete',
    'merge',
    'values',
    'with',
    'table',
    'execute',
    'declare'
]);

const SESSION_EXPLAIN_SKIP = new Set(['use', 'set', 'start', 'begin', 'commit', 'rollback']);

/** First keyword or identifier, skipping comments and strings. */
export function firstSqlKeyword(sql: string): string | null {
    for (const tok of tokenizeSql(sql)) {
        if (tok.kind === 'keyword' || tok.kind === 'ident') {
            return tok.value.toLowerCase();
        }
    }
    return null;
}

/**
 * MySQL and PostgreSQL dry-run wrap the query in EXPLAIN.
 * That only works for DML/SELECT — CREATE TABLE LIKE is valid SQL but
 * `EXPLAIN CREATE TABLE` is a syntax error.
 */
export function isExplainableStatement(sql: string, engine: string): boolean {
    const keyword = firstSqlKeyword(sql);
    if (!keyword) {
        return false;
    }
    if (engine === 'postgres') {
        return POSTGRES_EXPLAINABLE.has(keyword);
    }
    return MYSQL_EXPLAINABLE.has(keyword);
}

export function explainDryRunSkipReason(sql: string): string {
    const keyword = firstSqlKeyword(sql);
    if (keyword && SESSION_EXPLAIN_SKIP.has(keyword)) {
        return 'Session/transaction statements are not dry-run with EXPLAIN.';
    }
    return 'This statement cannot be dry-run with EXPLAIN.';
}

/**
 * Which statements to send to EXPLAIN. DDL and session commands are skipped
 * instead of being wrapped, which would look like a syntax error at CREATE.
 */
export function statementsForExplainDryRun(
    sql: string,
    engine: string
):
    | { kind: 'empty' }
    | { kind: 'skipped'; reason: string }
    | { kind: 'run'; statements: SqlStatementSlice[] } {
    const slices = splitSqlStatements(sql);
    if (slices.length === 0) {
        return { kind: 'empty' };
    }
    const statements = slices.filter((slice) => isExplainableStatement(slice.text, engine));
    if (statements.length === 0) {
        return { kind: 'skipped', reason: explainDryRunSkipReason(sql) };
    }
    return { kind: 'run', statements };
}

export function statementAtOffset(sql: string, offset: number): SqlStatementSlice | undefined {
    const slices = splitSqlStatements(sql);
    if (slices.length === 0) {
        return undefined;
    }
    const clamped = Math.max(0, Math.min(offset, sql.length));
    for (const slice of slices) {
        if (clamped >= slice.start && clamped < slice.end) {
            return slice;
        }
        if (clamped === slice.end && clamped === sql.length) {
            return slice;
        }
    }
    let previous: SqlStatementSlice | undefined;
    for (const slice of slices) {
        if (slice.end <= clamped) {
            previous = slice;
        }
        if (slice.start > clamped) {
            return previous ?? slice;
        }
    }
    return previous ?? slices[slices.length - 1];
}

function hasSqlContent(text: string): boolean {
    return tokenizeSql(text).some((tok) => tok.kind !== 'punct' || tok.text !== ';');
}

function skipSqlWhitespace(sql: string, from: number): number {
    let i = from;
    while (i < sql.length && (sql[i] === ' ' || sql[i] === '\t' || sql[i] === '\r' || sql[i] === '\n')) {
        i++;
    }
    return i;
}

/** `GO` starts a new batch only when it is the first token of the current slice. */
function isGoBatchSeparator(tokens: SqlToken[], index: number, sliceStart: number): boolean {
    const tok = tokens[index];
    if (tok.value.toLowerCase() !== 'go') {
        return false;
    }
    if (tok.kind !== 'ident' && tok.kind !== 'keyword') {
        return false;
    }
    for (let i = index - 1; i >= 0; i--) {
        if (tokens[i].start < sliceStart) {
            break;
        }
        return false;
    }
    return true;
}

