import { tokenizeSql } from '../parser/sqlExtractor';

export interface NamedBind {
    name: string;
    start: number;
    end: number;
}

const MUTATING_KEYWORDS = new Set([
    'insert',
    'update',
    'delete',
    'merge',
    'drop',
    'alter',
    'truncate',
    'create',
    'exec',
    'execute',
    'grant',
    'revoke',
    'call',
    'replace',
    'load',
    'into'
]);

/**
 * `:name` binds outside strings and comments. Skips `::`.
 */
export function findNamedBinds(sql: string): NamedBind[] {
    const tokens = tokenizeSql(sql);
    const binds: NamedBind[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.text !== ':') {
            continue;
        }
        const prev = i > 0 ? tokens[i - 1] : undefined;
        if (prev && prev.text === ':' && prev.end === token.start) {
            continue;
        }
        const next = tokens[i + 1];
        // `:path` is a keyword in our tokenizer; bind names may still be keywords.
        if (
            !next ||
            (next.kind !== 'ident' && next.kind !== 'keyword') ||
            next.start !== token.end
        ) {
            continue;
        }
        binds.push({
            name: next.value,
            start: token.start,
            end: next.end
        });
    }
    return binds;
}

/**
 * Unique bind names in first-appearance order. Matching is case-insensitive.
 */
export function uniqueBindNames(sql: string): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const bind of findNamedBinds(sql)) {
        const key = bind.name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(bind.name);
    }
    return names;
}

/**
 * Python f-string `{ident}` leftovers. Not ODBC `{d '...'}` / `{ts '...'}`.
 */
export function findFStringInterpolations(sql: string): string[] {
    const tokens = tokenizeSql(sql);
    const found: string[] = [];
    for (let i = 0; i + 2 < tokens.length; i++) {
        if (tokens[i].text !== '{') {
            continue;
        }
        const inner = tokens[i + 1];
        if (inner.kind !== 'ident' && inner.kind !== 'keyword') {
            continue;
        }
        if (tokens[i + 2].text !== '}') {
            continue;
        }
        found.push(sql.slice(tokens[i].start, tokens[i + 2].end));
    }
    return found;
}

export type BindStyle = 'at' | 'qmark' | 'dollar';

/**
 * Rewrites `:name` binds. Values are never pasted into the SQL text.
 * `at` → `@name` (SQL Server). `qmark` → `?` (MySQL). `dollar` → `$1`, `$2` (PostgreSQL).
 */
export function rewriteNamedBinds(
    sql: string,
    style: BindStyle
): { sql: string; namesInOrder: string[] } {
    const binds = findNamedBinds(sql);
    const namesInOrder = binds.map((bind) => bind.name);
    if (binds.length === 0) {
        return { sql, namesInOrder };
    }
    let out = '';
    let last = 0;
    let dollarIndex = 0;
    for (const bind of binds) {
        out += sql.slice(last, bind.start);
        if (style === 'at') {
            out += `@${bind.name}`;
        } else if (style === 'dollar') {
            dollarIndex += 1;
            out += `$${dollarIndex}`;
        } else {
            out += '?';
        }
        last = bind.end;
    }
    out += sql.slice(last);
    return { sql: out, namesInOrder };
}

export function lookupParam(
    params: Record<string, string | null>,
    name: string
): string | null {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
        return params[name];
    }
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(params)) {
        if (key.toLowerCase() === lower) {
            return value;
        }
    }
    return null;
}

/**
 * True when the batch looks like it can change data or schema.
 * `SELECT … FOR UPDATE` also counts (it takes locks).
 */
export function isMutatingSql(sql: string): boolean {
    const tokens = tokenizeSql(sql);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind !== 'keyword') {
            continue;
        }
        const lower = token.value.toLowerCase();
        if (MUTATING_KEYWORDS.has(lower)) {
            return true;
        }
    }
    return false;
}
