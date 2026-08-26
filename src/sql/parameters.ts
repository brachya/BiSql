import { isIdentPart, isIdentStart } from '../parser/normalizeSql';
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
    return uniqueNames(findNamedBinds(sql));
}

export interface NamedPlaceholder {
    name: string;
    start: number;
    end: number;
}

export type ParamFieldKind = 'placeholder' | 'bind';

export interface ParamField {
    name: string;
    kind: ParamFieldKind;
}

/**
 * ODBC date/time/function wrappers. `{d '…'}` is SQL, not a `{name}` placeholder.
 * `{call}` with no args is also ODBC, so that name is never treated as a fill-in.
 */
const ODBC_PLACEHOLDER_NAMES = new Set(['d', 't', 'ts', 'fn', 'oj', 'call', 'escape', 'guid']);

function isOdbcPlaceholderName(name: string): boolean {
    return ODBC_PLACEHOLDER_NAMES.has(name.toLowerCase());
}

/**
 * `{name}` placeholders in the SQL text, including inside `'…'` strings.
 * Skips comments, `{{` doubled braces, and ODBC `{d '…'}` / `{fn …}`.
 */
export function findPlaceholders(sql: string): NamedPlaceholder[] {
    const tokens = tokenizeSql(sql);
    const found: NamedPlaceholder[] = [];
    for (const token of tokens) {
        if (token.kind === 'string') {
            collectPlaceholdersInString(token.text, token.start, found);
        }
    }
    for (let i = 0; i + 2 < tokens.length; i++) {
        const open = tokens[i];
        if (open.text !== '{') {
            continue;
        }
        const prev = i > 0 ? tokens[i - 1] : undefined;
        if (prev && prev.text === '{' && prev.end === open.start) {
            continue;
        }
        const inner = tokens[i + 1];
        const close = tokens[i + 2];
        if (
            (inner.kind !== 'ident' && inner.kind !== 'keyword') ||
            inner.start !== open.end ||
            close.text !== '}' ||
            close.start !== inner.end
        ) {
            continue;
        }
        if (isOdbcPlaceholderName(inner.value)) {
            continue;
        }
        found.push({
            name: inner.value,
            start: open.start,
            end: close.end
        });
    }
    found.sort((left, right) => left.start - right.start);
    return found;
}

/**
 * Unique `{name}` placeholders in first-appearance order. Matching is case-insensitive.
 */
export function uniquePlaceholderNames(sql: string): string[] {
    return uniqueNames(findPlaceholders(sql));
}

/**
 * Labels for the results-tab param list. `{name}` first, then `:name`.
 * A name that appears in both is shown once as a placeholder.
 */
export function paramFieldsForSql(sql: string): ParamField[] {
    const fields: ParamField[] = [];
    const seen = new Set<string>();
    for (const name of uniquePlaceholderNames(sql)) {
        seen.add(name.toLowerCase());
        fields.push({ name, kind: 'placeholder' });
    }
    for (const name of uniqueBindNames(sql)) {
        if (seen.has(name.toLowerCase())) {
            continue;
        }
        fields.push({ name, kind: 'bind' });
    }
    return fields;
}

/**
 * Pastes values over `{name}`. A key in `params` (including null) is replaced;
 * a missing key is left as `{name}` so unfilled SQL stays visible.
 */
export function applyPlaceholders(
    sql: string,
    params: Record<string, string | null>
): string {
    const placeholders = findPlaceholders(sql);
    if (placeholders.length === 0) {
        return sql;
    }
    let out = '';
    let last = 0;
    for (const placeholder of placeholders) {
        out += sql.slice(last, placeholder.start);
        if (hasParam(params, placeholder.name)) {
            out += lookupParam(params, placeholder.name) ?? '';
        } else {
            out += sql.slice(placeholder.start, placeholder.end);
        }
        last = placeholder.end;
    }
    out += sql.slice(last);
    return out;
}

function uniqueNames(items: { name: string }[]): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        const key = item.name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(item.name);
    }
    return names;
}

function collectPlaceholdersInString(
    text: string,
    tokenStart: number,
    found: NamedPlaceholder[]
): void {
    const last = text.length - 1;
    let i = 1;
    while (i < last) {
        if (text[i] === '{' && text[i + 1] === '{') {
            i += 2;
            continue;
        }
        if (text[i] !== '{') {
            i++;
            continue;
        }
        let j = i + 1;
        if (j >= last || !isIdentStart(text[j])) {
            i++;
            continue;
        }
        j++;
        while (j < last && isIdentPart(text[j])) {
            j++;
        }
        if (j >= last || text[j] !== '}') {
            i++;
            continue;
        }
        const name = text.slice(i + 1, j);
        if (!isOdbcPlaceholderName(name)) {
            found.push({
                name,
                start: tokenStart + i,
                end: tokenStart + j + 1
            });
        }
        i = j + 1;
    }
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

export function hasParam(params: Record<string, string | null>, name: string): boolean {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
        return true;
    }
    const lower = name.toLowerCase();
    for (const key of Object.keys(params)) {
        if (key.toLowerCase() === lower) {
            return true;
        }
    }
    return false;
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
