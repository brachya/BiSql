/** Which embedded host language classified a string group. */
export type EmbeddedSqlHost = 'python' | 'javascript';

const SQL_MARKER = /(?:--\s*sql\b|\/\*\s*sql\s*\*\/)/i;

/** Python: optional `(` and string prefix before the quote. */
const PYTHON_ASSIGN_TAIL =
    /([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*\w+\s*)?=\s*\(?\s*[rRfFbBuU]*$/;

/** TS/JS: optional type annotation before `=`. The type stays on one line. */
const JS_ASSIGN_TAIL = /([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\r\n]*)?=\s*$/;

const PYTHON_CALL_RE =
    /\.\s*(execute|executemany|read_sql|read_sql_query)\s*\(\s*[rRfFbBuU]*$|\btext\s*\(\s*[rRfFbBuU]*$/;

const JS_CALL_NAME_RE = /\.\s*(query|execute|raw)$/;

/** `update_query`, `query`, `raw_sql`, `sql_text`. Not `sqlite` / `sqlalchemy`. */
export function looksLikeSqlAssignName(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower === 'sqlite' || lower.startsWith('sqlite_') || lower.startsWith('sqlalchemy')) {
        return false;
    }
    if (lower.includes('query') || lower.includes('stmt') || lower.includes('statement')) {
        return true;
    }
    return lower === 'sql' || /(?:^|_)sql(?:_|$|\d)/.test(lower);
}

/**
 * JS/TS assignment names: `query`, `user_query`, `sql_text`.
 * Not camelCase compounds such as `queryKey` or `mediaQuery`.
 */
export function looksLikeJsSqlAssignName(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower === 'sqlite' || lower.startsWith('sqlite_') || lower.startsWith('sqlalchemy')) {
        return false;
    }
    return /^(?:[a-z0-9]+_)*(?:sql|query|stmt|statement)(?:_[a-z0-9]+|\d+)*$/.test(lower);
}

/** Drop a trailing `<...>` type argument list, including nested `<>`. */
export function stripTrailingTypeArgs(text: string): string {
    const end = text.trimEnd();
    if (!end.endsWith('>')) {
        return text.trim();
    }
    let depth = 0;
    for (let i = end.length - 1; i >= 0; i--) {
        if (end[i] === '>') {
            depth++;
        } else if (end[i] === '<') {
            depth--;
            if (depth === 0) {
                return end.slice(0, i).trim();
            }
        }
    }
    return text.trim();
}

export function hasSqlContentMarker(combinedContent: string): boolean {
    return SQL_MARKER.test(combinedContent);
}

function assignNameFromPreceding(host: EmbeddedSqlHost, preceding: string): string | null {
    const re = host === 'python' ? PYTHON_ASSIGN_TAIL : JS_ASSIGN_TAIL;
    const match = re.exec(preceding);
    return match ? match[1] : null;
}

function callSiteMatch(host: EmbeddedSqlHost, preceding: string): boolean {
    if (host === 'python') {
        return PYTHON_CALL_RE.test(preceding);
    }
    return endsWithJsSqlCall(preceding);
}

/** `.query(`, `.execute<T>(`, `.raw<Array<User>>(`, including nested `<>`. */
function endsWithJsSqlCall(preceding: string): boolean {
    let i = preceding.length - 1;
    while (i >= 0 && /\s/.test(preceding[i])) {
        i--;
    }
    if (i < 0 || preceding[i] !== '(') {
        return false;
    }
    i--;
    while (i >= 0 && /\s/.test(preceding[i])) {
        i--;
    }
    if (i >= 0 && preceding[i] === '>') {
        let depth = 0;
        let typeStart = -1;
        for (let j = i; j >= 0; j--) {
            if (preceding[j] === '>') {
                depth++;
            } else if (preceding[j] === '<') {
                depth--;
                if (depth === 0) {
                    typeStart = j;
                    break;
                }
            }
        }
        if (typeStart < 0) {
            return false;
        }
        i = typeStart - 1;
        while (i >= 0 && /\s/.test(preceding[i])) {
            i--;
        }
    }
    return JS_CALL_NAME_RE.test(preceding.slice(0, i + 1));
}

/** Tagged template: `sql`, `Prisma.sql`, `$queryRaw`, `$executeRawUnsafe`, etc. */
export function looksLikeSqlTemplateTag(tagText: string): boolean {
    const tag = stripTrailingTypeArgs(tagText.trim());
    if (tag.length === 0) {
        return false;
    }
    const member = tag.includes('.') ? tag.slice(tag.lastIndexOf('.') + 1) : tag;
    if (/^\$queryRaw(?:Unsafe)?$/i.test(member) || /^\$executeRaw(?:Unsafe)?$/i.test(member)) {
        return true;
    }
    if (member === 'sql' || member === 'query') {
        return true;
    }
    return looksLikeJsSqlAssignName(member);
}

export interface ClassifyEmbeddedSqlInput {
    combinedContent: string;
    /** Source text immediately before the opening quote or tag. */
    preceding: string;
    /** Full tag expression for tagged templates (e.g. `prisma.$queryRaw<User>`). */
    templateTag?: string;
}

/**
 * True when a grouped string literal should be treated as SQL for this host.
 * Scanners find ranges; this module decides SQL vs plain string.
 */
export function classifyEmbeddedSqlGroup(
    host: EmbeddedSqlHost,
    input: ClassifyEmbeddedSqlInput
): boolean {
    if (hasSqlContentMarker(input.combinedContent)) {
        return true;
    }
    if (host === 'javascript' && input.templateTag !== undefined) {
        if (looksLikeSqlTemplateTag(input.templateTag)) {
            return true;
        }
    }
    const assignName = assignNameFromPreceding(host, input.preceding);
    if (assignName !== null) {
        const named =
            host === 'javascript'
                ? looksLikeJsSqlAssignName(assignName)
                : looksLikeSqlAssignName(assignName);
        if (named) {
            return true;
        }
    }
    return callSiteMatch(host, input.preceding);
}
