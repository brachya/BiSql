import * as vscode from 'vscode';
import { skipFStringExpression } from './fString';
import {
    isIdentPart,
    isIdentStart,
    normalizeContent
} from './normalizeSql';

export { skipFStringExpression } from './fString';
export {
    isFragmentPosition,
    lastSqlToken,
    normalizeEmbeddedSql
} from './normalizeSql';

export interface Piece {
    sqlStart: number;
    sqlEnd: number;
    /** Absolute document offset of the matching content, or null for synthetic fillers. */
    docOffset: number | null;
}

export interface PythonStringLiteral {
    /** Absolute offset of the opening quote character(s). */
    quoteStart: number;
    /** Absolute offset just past the closing quote character(s). */
    quoteEnd: number;
    /** Absolute offset of the first content character (after the opening quotes). */
    contentStart: number;
    /** Absolute offset of the last content character + 1 (before the closing quotes). */
    contentEnd: number;
    content: string;
    quote: '"' | "'" | '"""' | "'''";
    prefix: string;
    isRaw: boolean;
    isFString: boolean;
}

export class SqlBlock {
    public readonly text: string;
    public readonly pieces: Piece[];
    public readonly lineStarts: number[];
    /** Absolute document offsets covering the original Python string(s). */
    public readonly docStart: number;
    public readonly docEnd: number;
    /** Full Python source, used only for offset → Position conversion. */
    private readonly source: string;
    /** Line starts for the Python source. Shared across blocks in one file. */
    private readonly sourceLineStarts: number[];
    private cachedTokens: SqlToken[] | undefined;
    private cachedAnalysis: SqlAnalysis | undefined;

    constructor(
        text: string,
        pieces: Piece[],
        docStart: number,
        docEnd: number,
        source: string,
        sourceLineStarts?: number[]
    ) {
        this.text = text;
        this.pieces = pieces;
        this.docStart = docStart;
        this.docEnd = docEnd;
        this.source = source;
        this.sourceLineStarts = sourceLineStarts ?? buildLineStarts(source);
        this.lineStarts = buildLineStarts(text);
    }

    public getTokens(): SqlToken[] {
        if (!this.cachedTokens) {
            this.cachedTokens = tokenizeSql(this.text);
        }
        return this.cachedTokens;
    }

    public analyze(): SqlAnalysis {
        if (!this.cachedAnalysis) {
            const tokens = this.getTokens();
            this.cachedAnalysis = {
                tokens,
                ...collectTableRefsFromTokens(tokens),
                selectAliases: collectSelectAliasesFromTokens(tokens)
            };
        }
        return this.cachedAnalysis;
    }

    public containsDocOffset(docOffset: number): boolean {
        return docOffset >= this.docStart && docOffset < this.docEnd;
    }

    public toSqlOffset(docOffset: number): number | null {
        for (const piece of this.pieces) {
            if (piece.docOffset === null) {
                continue;
            }
            const length = piece.sqlEnd - piece.sqlStart;
            if (docOffset >= piece.docOffset && docOffset < piece.docOffset + length) {
                return piece.sqlStart + (docOffset - piece.docOffset);
            }
            // Allow the caret sitting exactly at the end of a real piece.
            if (docOffset === piece.docOffset + length) {
                return piece.sqlEnd;
            }
        }
        return null;
    }

    public toDocRange(sqlStart: number, sqlEnd: number): vscode.Range {
        const start = this.sqlOffsetToDocPosition(sqlStart);
        const end = this.sqlOffsetToDocPosition(Math.max(sqlStart, sqlEnd));
        return new vscode.Range(start, end);
    }

    public sqlOffsetToDocPosition(sqlOffset: number): vscode.Position {
        for (const piece of this.pieces) {
            if (sqlOffset >= piece.sqlStart && sqlOffset <= piece.sqlEnd) {
                if (piece.docOffset === null) {
                    // Synthetic filler: snap to the nearest real piece start that follows,
                    // or the previous piece end.
                    const neighbour = this.nearestRealDocOffset(sqlOffset);
                    return offsetToPosition(this.source, neighbour, this.sourceLineStarts);
                }
                const docOffset = piece.docOffset + (sqlOffset - piece.sqlStart);
                return offsetToPosition(this.source, docOffset, this.sourceLineStarts);
            }
        }
        // Fall back to the block's document start.
        return offsetToPosition(this.source, this.docStart, this.sourceLineStarts);
    }

    public isSyntheticSqlOffset(sqlOffset: number): boolean {
        for (const piece of this.pieces) {
            if (sqlOffset >= piece.sqlStart && sqlOffset < piece.sqlEnd) {
                return piece.docOffset === null;
            }
        }
        return false;
    }

    public lineToSqlOffset(lineNumber: number): number {
        // SQL Server line numbers are 1-based relative to the batch we sent.
        const index = Math.max(0, lineNumber - 1);
        if (index >= this.lineStarts.length) {
            return this.text.length;
        }
        return this.lineStarts[index];
    }

    private nearestRealDocOffset(sqlOffset: number): number {
        let previous: number | null = null;
        for (const piece of this.pieces) {
            if (piece.docOffset === null) {
                continue;
            }
            if (piece.sqlStart >= sqlOffset) {
                return piece.docOffset;
            }
            previous = piece.docOffset + (piece.sqlEnd - piece.sqlStart);
        }
        return previous ?? this.docStart;
    }
}

interface DocumentCacheEntry {
    version: number;
    detectByKeyword: boolean;
    blocks: SqlBlock[];
}

const documentCache = new Map<string, DocumentCacheEntry>();

const SQL_MARKER = /(?:--\s*sql\b|\/\*\s*sql\s*\*\/)/i;
const SQL_KEYWORD_START =
    /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|EXEC(?:UTE)?|CREATE|ALTER|DROP|TRUNCATE)\b/i;
const ASSIGN_TAIL = /([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*\w+\s*)?=\s*[rRfFbBuU]*$/;

/** `update_query`, `query`, `raw_sql`, `sql_text`. Not `sqlite` / `sqlalchemy`. */
function looksLikeSqlAssignName(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower === 'sqlite' || lower.startsWith('sqlite_') || lower.startsWith('sqlalchemy')) {
        return false;
    }
    if (lower.includes('query') || lower.includes('stmt') || lower.includes('statement')) {
        return true;
    }
    return lower === 'sql' || /(?:^|_)sql(?:_|$|\d)/.test(lower);
}
const CALL_RE =
    /\.\s*(execute|executemany|read_sql|read_sql_query)\s*\(\s*[rRfFbBuU]*$|\btext\s*\(\s*[rRfFbBuU]*$/;

const STRING_PREFIXES = new Set([
    'r', 'f', 'b', 'u',
    'rb', 'br', 'rf', 'fr', 'ru', 'ur',
    'R', 'F', 'B', 'U',
    'RB', 'BR', 'RF', 'FR', 'RU', 'UR',
    'Rb', 'Br', 'Rf', 'Fr', 'Ru', 'Ur',
    'rB', 'bR', 'rF', 'fR', 'rU', 'uR'
]);

/**
 * Absolute-offset helpers that do not depend on a TextDocument instance, so the
 * tokenizer can be unit-tested against plain strings.
 */
function offsetToPosition(
    text: string,
    offset: number,
    lineStarts: number[]
): vscode.Position {
    const clamped = Math.max(0, Math.min(offset, text.length));
    const line = findLineIndex(lineStarts, clamped);
    return new vscode.Position(line, clamped - lineStarts[line]);
}

function findLineIndex(lineStarts: number[], offset: number): number {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= offset) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return Math.max(0, hi);
}

function buildLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1);
        }
    }
    return starts;
}

/**
 * Scans a Python source file and returns every string literal with accurate offsets.
 */
export function tokenizePythonStrings(text: string): PythonStringLiteral[] {
    const results: PythonStringLiteral[] = [];
    let i = 0;
    const length = text.length;

    while (i < length) {
        const ch = text[i];

        // Line comment.
        if (ch === '#') {
            while (i < length && text[i] !== '\n') {
                i++;
            }
            continue;
        }

        // Possible string prefix + quote.
        if (isIdentStart(ch) || ch === '"' || ch === "'") {
            let prefix = '';
            let j = i;
            if (isIdentStart(ch)) {
                while (j < length && isIdentPart(text[j])) {
                    j++;
                }
                prefix = text.slice(i, j);
                if (!STRING_PREFIXES.has(prefix.toLowerCase()) && !STRING_PREFIXES.has(prefix)) {
                    // Not a string prefix — skip the identifier.
                    i = j;
                    continue;
                }
                // Only treat as a prefix when a quote follows immediately.
                if (text[j] !== '"' && text[j] !== "'") {
                    i = j;
                    continue;
                }
            }

            const quoteChar = text[j];
            const isTriple =
                text[j + 1] === quoteChar && text[j + 2] === quoteChar;
            const quote = isTriple
                ? (quoteChar === '"' ? '"""' : "'''")
                : (quoteChar as '"' | "'");
            const quoteStart = j;
            const contentStart = j + quote.length;
            const lowerPrefix = prefix.toLowerCase();
            const isRaw = lowerPrefix.includes('r');
            const isFString = lowerPrefix.includes('f');

            let k = contentStart;
            let closed = false;
            while (k < length) {
                if (isTriple) {
                    if (
                        text[k] === quoteChar &&
                        text[k + 1] === quoteChar &&
                        text[k + 2] === quoteChar
                    ) {
                        closed = true;
                        break;
                    }
                } else if (text[k] === quoteChar) {
                    closed = true;
                    break;
                }

                if (!isRaw && text[k] === '\\') {
                    k += 2;
                    continue;
                }

                // Skip f-string interpolation braces so braces inside them
                // do not confuse later placeholder scanning. The braces themselves
                // stay in the content; we only advance the scanner past nested `{}`.
                if (isFString && text[k] === '{') {
                    if (text[k + 1] === '{') {
                        k += 2;
                        continue;
                    }
                    k = skipFStringExpression(text, k);
                    continue;
                }

                k++;
            }

            const contentEnd = closed ? k : length;
            const quoteEnd = closed ? k + quote.length : length;
            results.push({
                quoteStart,
                quoteEnd,
                contentStart,
                contentEnd,
                content: text.slice(contentStart, contentEnd),
                quote,
                prefix,
                isRaw,
                isFString
            });
            i = quoteEnd;
            continue;
        }

        i++;
    }

    return results;
}

function classifyAsSql(
    literal: PythonStringLiteral,
    source: string,
    detectByKeyword: boolean
): boolean {
    if (SQL_MARKER.test(literal.content)) {
        return true;
    }
    const preceding = source.slice(Math.max(0, literal.quoteStart - 120), literal.quoteStart);
    const assigned = ASSIGN_TAIL.exec(preceding);
    if ((assigned && looksLikeSqlAssignName(assigned[1])) || CALL_RE.test(preceding)) {
        return true;
    }
    if (detectByKeyword && SQL_KEYWORD_START.test(literal.content)) {
        return true;
    }
    return false;
}

function buildBlockFromLiterals(
    literals: PythonStringLiteral[],
    source: string,
    sourceLineStarts: number[]
): SqlBlock {
    const pieces: Piece[] = [];
    let sql = '';
    for (const literal of literals) {
        const segments = normalizeContent(
            literal.content,
            literal.contentStart,
            literal.isFString,
            sql
        );
        for (const segment of segments) {
            const sqlStart = sql.length;
            sql += segment.text;
            pieces.push({
                sqlStart,
                sqlEnd: sql.length,
                docOffset: segment.docOffset
            });
        }
    }
    const docStart = literals[0].quoteStart;
    const docEnd = literals[literals.length - 1].quoteEnd;
    return new SqlBlock(sql, pieces, docStart, docEnd, source, sourceLineStarts);
}

/**
 * Adjacent string literals joined by whitespace or an explicit `+` / `(`
 * inside a call or assignment form one SQL block.
 */
function groupAdjacentLiterals(
    literals: PythonStringLiteral[],
    source: string
): PythonStringLiteral[][] {
    if (literals.length === 0) {
        return [];
    }
    const groups: PythonStringLiteral[][] = [[literals[0]]];
    for (let i = 1; i < literals.length; i++) {
        const prev = literals[i - 1];
        const curr = literals[i];
        const between = source.slice(prev.quoteEnd, curr.quoteStart);
        // Implicit concatenation, or an explicit `+`, with only whitespace / `\` / newlines.
        if (/^[\s\\]*\+?[\s\\]*$/.test(between)) {
            groups[groups.length - 1].push(curr);
        } else {
            groups.push([curr]);
        }
    }
    return groups;
}

/**
 * Classified SQL string groups (adjacent implicit / `+` concat stays one group).
 * Use the original literal content — not the NULL-normalized SQL used for analysis.
 */
export function extractSqlStringLiteralGroups(
    source: string,
    detectByKeyword = true
): PythonStringLiteral[][] {
    const literals = tokenizePythonStrings(source);
    const sqlLiterals = literals.filter((literal) =>
        classifyAsSql(literal, source, detectByKeyword)
    );
    return groupAdjacentLiterals(sqlLiterals, source);
}

export function extractSqlStringLiterals(
    document: vscode.TextDocument,
    detectByKeyword = true
): PythonStringLiteral[][] {
    return extractSqlStringLiteralGroups(document.getText(), detectByKeyword);
}

export function extractSqlBlocksFromSource(
    source: string,
    detectByKeyword = true
): SqlBlock[] {
    const groups = extractSqlStringLiteralGroups(source, detectByKeyword);
    const sourceLineStarts = buildLineStarts(source);
    return groups.map((group) => buildBlockFromLiterals(group, source, sourceLineStarts));
}

export function extractSqlBlocks(
    document: vscode.TextDocument,
    detectByKeyword = true
): SqlBlock[] {
    const key = document.uri.toString();
    const cached = documentCache.get(key);
    if (
        cached &&
        cached.version === document.version &&
        cached.detectByKeyword === detectByKeyword
    ) {
        return cached.blocks;
    }

    const text = document.getText();
    const blocks = extractSqlBlocksFromSource(text, detectByKeyword);

    documentCache.set(key, {
        version: document.version,
        detectByKeyword,
        blocks
    });
    return blocks;
}

export function clearDocumentCache(uri?: vscode.Uri): void {
    if (uri) {
        documentCache.delete(uri.toString());
    } else {
        documentCache.clear();
    }
}

export function findBlockAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    detectByKeyword = true
): { block: SqlBlock; sqlOffset: number } | undefined {
    const blocks = extractSqlBlocks(document, detectByKeyword);
    const docOffset = document.offsetAt(position);
    for (const block of blocks) {
        if (!block.containsDocOffset(docOffset)) {
            continue;
        }
        const sqlOffset = block.toSqlOffset(docOffset);
        if (sqlOffset === null) {
            // Cursor is on the quote characters themselves — treat as just inside.
            if (docOffset < block.pieces[0]?.docOffset!) {
                return { block, sqlOffset: 0 };
            }
            return { block, sqlOffset: block.text.length };
        }
        return { block, sqlOffset };
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Shared SQL tokenizer and table/alias collector
// ---------------------------------------------------------------------------

export type SqlTokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'punct' | 'other';

export interface SqlToken {
    kind: SqlTokenKind;
    text: string;
    /** Unquoted identifier text when kind === 'ident'. */
    value: string;
    start: number;
    end: number;
}

const SQL_KEYWORDS = new Set(
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
            const value = raw.slice(1, -1).replace(/\]\]/g, ']');
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
            const value = raw.slice(1, -1).replace(/``/g, '`');
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
            const value = raw.slice(1, -1).replace(/""/g, '"');
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

        // Number.
        if ((ch >= '0' && ch <= '9') || (ch === '.' && sql[i + 1] >= '0' && sql[i + 1] <= '9')) {
            let j = i + 1;
            while (j < sql.length && ((sql[j] >= '0' && sql[j] <= '9') || sql[j] === '.')) {
                j++;
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

        // Multi-char punctuation we care about, else single char.
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

export interface TableRef {
    /** Resolved table reference as written (e.g. dbo.Users). */
    table: string;
    /** Alias if present, otherwise the table name. */
    alias: string;
    /** SQL offset of the table name. */
    start: number;
    end: number;
}

export interface TableRefResult {
    refs: TableRef[];
    aliasToTable: Map<string, string>;
    hasCte: boolean;
    hasDerived: boolean;
    hasExec: boolean;
}

export interface SqlAnalysis extends TableRefResult {
    tokens: SqlToken[];
    selectAliases: Set<string>;
}

/** True when UPDATE names a target table, not a clause like ON DUPLICATE KEY UPDATE. */
function isTableIntroducingUpdate(tokens: SqlToken[], updateIndex: number): boolean {
    if (updateIndex < 1) {
        return true;
    }
    const prev = tokens[updateIndex - 1].value.toLowerCase();
    if (prev === 'for') {
        return false;
    }
    return !(
        updateIndex >= 3 &&
        tokens[updateIndex - 3].value.toLowerCase() === 'on' &&
        tokens[updateIndex - 2].value.toLowerCase() === 'duplicate' &&
        prev === 'key'
    );
}

/**
 * Collects table references and aliases from FROM / JOIN / UPDATE / INTO / DELETE FROM.
 * Skips derived tables `(SELECT …)` and CTEs introduced by WITH.
 */
export function collectTableRefs(sql: string, tokens: SqlToken[] = tokenizeSql(sql)): TableRefResult {
    return collectTableRefsFromTokens(tokens);
}

function collectTableRefsFromTokens(tokens: SqlToken[]): TableRefResult {
    const refs: TableRef[] = [];
    const aliasToTable = new Map<string, string>();
    let hasCte = false;
    let hasDerived = false;
    let hasExec = false;

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const lower = tok.value.toLowerCase();

        if (tok.kind === 'keyword' && lower === 'with') {
            hasCte = true;
        }
        if (tok.kind === 'keyword' && (lower === 'exec' || lower === 'execute')) {
            hasExec = true;
        }

        const isFromLike =
            tok.kind === 'keyword' &&
            (lower === 'from' ||
                lower === 'join' ||
                lower === 'into' ||
                (lower === 'update' && isTableIntroducingUpdate(tokens, i)) ||
                (lower === 'table' && i > 0));

        // DELETE FROM …
        const isDeleteFrom =
            tok.kind === 'keyword' &&
            lower === 'from' &&
            i > 0 &&
            tokens[i - 1].kind === 'keyword' &&
            tokens[i - 1].value.toLowerCase() === 'delete';

        if (!isFromLike && !isDeleteFrom) {
            continue;
        }

        // Skip JOIN qualifiers already handled by looking at 'join' itself.
        let j = i + 1;
        if (j >= tokens.length) {
            continue;
        }

        // Derived table: FROM ( SELECT …
        if (tokens[j].text === '(') {
            hasDerived = true;
            continue;
        }

        // Read a possibly schema-qualified name: a.b or [a].[b]
        const nameParts: SqlToken[] = [];
        while (j < tokens.length) {
            if (tokens[j].kind === 'ident') {
                nameParts.push(tokens[j]);
                j++;
                if (j < tokens.length && tokens[j].text === '.') {
                    j++;
                    continue;
                }
                break;
            }
            break;
        }
        if (nameParts.length === 0) {
            continue;
        }

        const table = nameParts.map((part) => part.value).join('.');
        const start = nameParts[0].start;
        const end = nameParts[nameParts.length - 1].end;

        // Optional AS alias, or bare alias (not a keyword / punct).
        let alias = nameParts[nameParts.length - 1].value;
        if (j < tokens.length) {
            if (
                tokens[j].kind === 'keyword' &&
                tokens[j].value.toLowerCase() === 'as' &&
                j + 1 < tokens.length &&
                tokens[j + 1].kind === 'ident'
            ) {
                alias = tokens[j + 1].value;
                j += 2;
            } else if (
                tokens[j].kind === 'ident' &&
                !SQL_KEYWORDS.has(tokens[j].value.toLowerCase())
            ) {
                alias = tokens[j].value;
                j++;
            }
        }

        refs.push({ table, alias, start, end });
        aliasToTable.set(alias.toLowerCase(), table);
        // Also map the bare table name so `Users.Id` works without an alias.
        aliasToTable.set(nameParts[nameParts.length - 1].value.toLowerCase(), table);
    }

    return { refs, aliasToTable, hasCte, hasDerived, hasExec };
}

/**
 * Collects output aliases from the SELECT list (`expr AS alias` or `expr alias`).
 * Used so ORDER BY / later references to those names are not flagged as missing columns.
 */
export function collectSelectAliases(
    sql: string,
    tokens: SqlToken[] = tokenizeSql(sql)
): Set<string> {
    return collectSelectAliasesFromTokens(tokens);
}

function collectSelectAliasesFromTokens(tokens: SqlToken[]): Set<string> {
    const aliases = new Set<string>();
    let i = 0;
    while (i < tokens.length) {
        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'select') {
            i++;
            break;
        }
        i++;
    }
    if (i >= tokens.length) {
        return aliases;
    }

    // Skip DISTINCT / TOP n
    while (i < tokens.length) {
        const lower = tokens[i].value.toLowerCase();
        if (tokens[i].kind === 'keyword' && (lower === 'distinct' || lower === 'all')) {
            i++;
            continue;
        }
        if (tokens[i].kind === 'keyword' && lower === 'top') {
            i++;
            if (i < tokens.length && tokens[i].kind === 'number') {
                i++;
            }
            continue;
        }
        break;
    }

    while (i < tokens.length) {
        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'from') {
            break;
        }

        // Walk one select-item until comma or FROM.
        let depth = 0;
        let lastValueToken = -1;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (tok.text === '(') {
                depth++;
                i++;
                continue;
            }
            if (tok.text === ')') {
                depth = Math.max(0, depth - 1);
                lastValueToken = i;
                i++;
                continue;
            }
            if (depth === 0 && tok.text === ',') {
                i++;
                break;
            }
            if (depth === 0 && tok.kind === 'keyword' && tok.value.toLowerCase() === 'from') {
                break;
            }

            if (depth === 0 && tok.kind === 'keyword' && tok.value.toLowerCase() === 'as') {
                if (i + 1 < tokens.length && tokens[i + 1].kind === 'ident') {
                    aliases.add(tokens[i + 1].value.toLowerCase());
                    i += 2;
                    // Consume until comma / FROM
                    while (i < tokens.length) {
                        if (tokens[i].text === ',' ) {
                            i++;
                            break;
                        }
                        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'from') {
                            break;
                        }
                        i++;
                    }
                    break;
                }
            }

            // Implicit alias: <expr> <ident> where expr ended with ) / ident / number / string
            if (
                depth === 0 &&
                tok.kind === 'ident' &&
                lastValueToken >= 0 &&
                !SQL_KEYWORDS.has(tok.value.toLowerCase())
            ) {
                const prev = tokens[lastValueToken];
                const prevIsValue =
                    prev.kind === 'ident' ||
                    prev.kind === 'number' ||
                    prev.kind === 'string' ||
                    prev.text === ')';
                const nextIsCall = i + 1 < tokens.length && tokens[i + 1].text === '(';
                if (prevIsValue && !nextIsCall && lastValueToken !== i) {
                    aliases.add(tok.value.toLowerCase());
                    i++;
                    while (i < tokens.length) {
                        if (tokens[i].text === ',') {
                            i++;
                            break;
                        }
                        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'from') {
                            break;
                        }
                        i++;
                    }
                    break;
                }
            }

            if (tok.kind === 'ident' || tok.kind === 'number' || tok.kind === 'string') {
                lastValueToken = i;
            }
            i++;
        }
    }

    return aliases;
}

/**
 * Returns the identifier (or dotted path) under a SQL offset.
 */
export function identifierAt(
    sql: string,
    offset: number,
    tokens: SqlToken[] = tokenizeSql(sql)
): { text: string; value: string; start: number; end: number; parts: string[] } | undefined {
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.kind !== 'ident') {
            continue;
        }
        if (offset < tok.start || offset > tok.end) {
            continue;
        }

        // Expand left/right across dots to form a.b.c
        let left = i;
        while (
            left > 1 &&
            tokens[left - 1].text === '.' &&
            tokens[left - 2].kind === 'ident'
        ) {
            left -= 2;
        }
        let right = i;
        while (
            right + 2 < tokens.length &&
            tokens[right + 1].text === '.' &&
            tokens[right + 2].kind === 'ident'
        ) {
            right += 2;
        }

        const parts: string[] = [];
        for (let k = left; k <= right; k++) {
            if (tokens[k].kind === 'ident') {
                parts.push(tokens[k].value);
            }
        }
        return {
            text: sql.slice(tokens[left].start, tokens[right].end),
            value: parts.join('.'),
            start: tokens[left].start,
            end: tokens[right].end,
            parts
        };
    }
    return undefined;
}
