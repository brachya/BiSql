/**
 * Advances past an f-string `{...}` expression, respecting nested braces and
 * nested string literals inside the expression.
 */
export function skipFStringExpression(text: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '{') {
            depth++;
            i++;
            continue;
        }
        if (ch === '}') {
            depth--;
            i++;
            if (depth === 0) {
                return i;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            const isTriple = text[i + 1] === ch && text[i + 2] === ch;
            const quoteLen = isTriple ? 3 : 1;
            i += quoteLen;
            while (i < text.length) {
                if (text[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (isTriple) {
                    if (text[i] === ch && text[i + 1] === ch && text[i + 2] === ch) {
                        i += 3;
                        break;
                    }
                } else if (text[i] === ch) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        i++;
    }
    return i;
}
