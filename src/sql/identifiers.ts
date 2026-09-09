/**
 * Strips [] or "" or `` quoting from a single identifier part.
 */
export function unquoteIdentifier(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/\]\]/g, ']');
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/``/g, '`');
    }
    return trimmed;
}

/**
 * Splits a possibly qualified reference into its parts, respecting quoting.
 * Accepts Users, dbo.Users, [dbo].[Users], `db`.`users`.
 */
export function splitIdentifier(reference: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inBracket = false;
    let inQuote = false;
    let inBacktick = false;
    for (let i = 0; i < reference.length; i++) {
        const ch = reference[i];
        if (inBracket) {
            if (ch === ']') {
                if (reference[i + 1] === ']') {
                    current += ']';
                    i++;
                } else {
                    inBracket = false;
                    current += ch;
                }
            } else {
                current += ch;
            }
            continue;
        }
        if (inQuote) {
            if (ch === '"') {
                if (reference[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuote = false;
                    current += ch;
                }
            } else {
                current += ch;
            }
            continue;
        }
        if (inBacktick) {
            if (ch === '`') {
                if (reference[i + 1] === '`') {
                    current += '`';
                    i++;
                } else {
                    inBacktick = false;
                    current += ch;
                }
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === '[') {
            inBracket = true;
            current += ch;
        } else if (ch === '"') {
            inQuote = true;
            current += ch;
        } else if (ch === '`') {
            inBacktick = true;
            current += ch;
        } else if (ch === '.') {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts.map(unquoteIdentifier);
}
