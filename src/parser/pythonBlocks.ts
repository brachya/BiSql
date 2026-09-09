import * as vscode from 'vscode';
import { skipFStringExpression } from './fString';
import { isIdentPart, isIdentStart } from './normalizeSql';

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


const SQL_MARKER = /(?:--\s*sql\b|\/\*\s*sql\s*\*\/)/i;
/** Optional `(` so `query = (` still counts as an assignment. */
const ASSIGN_TAIL = /([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*\w+\s*)?=\s*\(?\s*[rRfFbBuU]*$/;

/**
 * A leading SQL verb is not enough. English often starts with the same words
 * ("with an upcoming visit", "select the first option", "create a new user").
 * Require the tokens that normally follow that verb in real SQL.
 */
const SQL_NAME = String.raw`(?:[@#]?[A-Za-z_]\w*|\[[^\]]+\]|\`[^\`]+\`|"[^"]+")`;
const QUALIFIED_NAME = String.raw`${SQL_NAME}(?:\s*\.\s*${SQL_NAME})*`;
const SQL_STATEMENT_PATTERNS: RegExp[] = [
    new RegExp(
        String.raw`^SELECT\s+(?:\*|DISTINCT\b|TOP\b|ALL\s+\*|ALL\s+DISTINCT\b|\d|@@|${QUALIFIED_NAME}\s*(?:\.\s*\*|,|FROM\b|AS\b|\())`,
        'i'
    ),
    new RegExp(
        String.raw`^INSERT\s+(?:INTO\b|IGNORE\b|OVERWRITE\b|${QUALIFIED_NAME}\s*(?:\(|VALUES\b|SELECT\b|SET\b))`,
        'i'
    ),
    new RegExp(String.raw`^UPDATE\s+${QUALIFIED_NAME}\s+SET\b`, 'i'),
    new RegExp(
        String.raw`^DELETE\s+(?:FROM\b|${QUALIFIED_NAME}\s+(?:FROM\b|WHERE\b))`,
        'i'
    ),
    // WITH is a CTE only when `name AS (` follows. Bare "with …" is English.
    new RegExp(
        String.raw`^WITH\s+(?:RECURSIVE\s+)?${SQL_NAME}(?:\s*\([^)]*\))?\s+AS\s*\(`,
        'i'
    ),
    new RegExp(String.raw`^MERGE\s+INTO\b`, 'i'),
    // "Execute the plan" is English. A procedure name is not `the` / `a` / `this`.
    new RegExp(
        String.raw`^EXEC(?:UTE)?\s+(?!the\b|a\b|an\b|this\b|that\b|these\b|those\b|my\b|your\b|our\b|their\b)${QUALIFIED_NAME}`,
        'i'
    ),
    new RegExp(
        String.raw`^CREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:UNIQUE\s+|TEMP(?:ORARY)?\s+|MATERIALIZED\s+|CLUSTERED\s+|NONCLUSTERED\s+)*(?:TABLE|VIEW|INDEX|PROC(?:EDURE)?|FUNCTION|SCHEMA|DATABASE|TRIGGER|TYPE)\b`,
        'i'
    ),
    new RegExp(
        String.raw`^ALTER\s+(?:TABLE|VIEW|INDEX|PROC(?:EDURE)?|FUNCTION|SCHEMA|DATABASE)\b`,
        'i'
    ),
    new RegExp(
        String.raw`^DROP\s+(?:TABLE|VIEW|INDEX|PROC(?:EDURE)?|FUNCTION|SCHEMA|DATABASE|TRIGGER|TYPE)\b`,
        'i'
    ),
    // Bare `TRUNCATE extra spaces` is English. Keyword detection needs TABLE.
    new RegExp(String.raw`^TRUNCATE\s+TABLE\b`, 'i')
];

/**
 * True when the text starts a full statement (SELECT / WITH name AS / …).
 * CTE helper pieces (`name AS (SELECT …)`) are SQL, but not a statement.
 */
export function isSqlStatementStart(content: string): boolean {
    const stripped = content.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
    return SQL_STATEMENT_PATTERNS.some((pattern) => pattern.test(stripped));
}

function looksLikeSqlKeywordStart(content: string): boolean {
    return isSqlStatementStart(content);
}

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
export function offsetToPosition(
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

export function buildLineStarts(text: string): number[] {
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

function classifyGroupAsSql(
    group: PythonStringLiteral[],
    source: string,
    detectByKeyword: boolean
): boolean {
    const combined = group.map((literal) => literal.content).join('');
    if (SQL_MARKER.test(combined)) {
        return true;
    }
    const first = group[0];
    const preceding = source.slice(Math.max(0, first.quoteStart - 120), first.quoteStart);
    const assigned = ASSIGN_TAIL.exec(preceding);
    if ((assigned && looksLikeSqlAssignName(assigned[1])) || CALL_RE.test(preceding)) {
        return true;
    }
    if (detectByKeyword && looksLikeSqlKeywordStart(combined)) {
        return true;
    }
    return false;
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
    // Group first so implicit concat is one Python string, then classify.
    // Otherwise a later piece like `"with an upcoming visit scheduled."`
    // is treated as SQL on its own.
    return groupAdjacentLiterals(literals, source).filter((group) =>
        classifyGroupAsSql(group, source, detectByKeyword)
    );
}

export function extractSqlStringLiterals(
    document: vscode.TextDocument,
    detectByKeyword = true
): PythonStringLiteral[][] {
    return extractSqlStringLiteralGroups(document.getText(), detectByKeyword);
}

