import { format as formatSql, type SqlLanguage } from 'sql-formatter';
import { skipFStringExpression } from '../parser/fString';

export type FormatKeywordCase = 'upper' | 'lower' | 'preserve';
export type FormatDialect = 'tsql' | 'mysql' | 'postgresql';

export interface FormatEmbeddedSqlOptions {
    dialect: FormatDialect;
    keywordCase: FormatKeywordCase;
    tabWidth: number;
    isFString: boolean;
    isTripleQuoted: boolean;
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

export function dialectForEngine(engine: string): FormatDialect {
    if (engine === 'mysql') {
        return 'mysql';
    }
    if (engine === 'postgres') {
        return 'postgresql';
    }
    return 'tsql';
}

/**
 * Pretty-print SQL that lives inside one Python string.
 * Callers replace only the string content; quotes stay untouched.
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
    const protectedSql = protectPlaceholders(content, options.isFString);

    let formatted: string;
    try {
        formatted = formatSql(protectedSql.text, {
            language: options.dialect as SqlLanguage,
            tabWidth,
            keywordCase: options.keywordCase,
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
        ? applyTripleQuoteLayout(content, restored)
        : collapseToSingleLine(restored);
    return { ok: true, text };
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

function applyTripleQuoteLayout(original: string, formattedSql: string): string {
    const nl = original.includes('\r\n') ? '\r\n' : '\n';
    const normalized = original.replace(/\r\n/g, '\n');
    const startsWithNl = normalized.startsWith('\n');
    const trailingMatch = normalized.match(/\n([ \t]*)$/);
    const indent = detectBaseIndent(normalized);
    const sqlLines = formattedSql.replace(/\r\n/g, '\n').trim().split('\n');
    const body = sqlLines
        .map((line) => (line.length === 0 ? indent : indent + line))
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
