/** True when `text[index]` is preceded by an odd number of backslashes. */
export function isCharEscaped(text: string, index: number): boolean {
    let slashes = 0;
    for (let j = index - 1; j >= 0 && text[j] === '\\'; j--) {
        slashes++;
    }
    return slashes % 2 === 1;
}

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

const REGEX_WORD = /^(?:return|throw|case|in|of|typeof|void|delete|await|yield|new|else)$/;

function isScanIdentPart(ch: string): boolean {
    return (
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= 'a' && ch <= 'z') ||
        ch === '_' ||
        (ch >= '0' && ch <= '9')
    );
}

function charBeforeNonSpace(text: string, index: number): number {
    let j = index - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) {
        j--;
    }
    return j;
}

function wordEndingAt(text: string, index: number): { word: string; start: number } | null {
    if (!isScanIdentPart(text[index] ?? '')) {
        return null;
    }
    let k = index;
    while (k >= 0 && isScanIdentPart(text[k])) {
        k--;
    }
    return { word: text.slice(k + 1, index + 1), start: k + 1 };
}

/**
 * ponytail: counts brackets only. A string that contains the same bracket
 * (`if (")")`) can pick the wrong pair. Upgrade path: skip strings while scanning.
 */
function matchOpener(text: string, closeIndex: number, open: string, close: string): number {
    let depth = 0;
    for (let j = closeIndex; j >= 0; j--) {
        if (text[j] === close) {
            depth++;
        } else if (text[j] === open) {
            depth--;
            if (depth === 0) {
                return j;
            }
        }
    }
    return -1;
}

/** `x = function () {} / 2` is division. `function f() {}` then `/re/` is a regex. */
function functionIsExpression(text: string, functionStart: number): boolean {
    let j = charBeforeNonSpace(text, functionStart);
    const prevWord = j >= 0 ? wordEndingAt(text, j) : null;
    if (prevWord?.word === 'async') {
        j = charBeforeNonSpace(text, prevWord.start);
    }
    if (j < 0) {
        return false;
    }
    return '=(,[{?:&|+-*%^~!'.includes(text[j]);
}

function parenIsBlockHeader(text: string, closeParen: number): boolean {
    const open = matchOpener(text, closeParen, '(', ')');
    if (open < 0) {
        return false;
    }
    const before = charBeforeNonSpace(text, open);
    const intro = before >= 0 ? wordEndingAt(text, before) : null;
    if (!intro) {
        return false;
    }
    if (/^(?:if|while|for|with|catch|switch)$/.test(intro.word)) {
        return true;
    }
    if (intro.word === 'function') {
        return !functionIsExpression(text, intro.start);
    }
    const beforeName = charBeforeNonSpace(text, intro.start);
    const keyword = beforeName >= 0 ? wordEndingAt(text, beforeName) : null;
    if (keyword?.word === 'function') {
        return !functionIsExpression(text, keyword.start);
    }
    return false;
}

/** `if (ok) /re/` and `function f() {} \n /re/` are regexes. `(a + b) / 2` is division. */
function closerAllowsRegex(text: string, closerIndex: number): boolean {
    const closer = text[closerIndex];
    const open = matchOpener(text, closerIndex, closer === ')' ? '(' : '{', closer);
    if (open < 0) {
        return false;
    }
    const prev = charBeforeNonSpace(text, open);
    if (prev < 0) {
        return closer === '}';
    }
    if (closer === ')') {
        const word = wordEndingAt(text, prev);
        return word !== null && /^(?:if|while|for|with)$/.test(word.word);
    }
    const word = wordEndingAt(text, prev);
    if (word && /^(?:else|try|do|finally)$/.test(word.word)) {
        return true;
    }
    return text[prev] === ')' && parenIsBlockHeader(text, prev);
}

/**
 * True when `/` starts a regex, not division.
 * ponytail: `)` and `}` use a bracket walk, not a full parse.
 */
export function canStartRegex(text: string, slashIndex: number): boolean {
    let j = slashIndex - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) {
        j--;
    }
    if (j < 0) {
        return true;
    }
    const ch = text[j];
    if ((ch === '+' || ch === '-') && j > 0 && text[j - 1] === ch) {
        return false;
    }
    if (ch === ')' || ch === '}') {
        return closerAllowsRegex(text, j);
    }
    if ('([{=:;,!?&|+-~^*/<>'.includes(ch)) {
        return true;
    }
    const word = wordEndingAt(text, j);
    return word !== null && REGEX_WORD.test(word.word);
}

/** Consume `/.../flags`. `start` points at the opening slash. */
export function skipJsRegex(text: string, start: number): number {
    let i = start + 1;
    let inClass = false;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '[') {
            inClass = true;
            i++;
            continue;
        }
        if (ch === ']' && inClass) {
            inClass = false;
            i++;
            continue;
        }
        if (ch === '/' && !inClass) {
            i++;
            while (i < text.length && /[a-z]/i.test(text[i])) {
                i++;
            }
            return i;
        }
        i++;
    }
    return text.length;
}

/**
 * Skip a JS template `${...}` starting at `{`.
 * Backticks, comments, strings, and regexes can contain `}` without ending the expression.
 */
export function skipJsTemplateExpression(text: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            i = skipJsTemplateString(text, i);
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            i += 2;
            while (i < text.length && text[i] !== '\n') {
                i++;
            }
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
                i++;
            }
            i = Math.min(i + 2, text.length);
            continue;
        }
        if (ch === '/' && canStartRegex(text, i)) {
            i = skipJsRegex(text, i);
            continue;
        }
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
        i++;
    }
    return i;
}

function skipJsTemplateString(text: string, start: number): number {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length) {
        if (text[i] === '\\') {
            i += 2;
            continue;
        }
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{' && !isCharEscaped(text, i)) {
            i = skipJsTemplateExpression(text, i + 1);
            continue;
        }
        if (text[i] === quote) {
            return i + 1;
        }
        i++;
    }
    return i;
}
