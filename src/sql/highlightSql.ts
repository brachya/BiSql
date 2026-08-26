import { isSqlFunctionName } from './functions';

export const SQL_KEYWORDS = new Set([
    'select',
    'from',
    'where',
    'and',
    'or',
    'not',
    'insert',
    'update',
    'delete',
    'into',
    'values',
    'join',
    'left',
    'right',
    'inner',
    'outer',
    'full',
    'cross',
    'on',
    'as',
    'set',
    'group',
    'by',
    'order',
    'having',
    'limit',
    'offset',
    'top',
    'distinct',
    'union',
    'all',
    'except',
    'intersect',
    'case',
    'when',
    'then',
    'else',
    'end',
    'in',
    'is',
    'null',
    'like',
    'between',
    'exists',
    'create',
    'alter',
    'drop',
    'table',
    'view',
    'index',
    'with',
    'over',
    'partition',
    'asc',
    'desc',
    'fetch',
    'next',
    'rows',
    'only',
    'declare',
    'begin',
    'commit',
    'rollback',
    'if',
    'while',
    'exec',
    'execute',
    'return',
    'function',
    'procedure',
    'true',
    'false',
    'using',
    'natural',
    'apply',
    'pivot',
    'unpivot'
]);

export function inferSqlValueClass(value: string): string {
    if (/^(true|false|null)$/i.test(value)) {
        return 'kw';
    }
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
        return 'num';
    }
    return 'str';
}

/**
 * Lightweight SQL coloring for the results panel. Keep the webview copy in
 * resultsPanel.ts in sync with this scanner.
 */
export function highlightSql(sql: string): string {
    const out: string[] = [];
    const n = sql.length;
    let i = 0;
    while (i < n) {
        const ch = sql[i];
        if (ch === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const take = end === -1 ? sql.slice(i) : sql.slice(i, end);
            out.push(`<span class="cm">${escapeHtml(take)}</span>`);
            i += take.length;
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const take = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
            out.push(`<span class="cm">${escapeHtml(take)}</span>`);
            i += take.length;
            continue;
        }
        if (ch === "'" || ch === '"') {
            let j = i + 1;
            while (j < n) {
                if (sql[j] === ch) {
                    if (sql[j + 1] === ch) {
                        j += 2;
                        continue;
                    }
                    j += 1;
                    break;
                }
                j += 1;
            }
            out.push(`<span class="str">${escapeHtml(sql.slice(i, j))}</span>`);
            i = j;
            continue;
        }
        if (ch === ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
            let j = i + 2;
            while (j < n && /[A-Za-z0-9_]/.test(sql[j])) {
                j += 1;
            }
            out.push(`<span class="param">${escapeHtml(sql.slice(i, j))}</span>`);
            i = j;
            continue;
        }
        if (/\d/.test(ch) && (i === 0 || !/[A-Za-z_]/.test(sql[i - 1] ?? ''))) {
            let j = i;
            while (j < n && /[\d.]/.test(sql[j])) {
                j += 1;
            }
            out.push(`<span class="num">${escapeHtml(sql.slice(i, j))}</span>`);
            i = j;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(sql[j])) {
                j += 1;
            }
            const word = sql.slice(i, j);
            const lower = word.toLowerCase();
            if (SQL_KEYWORDS.has(lower)) {
                out.push(`<span class="kw">${escapeHtml(word)}</span>`);
            } else if (isSqlFunctionName(lower)) {
                out.push(`<span class="fn">${escapeHtml(word)}</span>`);
            } else {
                out.push(escapeHtml(word));
            }
            i = j;
            continue;
        }
        out.push(escapeHtml(ch));
        i += 1;
    }
    return out.join('');
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
