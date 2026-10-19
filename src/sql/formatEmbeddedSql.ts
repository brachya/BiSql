import { format as formatSql, type SqlLanguage } from 'sql-formatter';
import { skipFStringExpression } from '../parser/fString';

export type FormatKeywordCase = 'upper' | 'lower' | 'preserve';
/** `keyword` means functions or types follow `keywordCase`. */
export type FormatCaseChoice = 'keyword' | FormatKeywordCase;
export type FormatLogicalNewline = 'before' | 'after';
export type FormatDialect = 'tsql' | 'mysql' | 'postgresql' | 'bigquery';

export interface FormatStyle {
    keywordCase: FormatKeywordCase;
    functionCase: FormatCaseChoice;
    dataTypeCase: FormatCaseChoice;
    tabWidth: number;
    /** Force tab indent. Off still uses tabs when the SQL itself is tab-indented. */
    useTabs: boolean;
    logicalOperatorNewline: FormatLogicalNewline;
    expressionWidth: number;
    linesBetweenQueries: number;
    denseOperators: boolean;
    newlineBeforeSemicolon: boolean;
}

export interface FormatEmbeddedSqlOptions {
    dialect: FormatDialect;
    keywordCase: FormatKeywordCase;
    functionCase?: FormatCaseChoice;
    dataTypeCase?: FormatCaseChoice;
    tabWidth: number;
    /** Force tab indent. Off still uses tabs when the SQL itself is tab-indented. */
    useTabs?: boolean;
    logicalOperatorNewline?: FormatLogicalNewline;
    expressionWidth?: number;
    linesBetweenQueries?: number;
    denseOperators?: boolean;
    newlineBeforeSemicolon?: boolean;
    isFString: boolean;
    isTripleQuoted: boolean;
    /**
     * Whitespace before the first SQL character on its file line.
     * Keeps formatted lines at that column instead of column 0.
     * When omitted, indent is taken from the SQL text itself.
     */
    anchorIndent?: string;
}

export type FormatEmbeddedSqlResult =
    | { ok: true; text: string }
    | { ok: false; error: string };

const TOKEN_PREFIX = '__SPVFMT_';
const TOKEN_SUFFIX = '__';

export function parseKeywordCase(value: unknown): FormatKeywordCase {
    if (value === 'lower' || value === 'preserve') {
        return value;
    }
    return 'upper';
}

export function parseCaseChoice(value: unknown): FormatCaseChoice {
    if (value === 'upper' || value === 'lower' || value === 'preserve' || value === 'keyword') {
        return value;
    }
    return 'keyword';
}

export function parseLogicalNewline(value: unknown): FormatLogicalNewline {
    return value === 'after' ? 'after' : 'before';
}

export function clampExpressionWidth(value: unknown): number {
    const width = typeof value === 'number' ? value : 50;
    if (!Number.isFinite(width)) {
        return 50;
    }
    return Math.max(1, Math.min(500, Math.floor(width)));
}

export function clampLinesBetweenQueries(value: unknown): number {
    const lines = typeof value === 'number' ? value : 1;
    if (!Number.isFinite(lines)) {
        return 1;
    }
    return Math.max(0, Math.min(5, Math.floor(lines)));
}

export function formatStyleOf(config: {
    formatKeywordCase: FormatKeywordCase;
    formatFunctionCase: FormatCaseChoice;
    formatDataTypeCase: FormatCaseChoice;
    formatTabWidth: number;
    formatUseTabs: boolean;
    formatLogicalOperatorNewline: FormatLogicalNewline;
    formatExpressionWidth: number;
    formatLinesBetweenQueries: number;
    formatDenseOperators: boolean;
    formatNewlineBeforeSemicolon: boolean;
}): FormatStyle {
    return {
        keywordCase: config.formatKeywordCase,
        functionCase: config.formatFunctionCase,
        dataTypeCase: config.formatDataTypeCase,
        tabWidth: config.formatTabWidth,
        useTabs: config.formatUseTabs,
        logicalOperatorNewline: config.formatLogicalOperatorNewline,
        expressionWidth: config.formatExpressionWidth,
        linesBetweenQueries: config.formatLinesBetweenQueries,
        denseOperators: config.formatDenseOperators,
        newlineBeforeSemicolon: config.formatNewlineBeforeSemicolon
    };
}

function resolveFormatCase(
    choice: FormatCaseChoice | undefined,
    keywordCase: FormatKeywordCase
): FormatKeywordCase {
    if (!choice || choice === 'keyword') {
        return keywordCase;
    }
    return choice;
}

export function dialectForEngine(engine: string): FormatDialect {
    if (engine === 'mysql') {
        return 'mysql';
    }
    if (engine === 'postgres') {
        return 'postgresql';
    }
    if (engine === 'bigquery') {
        return 'bigquery';
    }
    return 'tsql';
}

/**
 * Pretty-print SQL that lives inside one Python string.
 * Callers replace only the string content; quotes stay untouched.
 * Table and column names stay as written.
 * Function and type case follow keywords unless those settings say otherwise.
 */
export function formatEmbeddedSql(
    content: string,
    options: FormatEmbeddedSqlOptions
): FormatEmbeddedSqlResult {
    if (content.trim().length === 0) {
        return { ok: true, text: content };
    }

    const tabWidth = Number.isFinite(options.tabWidth)
        ? Math.max(1, Math.min(8, Math.floor(options.tabWidth)))
        : 4;
    const indent =
        options.anchorIndent !== undefined
            ? options.anchorIndent
            : detectBaseIndent(content);
    const protectedSql = protectPlaceholders(content, options.isFString);

    let formatted: string;
    try {
        formatted = formatSql(protectedSql.text, {
            language: options.dialect as SqlLanguage,
            tabWidth,
            useTabs: options.useTabs === true || indent.includes('\t'),
            keywordCase: options.keywordCase,
            dataTypeCase: resolveFormatCase(options.dataTypeCase, options.keywordCase),
            functionCase: resolveFormatCase(options.functionCase, options.keywordCase),
            logicalOperatorNewline: options.logicalOperatorNewline ?? 'before',
            expressionWidth: clampExpressionWidth(options.expressionWidth),
            linesBetweenQueries: clampLinesBetweenQueries(options.linesBetweenQueries),
            denseOperators: options.denseOperators === true,
            newlineBeforeSemicolon: options.newlineBeforeSemicolon === true,
            identifierCase: 'preserve',
            paramTypes: {
                positional: true,
                named: [':'],
                custom: [{ regex: '%[sdfi]' }]
            }
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
    }

    const restored = restorePlaceholders(formatted, protectedSql.tokens);
    const text = options.isTripleQuoted
        ? applyTripleQuoteLayout(content, restored, indent)
        : collapseToSingleLine(restored);
    return { ok: true, text };
}

/**
 * Indent for SQL lines that start after a newline.
 * If `linePrefix` is only tabs/spaces, keep it as written.
 * If SQL sits after other code on the same line (`sql = """SELECT`), pad to
 * that visual column so new lines do not jump to column 0.
 */
export function anchorIndentFromLinePrefix(linePrefix: string, tabWidth: number): string {
    if (linePrefix.length === 0) {
        return '';
    }
    if (!/[^ \t]/.test(linePrefix)) {
        return linePrefix;
    }
    const width = Number.isFinite(tabWidth) ? Math.max(1, Math.floor(tabWidth)) : 4;
    let col = 0;
    for (const ch of linePrefix) {
        col += ch === '\t' ? width - (col % width) : 1;
    }
    return ' '.repeat(col);
}

function protectPlaceholders(
    content: string,
    isFString: boolean
): { text: string; tokens: string[] } {
    const tokens: string[] = [];
    let out = '';
    let i = 0;

    const pushToken = (original: string): void => {
        const token = `${TOKEN_PREFIX}${tokens.length}${TOKEN_SUFFIX}`;
        tokens.push(original);
        out += token;
    };

    while (i < content.length) {
        if (isFString && content[i] === '{') {
            if (content[i + 1] === '{') {
                out += '{{';
                i += 2;
                continue;
            }
            const end = skipFStringExpression(content, i);
            pushToken(content.slice(i, end));
            i = end;
            continue;
        }

        if (content[i] === '%' && content[i + 1] === '(') {
            const close = content.indexOf(')s', i + 2);
            if (close !== -1) {
                pushToken(content.slice(i, close + 2));
                i = close + 2;
                continue;
            }
        }

        out += content[i];
        i++;
    }

    return { text: out, tokens };
}

function restorePlaceholders(formatted: string, tokens: string[]): string {
    let result = formatted;
    for (let i = 0; i < tokens.length; i++) {
        const token = `${TOKEN_PREFIX}${i}${TOKEN_SUFFIX}`;
        result = result.split(token).join(tokens[i]);
    }
    return result;
}

function detectBaseIndent(content: string): string {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
        if (line.trim().length === 0) {
            continue;
        }
        const match = line.match(/^[ \t]*/);
        return match ? match[0] : '';
    }
    return '    ';
}

function shouldIndentFirstLine(content: string): boolean {
    const normalized = content.replace(/\r\n/g, '\n');
    if (normalized.startsWith('\n')) {
        return true;
    }
    const first = normalized.split('\n').find((line) => line.trim().length > 0);
    return first !== undefined && /^[ \t]/.test(first);
}

function applyTripleQuoteLayout(
    original: string,
    formattedSql: string,
    indent: string
): string {
    const nl = original.includes('\r\n') ? '\r\n' : '\n';
    const normalized = original.replace(/\r\n/g, '\n');
    const startsWithNl = normalized.startsWith('\n');
    const trailingMatch = normalized.match(/\n([ \t]*)$/);
    const indentFirstLine = shouldIndentFirstLine(normalized);
    const sqlLines = formattedSql.replace(/\r\n/g, '\n').trim().split('\n');
    const body = sqlLines
        .map((line, i) => {
            const pad = i === 0 && !indentFirstLine ? '' : indent;
            return line.length === 0 ? pad : pad + line;
        })
        .join(nl);

    let result = '';
    if (startsWithNl) {
        result += nl;
    }
    result += body;
    if (trailingMatch) {
        result += nl + trailingMatch[1];
    }
    return result;
}

function collapseToSingleLine(formattedSql: string): string {
    return formattedSql
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' ');
}
