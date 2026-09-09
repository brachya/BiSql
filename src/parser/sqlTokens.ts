import { unquoteIdentifier } from '../sql/identifiers';
import { isIdentPart, isIdentStart } from './normalizeSql';

export type SqlTokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'punct' | 'other';

export interface SqlToken {
    kind: SqlTokenKind;
    text: string;
    /** Unquoted identifier text when kind === 'ident'. */
    value: string;
    start: number;
    end: number;
}

export const SQL_KEYWORDS = new Set(
    [
        'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'outer',
        'cross', 'on', 'as', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between',
        'exists', 'case', 'when', 'then', 'else', 'end', 'group', 'by', 'order', 'having',
        'limit', 'offset', 'top', 'distinct', 'all', 'union', 'except', 'intersect',
        'insert', 'into', 'values', 'update', 'set', 'delete', 'merge', 'using',
        'with', 'table', 'view', 'create', 'alter', 'drop', 'truncate', 'exec', 'execute',
        'declare', 'begin', 'commit', 'rollback', 'transaction', 'if', 'else', 'while',
        'return', 'cast', 'convert', 'over', 'partition', 'rows', 'range', 'unbounded',
        'preceding', 'following', 'current', 'row', 'fetch', 'next', 'only', 'pivot',
        'unpivot', 'cross', 'apply', 'outer', 'for', 'xml', 'json', 'path',
        'asc', 'desc', 'true', 'false', 'unknown',
        'duplicate', 'key', 'interval'
    ]
);

export function tokenizeSql(sql: string): SqlToken[] {
    const tokens: SqlToken[] = [];
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];

        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            i++;
            continue;
        }

        // Line comment.
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') {
                i++;
            }
            continue;
        }

        // Block comment.
        if (ch === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
                i++;
            }
            i = Math.min(i + 2, sql.length);
            continue;
        }

        // Bracket-quoted identifier.
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
            const raw = sql.slice(i, j);
            const value = unquoteIdentifier(raw);
            tokens.push({ kind: 'ident', text: raw, value, start: i, end: j });
            i = j;
            continue;
        }

        // MySQL backtick-quoted identifier.
        if (ch === '`') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === '`' && sql[j + 1] === '`') {
                    j += 2;
                    continue;
                }
                if (sql[j] === '`') {
                    j++;
                    break;
                }
                j++;
            }
            const raw = sql.slice(i, j);
            const value = unquoteIdentifier(raw);
            tokens.push({ kind: 'ident', text: raw, value, start: i, end: j });
            i = j;
            continue;
        }

        // Double-quoted identifier.
        if (ch === '"') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === '"' && sql[j + 1] === '"') {
                    j += 2;
                    continue;
                }
                if (sql[j] === '"') {
                    j++;
                    break;
                }
                j++;
            }
            const raw = sql.slice(i, j);
            const value = unquoteIdentifier(raw);
            tokens.push({ kind: 'ident', text: raw, value, start: i, end: j });
            i = j;
            continue;
        }

        // String literal.
        if (ch === "'") {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === "'" && sql[j + 1] === "'") {
                    j += 2;
                    continue;
                }
                if (sql[j] === "'") {
                    j++;
                    break;
                }
                j++;
            }
            tokens.push({
                kind: 'string',
                text: sql.slice(i, j),
                value: sql.slice(i, j),
                start: i,
                end: j
            });
            i = j;
            continue;
        }

        // Number. Do not swallow the `.` in `123.ds` (qualifier), but keep `1.`.
        if ((ch >= '0' && ch <= '9') || (ch === '.' && sql[i + 1] >= '0' && sql[i + 1] <= '9')) {
            let j = i + 1;
            while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') {
                j++;
            }
            if (sql[j] === '.') {
                const after = sql[j + 1];
                if (after >= '0' && after <= '9') {
                    j++;
                    while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') {
                        j++;
                    }
                } else if (!after || !isIdentStart(after)) {
                    j++;
                }
            }
            tokens.push({
                kind: 'number',
                text: sql.slice(i, j),
                value: sql.slice(i, j),
                start: i,
                end: j
            });
            i = j;
            continue;
        }

        // Identifier / keyword.
        if (isIdentStart(ch) || ch === '@' || ch === '#') {
            let j = i + 1;
            while (j < sql.length && (isIdentPart(sql[j]) || sql[j] === '$' || sql[j] === '#')) {
                j++;
            }
            const raw = sql.slice(i, j);
            const lower = raw.toLowerCase();
            const kind: SqlTokenKind = SQL_KEYWORDS.has(lower) ? 'keyword' : 'ident';
            tokens.push({ kind, text: raw, value: raw, start: i, end: j });
            i = j;
            continue;
        }

        tokens.push({
            kind: 'punct',
            text: ch,
            value: ch,
            start: i,
            end: i + 1
        });
        i++;
    }
    return tokens;
}
