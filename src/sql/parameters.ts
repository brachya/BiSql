import { skipFStringExpression } from '../parser/fString';
import { isIdentPart, isIdentStart } from '../parser/normalizeSql';
import { collectCteDefs, tokenizeSql } from '../parser/sqlExtractor';
import { splitSqlStatements } from '../parser/sqlStatements';

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
 * Verbs the SQL tokenizer stores as identifiers, not keywords.
 * `REFRESH MATERIALIZED VIEW`, `VACUUM`, and `LOCK TABLE` change data or take locks.
 */
const LEADING_MUTATING_VERBS = new Set([
    'call',
    'copy',
    'grant',
    'load',
    'lock',
    'refresh',
    'replace',
    'revoke',
    'vacuum'
]);

/** Plpgsql openers. A verb after one of these is a statement, not a name. */
const DO_BLOCK_OPENERS = new Set(['begin', 'then', 'else', 'elsif', 'elseif', 'loop']);

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
 * `{name}` and `{expr}` placeholders in the SQL text, including inside `'…'`
 * strings. Skips comments, `{{` doubled braces, JSON objects, and ODBC
 * `{d '…'}` / `{fn …}`.
 */
export function findPlaceholders(sql: string): NamedPlaceholder[] {
    const tokens = tokenizeSql(sql);
    const found: NamedPlaceholder[] = [];
    for (const token of tokens) {
        if (token.kind === 'string') {
            collectPlaceholdersInString(token.text, token.start, found);
        }
    }
    for (let i = 0; i < tokens.length; i++) {
        const open = tokens[i];
        if (open.text !== '{') {
            continue;
        }
        const prev = i > 0 ? tokens[i - 1] : undefined;
        if (prev && prev.text === '{' && prev.end === open.start) {
            continue;
        }
        const placeholder = readPlaceholder(sql, open.start, sql.length);
        if (!placeholder) {
            continue;
        }
        found.push(placeholder);
        while (i + 1 < tokens.length && tokens[i + 1].start < placeholder.end) {
            i++;
        }
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

/**
 * `{hours}`, `{foo.bar}`, and `{get_building_fields(trailing_comma=True)}`.
 * Inner text must start with a name (after spaces). `{0}` and `'{"a": 1}'` do not.
 */
function readPlaceholder(text: string, openAt: number, limit: number): NamedPlaceholder | null {
    if (openAt < 0 || openAt >= limit || text[openAt] !== '{') {
        return null;
    }
    if (text[openAt + 1] === '{') {
        return null;
    }
    const end = skipFStringExpression(text, openAt);
    if (end > limit || end <= openAt + 1 || text[end - 1] !== '}') {
        return null;
    }
    const inner = text.slice(openAt + 1, end - 1);
    const name = inner.trim();
    if (!name) {
        return null;
    }
    let i = 0;
    while (i < inner.length && isPlaceholderSpace(inner[i])) {
        i++;
    }
    if (i >= inner.length || !isIdentStart(inner[i])) {
        return null;
    }
    let j = i + 1;
    while (j < inner.length && isIdentPart(inner[j])) {
        j++;
    }
    if (isOdbcPlaceholderName(inner.slice(i, j))) {
        return null;
    }
    return { name, start: openAt, end };
}

function isPlaceholderSpace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
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
        const placeholder = readPlaceholder(text, i, last);
        if (!placeholder) {
            i++;
            continue;
        }
        found.push({
            name: placeholder.name,
            start: tokenStart + placeholder.start,
            end: tokenStart + placeholder.end
        });
        i = placeholder.end;
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

/**
 * Typed param-box values only. Grid / mutation binds must use `lookupParam`
 * so a cell that already holds `'folder/'` is not rewritten on save.
 */
export function lookupBind(
    params: Record<string, string | null>,
    name: string
): string | null {
    return unwrapBindValue(lookupParam(params, name));
}

export function unwrapBindValue(value: string | null): string | null {
    if (value === null) {
        return null;
    }
    if (value.length < 2) {
        return value;
    }
    const quote = value[0];
    if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
        return value;
    }
    const inner = value.slice(1, -1);
    if (inner.includes(quote)) {
        return value;
    }
    return inner;
}

/**
 * Text from the results form or the Run prompt. A blank box is an empty
 * string. The word NULL (any case) is SQL NULL. Quotes around a value are
 * stripped, so `''` is also empty.
 */
export function bindValueFromInput(value: string): string | null {
    if (/^null$/i.test(value)) {
        return null;
    }
    return unwrapBindValue(value);
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

function statementLeadingVerb(sql: string): string | null {
    const tokens = tokenizeSql(sql);
    if (tokens.length === 0) {
        return null;
    }
    let scanFrom = 0;
    const firstKeyword = tokens.find((token) => token.kind === 'keyword' || token.kind === 'ident');
    if (firstKeyword?.kind === 'keyword' && firstKeyword.value.toLowerCase() === 'with') {
        const defs = collectCteDefs(tokens);
        if (defs.length > 0) {
            scanFrom = defs[defs.length - 1].bodyClose + 1;
        }
    }
    for (let i = scanFrom; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind === 'keyword' || token.kind === 'ident') {
            return token.value.toLowerCase();
        }
    }
    return null;
}

/**
 * True when the batch looks like it can change data or schema.
 * `SELECT … FOR UPDATE` also counts (it takes locks).
 * `SHOW …` and plain `EXPLAIN …` do not write.
 * `EXPLAIN ANALYZE` and `EXPLAIN ANALYSE` run the query. Postgres accepts both spellings.
 * `ANALYZE` still runs when it is not the first option: `EXPLAIN (VERBOSE, ANALYZE)`.
 * `ANALYZE false` and `ANALYZE off` do not run the statement.
 * `DO $$ ... $$` is scanned too: the tokenizer does not hide dollar quotes,
 * and `COPY` / `CALL` inside the body are not the first verb of the batch.
 */
export function isMutatingSql(sql: string): boolean {
    for (const slice of splitSqlStatements(sql)) {
        if (statementSliceMutates(slice.text)) {
            return true;
        }
    }
    // Semicolons inside DO $$ ... $$ must not split the block before we read it.
    return doBodyMutates(sql);
}

/** Where to start scanning for mutating keywords, or skip the whole statement. */
function mutatingKeywordScanStart(tokens: ReturnType<typeof tokenizeSql>): 'skip' | number {
    let start = -1;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind === 'keyword' || token.kind === 'ident') {
            start = i;
            break;
        }
    }
    if (start < 0) {
        return 'skip';
    }
    const verb = tokens[start].value.toLowerCase();
    if (verb === 'show') {
        return 'skip';
    }
    if (verb === 'explain') {
        return explainStatementStart(tokens, start);
    }
    return 0;
}

function isAnalyzeWord(word: string): boolean {
    // Postgres treats ANALYSE the same as ANALYZE, and both run the statement.
    return word === 'analyze' || word === 'analyse';
}

/** True when this ANALYZE option is explicitly turned off (`false` or `off`). */
function explainOptionDisablesRun(tokens: ReturnType<typeof tokenizeSql>, optionIndex: number): boolean {
    for (let j = optionIndex + 1; j < tokens.length; j++) {
        const token = tokens[j];
        if (token.text === ',' || token.text === ')') {
            return false;
        }
        if (token.kind === 'keyword' || token.kind === 'ident') {
            const word = token.value.toLowerCase();
            return word === 'false' || word === 'off';
        }
    }
    return false;
}

/**
 * Index of the statement after EXPLAIN, or skip when EXPLAIN will not run it.
 * Parentheses hold the option list (`VERBOSE, ANALYZE`). The old form is
 * `EXPLAIN [ANALYZE] [VERBOSE] statement`.
 */
function explainStatementStart(tokens: ReturnType<typeof tokenizeSql>, explainIndex: number): 'skip' | number {
    let i = explainIndex + 1;
    while (i < tokens.length && tokens[i].text !== '(' && tokens[i].kind !== 'keyword' && tokens[i].kind !== 'ident') {
        i++;
    }
    if (i >= tokens.length) {
        return 'skip';
    }
    if (tokens[i].text === '(') {
        return explainParenStart(tokens, i);
    }
    let runs = false;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.kind !== 'keyword' && token.kind !== 'ident') {
            i++;
            continue;
        }
        const word = token.value.toLowerCase();
        if (isAnalyzeWord(word)) {
            if (!explainOptionDisablesRun(tokens, i)) {
                runs = true;
            }
            i++;
            continue;
        }
        if (word === 'verbose') {
            i++;
            continue;
        }
        break;
    }
    return runs ? i : 'skip';
}

function explainParenStart(tokens: ReturnType<typeof tokenizeSql>, openIndex: number): 'skip' | number {
    let depth = 0;
    let runs = false;
    for (let i = openIndex; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.text === '(') {
            depth++;
            continue;
        }
        if (token.text === ')') {
            depth--;
            if (depth === 0) {
                return runs ? i + 1 : 'skip';
            }
            continue;
        }
        if (depth !== 1 || (token.kind !== 'keyword' && token.kind !== 'ident')) {
            continue;
        }
        if (isAnalyzeWord(token.value.toLowerCase())) {
            runs = !explainOptionDisablesRun(tokens, i);
        }
    }
    return 'skip';
}

function statementSliceMutates(text: string): boolean {
    const tokens = tokenizeSql(text);
    const scan = mutatingKeywordScanStart(tokens);
    if (scan === 'skip') {
        return false;
    }
    for (let i = scan; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind !== 'keyword') {
            continue;
        }
        if (MUTATING_KEYWORDS.has(token.value.toLowerCase())) {
            return true;
        }
    }
    const verb = statementLeadingVerb(text);
    if (verb !== null && LEADING_MUTATING_VERBS.has(verb)) {
        return true;
    }
    if (scan > 0) {
        const inner = leadingVerbFromTokens(tokens, scan);
        if (inner !== null && LEADING_MUTATING_VERBS.has(inner)) {
            return true;
        }
    }
    return false;
}

function leadingVerbFromTokens(tokens: ReturnType<typeof tokenizeSql>, from: number): string | null {
    for (let i = from; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind === 'keyword' || token.kind === 'ident') {
            return token.value.toLowerCase();
        }
    }
    return null;
}

function doBodyMutates(sql: string): boolean {
    for (const region of dollarQuoteRegions(sql)) {
        const before = sql.slice(0, region.start);
        const slices = splitSqlStatements(before);
        const head = slices.length > 0 ? slices[slices.length - 1].text : before;
        if (statementLeadingVerb(head) !== 'do') {
            continue;
        }
        if (dollarBodyHasMutatingVerb(region.body)) {
            return true;
        }
    }
    return false;
}

function dollarBodyHasMutatingVerb(sql: string): boolean {
    for (const slice of splitSqlStatements(sql)) {
        const tokens = tokenizeSql(slice.text);
        let caseDepth = 0;
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.kind === 'keyword') {
                const lower = token.value.toLowerCase();
                if (lower === 'case') {
                    caseDepth++;
                } else if (lower === 'end' && caseDepth > 0) {
                    caseDepth--;
                }
            }
            if (token.kind !== 'keyword' && token.kind !== 'ident') {
                continue;
            }
            const lower = token.value.toLowerCase();
            if (!LEADING_MUTATING_VERBS.has(lower)) {
                continue;
            }
            if (isDoCommandPosition(tokens, i, caseDepth)) {
                return true;
            }
        }
    }
    return false;
}

function isDoCommandPosition(
    tokens: ReturnType<typeof tokenizeSql>,
    index: number,
    caseDepth: number
): boolean {
    if (index === 0) {
        return true;
    }
    const prev = tokens[index - 1];
    if (prev.text === ';' || prev.text === '$') {
        return true;
    }
    if (prev.kind !== 'keyword' && prev.kind !== 'ident') {
        return false;
    }
    const opener = prev.value.toLowerCase();
    if (
        (opener === 'then' || opener === 'else' || opener === 'elsif' || opener === 'elseif') &&
        caseDepth > 0
    ) {
        return false;
    }
    return DO_BLOCK_OPENERS.has(opener);
}

/** Bodies of `$tag$ ... $tag$`. Skips strings and comments, so a quoted `$$` is not a body. */
function dollarQuoteRegions(sql: string): Array<{ start: number; body: string }> {
    const regions: Array<{ start: number; body: string }> = [];
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') {
                i++;
            }
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
                i++;
            }
            i = Math.min(i + 2, sql.length);
            continue;
        }
        if (ch === "'" || ch === '"') {
            i = skipQuoted(sql, i, ch);
            continue;
        }
        const prev = i > 0 ? sql[i - 1] : '';
        if (ch === '$' && !isIdentPart(prev)) {
            const tag = readDollarTag(sql, i);
            if (tag) {
                const close = sql.indexOf(tag, i + tag.length);
                if (close >= 0) {
                    regions.push({ start: i, body: sql.slice(i + tag.length, close) });
                    i = close + tag.length;
                    continue;
                }
            }
        }
        i++;
    }
    return regions;
}

function readDollarTag(sql: string, start: number): string | null {
    let j = start + 1;
    if (j >= sql.length) {
        return null;
    }
    if (sql[j] !== '$' && !isIdentStart(sql[j])) {
        return null;
    }
    if (sql[j] !== '$') {
        while (j < sql.length && isIdentPart(sql[j])) {
            j++;
        }
    }
    if (sql[j] !== '$') {
        return null;
    }
    return sql.slice(start, j + 1);
}

function skipQuoted(sql: string, start: number, quote: string): number {
    let j = start + 1;
    while (j < sql.length) {
        if (sql[j] === quote && sql[j + 1] === quote) {
            j += 2;
            continue;
        }
        if (sql[j] === quote) {
            return j + 1;
        }
        j++;
    }
    return sql.length;
}
