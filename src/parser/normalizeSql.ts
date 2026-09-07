import { skipFStringExpression } from './fString';

export const PLACEHOLDER_NULL = 'NULL';

export interface NormalizeSegment {
    text: string;
    docOffset: number | null;
}

export type SqlQuote = "'" | '"' | '`';

/**
 * Keywords that expect a following value. An f-string `{expr}` after these
 * is a bind (use NULL). After a finished expression it is a clause fragment
 * (drop it — `) NULL` is a syntax error).
 */
const VALUE_EXPECTING_KEYWORDS = new Set([
    'and',
    'or',
    'not',
    'where',
    'having',
    'when',
    'then',
    'else',
    'select',
    'set',
    'values',
    'limit',
    'offset',
    'top',
    'like',
    'in',
    'between',
    'as',
    'by',
    'on',
    'using',
    'case',
    'if',
    'return',
    'cast',
    'convert',
    'distinct',
    'all',
    'interval',
    'from',
    'join',
    'into',
    'update',
    'table',
    'with',
    'is',
    'exists',
    'over',
    'partition',
    'rows',
    'range',
    'fetch',
    'next',
    'union',
    'except',
    'intersect',
    'insert',
    'delete',
    'merge',
    'call',
    'exec',
    'execute',
    'to'
]);

export function isIdentStart(ch: string): boolean {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

export function isIdentPart(ch: string): boolean {
    return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/**
 * Last real SQL token. Comments and space do not count — `-- sql` must
 * not make the next `{helper()}` look like a finished expression.
 */
export function lastSqlToken(sql: string): string | null {
    let last: string | null = null;
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            i++;
            continue;
        }
        if (ch === '-' && sql[i + 1] === '-') {
            i += 2;
            while (i < sql.length && sql[i] !== '\n') {
                i++;
            }
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
                i++;
            }
            i = Math.min(i + 2, sql.length);
            continue;
        }

        if (ch === "'" || ch === '"' || ch === '`') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === ch && sql[j + 1] === ch) {
                    j += 2;
                    continue;
                }
                if (sql[j] === ch) {
                    j++;
                    break;
                }
                j++;
            }
            last = sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === '[') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === ']' && sql[j + 1] === ']') {
                    j += 2;
                    continue;
                }
                if (sql[j] === ']') {
                    j++;
                    break;
                }
                j++;
            }
            last = sql.slice(i, j);
            i = j;
            continue;
        }
        if (isIdentPart(ch) || ch === '$' || ch === '#' || ch === '@') {
            let j = i + 1;
            while (j < sql.length && (isIdentPart(sql[j]) || sql[j] === '$' || sql[j] === '#' || sql[j] === '@')) {
                j++;
            }
            last = sql.slice(i, j);
            i = j;
            continue;
        }
        const two = sql.slice(i, i + 2);
        if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '==') {
            last = two;
            i += 2;
            continue;
        }
        last = ch;
        i++;
    }
    return last;
}

const STATEMENT_START_TOKENS = new Set([
    'select',
    'with',
    'insert',
    'update',
    'delete',
    'merge',
    'create',
    'alter',
    'drop',
    'truncate',
    'exec',
    'execute'
]);

/**
 * `{_base_query()}` before SELECT / WITH is a SQL preamble, not a value.
 * Only when nothing real came before it (comments do not count).
 */
export function isLeadingSqlPreamble(precedingSql: string, remaining: string): boolean {
    if (lastSqlToken(precedingSql)) {
        return false;
    }
    const next = nextSqlToken(remaining);
    return next !== null && STATEMENT_START_TOKENS.has(next.token.toLowerCase());
}

const LEADING_TRIVIA = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/;

/**
 * True when the original string starts with `{helper()}` and the next SQL
 * is a new statement — the same case normalize drops as a preamble.
 * `{cols} FROM t` is a value, not a preamble.
 */
export function hasDroppedLeadingInterpolation(originalText: string): boolean {
    const stripped = originalText.replace(LEADING_TRIVIA, '');
    if (!stripped.startsWith('{')) {
        return false;
    }
    const exprEnd = skipFStringExpression(stripped, 0);
    return isLeadingSqlPreamble('', stripped.slice(exprEnd));
}

/**
 * True when the next f-string `{expr}` sits after a finished expression
 * (`DATE_SUB(...) {filters}`), so it is a SQL fragment, not a value.
 */
export function isFragmentPosition(precedingSql: string): boolean {
    const token = lastSqlToken(precedingSql);
    if (!token) {
        return false;
    }
    if (token === ')' || token === ']') {
        return true;
    }
    const start = token[0];
    if (start === "'" || start === '"' || start === '`' || start === '[') {
        return true;
    }
    if (start >= '0' && start <= '9') {
        return true;
    }
    if (isIdentStart(start) || start === '@' || start === '#') {
        return !VALUE_EXPECTING_KEYWORDS.has(token.toLowerCase());
    }
    return false;
}

function skipSqlSpace(sql: string, start: number): number {
    let i = start;
    while (i < sql.length && (sql[i] === ' ' || sql[i] === '\t' || sql[i] === '\n' || sql[i] === '\r')) {
        i++;
    }
    return i;
}

/**
 * First non-space SQL token. Used only to decide NULL vs drop.
 */
function nextSqlToken(sql: string): { token: string; end: number } | null {
    const i = skipSqlSpace(sql, 0);
    if (i >= sql.length) {
        return null;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
        return { token: ch, end: i + 1 };
    }
    if (isIdentPart(ch) || ch === '$' || ch === '#' || ch === '@') {
        let j = i + 1;
        while (j < sql.length && (isIdentPart(sql[j]) || sql[j] === '$' || sql[j] === '#' || sql[j] === '@')) {
            j++;
        }
        return { token: sql.slice(i, j), end: j };
    }
    return { token: ch, end: i + 1 };
}

const TABLE_NAME_PREV_TOKENS = new Set(['from', 'join', 'into', 'update', 'table']);

/**
 * `{expr}` after FROM / JOIN / INTO / UPDATE / TABLE (or a qualifier `.`)
 * is a table name. The `(` that follows is a column list
 * (`INSERT INTO {t} (id)`), not `SUM(...)`.
 */
function isTableNamePosition(precedingSql: string): boolean {
    const token = lastSqlToken(precedingSql);
    if (!token) {
        return false;
    }
    if (token === '.') {
        return true;
    }
    return TABLE_NAME_PREV_TOKENS.has(token.toLowerCase());
}

/**
 * True when `{expr}` sits in front of another expression with no comma
 * (`SELECT {optional_cols} SUM(...)`). NULL there is `SELECT NULL SUM(...)`.
 *
 * ponytail: peeks `ident(` / `(` / `{` / literals only. `SELECT {cols} CASE WHEN`
 * still inserts NULL. Upgrade: a small SELECT-list parser.
 */
function isAdjacentExpression(remaining: string): boolean {
    const scanned = nextSqlToken(remaining);
    if (!scanned) {
        return false;
    }
    const { token, end } = scanned;
    if (token === '(' || token === '{') {
        return true;
    }
    const start = token[0];
    if (start === "'" || start === '"' || start === '`' || start === '[') {
        return true;
    }
    if (start >= '0' && start <= '9') {
        return true;
    }
    if (isIdentStart(start) || start === '@' || start === '#') {
        return remaining[skipSqlSpace(remaining, end)] === '(';
    }
    return false;
}

/**
 * If `sql` ends inside a quoted literal, return that quote and its open index.
 */
export function unclosedSqlString(sql: string): { quote: SqlQuote; openAt: number } | null {
    let quote: SqlQuote | null = null;
    let openAt = -1;
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (quote) {
            if (ch === quote) {
                if (sql[i + 1] === quote) {
                    i += 2;
                    continue;
                }
                quote = null;
                openAt = -1;
                i += 1;
                continue;
            }
            i += 1;
            continue;
        }
        if (ch === '-' && sql[i + 1] === '-') {
            i += 2;
            while (i < sql.length && sql[i] !== '\n') {
                i += 1;
            }
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
                i += 1;
            }
            i = Math.min(i + 2, sql.length);
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            openAt = i;
            i += 1;
            continue;
        }
        i += 1;
    }
    return quote === null ? null : { quote, openAt };
}

function skipSqlStringSuffix(content: string, start: number, quote: SqlQuote, isFString: boolean): number {
    let i = start;
    while (i < content.length) {
        if (isFString && content[i] === '{') {
            if (content[i + 1] === '{') {
                i += 2;
                continue;
            }
            i = skipFStringExpression(content, i);
            continue;
        }
        if (content[i] === quote) {
            if (content[i + 1] === quote) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    return i;
}

function trimSegmentsTo(segments: NormalizeSegment[], keep: number): void {
    let held = 0;
    const next: NormalizeSegment[] = [];
    for (const segment of segments) {
        if (held >= keep) {
            break;
        }
        if (held + segment.text.length <= keep) {
            next.push(segment);
            held += segment.text.length;
            continue;
        }
        const take = keep - held;
        if (take > 0) {
            next.push({
                text: segment.text.slice(0, take),
                docOffset: segment.docOffset
            });
        }
        break;
    }
    segments.length = 0;
    segments.push(...next);
}

/**
 * Replaces f-string interpolations and common parameter placeholders with NULL,
 * recording synthetic pieces so ranges never drift.
 *
 * F-string `{expr}` after a finished expression is a clause fragment
 * (`{access_filters}`), not a value — drop it. `) NULL` is invalid SQL.
 * Same drop when `{expr}` sits in front of another expression
 * (`SELECT {optional_cols} SUM(...)` → `SELECT NULL SUM(...)`).
 *
 * A quoted interpolation (`'{last_read_tstamp}'`) is a value. Replace the
 * whole quoted literal with NULL. Leaving `''` makes MySQL reject DATETIME
 * comparisons (`Incorrect DATETIME value: ''`). Real empty strings in the
 * source (`ifnull(npi, '')`) stay as they are.
 */
export function normalizeContent(
    content: string,
    contentStart: number,
    isFString: boolean,
    precedingSql = ''
): NormalizeSegment[] {
    const segments: NormalizeSegment[] = [];
    let i = 0;

    const sqlSoFar = (): string => precedingSql + segments.map((segment) => segment.text).join('');

    const pushReal = (from: number, to: number): void => {
        if (to > from) {
            segments.push({
                text: content.slice(from, to),
                docOffset: contentStart + from
            });
        }
    };

    const pushSynthetic = (text: string): void => {
        if (text.length === 0) {
            return;
        }
        segments.push({ text, docOffset: null });
    };

    while (i < content.length) {
        // F-string `{expr}` (but not `{{`).
        if (isFString && content[i] === '{') {
            if (content[i + 1] === '{') {
                pushReal(i, i + 2);
                i += 2;
                continue;
            }
            const inside = unclosedSqlString(sqlSoFar());
            if (inside) {
                const localOpen = inside.openAt - precedingSql.length;
                if (localOpen >= 0) {
                    trimSegmentsTo(segments, localOpen);
                    i = skipSqlStringSuffix(
                        content,
                        skipFStringExpression(content, i),
                        inside.quote,
                        isFString
                    );
                    pushSynthetic(PLACEHOLDER_NULL);
                    continue;
                }
                // Opening quote came from a previous concatenated literal.
                // Keep the string closed and valid: insert a dummy, then the
                // remaining close quote is copied as real text.
                i = skipFStringExpression(content, i);
                pushSynthetic('2000-01-01');
                continue;
            }
            const exprEnd = skipFStringExpression(content, i);
            const preceding = sqlSoFar();
            const remaining = content.slice(exprEnd);
            pushSynthetic(
                isLeadingSqlPreamble(preceding, remaining) ||
                    isFragmentPosition(preceding) ||
                    (!isTableNamePosition(preceding) && isAdjacentExpression(remaining))
                    ? ''
                    : PLACEHOLDER_NULL
            );
            i = exprEnd;
            continue;
        }

        // `%(name)s` style.
        if (content[i] === '%' && content[i + 1] === '(') {
            const close = content.indexOf(')s', i + 2);
            if (close !== -1) {
                pushSynthetic(PLACEHOLDER_NULL);
                i = close + 2;
                continue;
            }
        }

        // `%s`, `%d`, `%f`, …
        if (content[i] === '%' && i + 1 < content.length && /[sdfi]/.test(content[i + 1])) {
            pushSynthetic(PLACEHOLDER_NULL);
            i += 2;
            continue;
        }

        // `:name` (named pyodbc / SQLAlchemy binds), but not `::`.
        if (
            content[i] === ':' &&
            content[i + 1] !== ':' &&
            i + 1 < content.length &&
            isIdentStart(content[i + 1])
        ) {
            let j = i + 1;
            while (j < content.length && isIdentPart(content[j])) {
                j++;
            }
            pushSynthetic(PLACEHOLDER_NULL);
            i = j;
            continue;
        }

        // Lone `?` positional placeholder.
        if (content[i] === '?') {
            pushSynthetic(PLACEHOLDER_NULL);
            i++;
            continue;
        }

        // Regular character — accumulate until the next special.
        let j = i + 1;
        while (j < content.length) {
            const c = content[j];
            if (
                (isFString && c === '{') ||
                c === '%' ||
                c === ':' ||
                c === '?'
            ) {
                break;
            }
            j++;
        }
        pushReal(i, j);
        i = j;
    }

    return segments;
}

/** Analysis SQL after placeholder rewrite. Used by tests and dry-run. */
export function normalizeEmbeddedSql(content: string, isFString = true, precedingSql = ''): string {
    return normalizeContent(content, 0, isFString, precedingSql)
        .map((segment) => segment.text)
        .join('');
}
