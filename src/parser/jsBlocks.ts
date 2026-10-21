import * as vscode from 'vscode';
import { canStartRegex, skipJsRegex } from './fString';
import { classifyEmbeddedSqlGroup, stripTrailingTypeArgs } from './sqlHostRules';
import { isIdentPart, isIdentStart } from './normalizeSql';

export interface JsStringLiteral {
    quoteStart: number;
    quoteEnd: number;
    contentStart: number;
    contentEnd: number;
    content: string;
    quote: '"' | "'" | '`';
    isTemplate: boolean;
    /** Tagged template: source slice `[tagStart, quoteStart)` without trailing `<Type>`. */
    templateTag?: string;
    tagStart?: number;
}

function skipLineComment(text: string, i: number): number {
    let j = i + 2;
    while (j < text.length && text[j] !== '\n') {
        j++;
    }
    return j;
}

function skipBlockComment(text: string, i: number): number {
    let j = i + 2;
    while (j + 1 < text.length && !(text[j] === '*' && text[j + 1] === '/')) {
        j++;
    }
    return j + 2 <= text.length ? j + 2 : text.length;
}

function skipTemplateExpression(text: string, start: number, isJsx: boolean): number {
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
        if (ch === '/' && text[i + 1] === '/') {
            i = skipLineComment(text, i);
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            i = skipBlockComment(text, i);
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipStringLike(text, i, isJsx, false).end;
            continue;
        }
        if (ch === '/' && canStartRegex(text, i)) {
            i = skipJsRegex(text, i);
            continue;
        }
        if (isJsx && ch === '<' && depth > 0) {
            i = skipJsxTag(text, i);
            continue;
        }
        i++;
    }
    return i;
}

function charBeforeNonSpace(text: string, index: number): number {
    let j = index - 1;
    while (j >= 0 && /[\s\n\r]/.test(text[j])) {
        j--;
    }
    return j;
}

/** True when `<` starts JSX, not `a < b` or `Array<string>`. */
function looksLikeJsxOpen(text: string, ltIndex: number): boolean {
    const prev = charBeforeNonSpace(text, ltIndex);
    if (prev < 0) {
        return true;
    }
    const prevCh = text[prev];
    if ('([{=:;,!?&|+-~*'.includes(prevCh)) {
        return true;
    }
    if (prevCh === '>' || prevCh === '/') {
        return true;
    }
    if (isIdentPart(prevCh)) {
        let k = prev;
        while (k >= 0 && isIdentPart(text[k])) {
            k--;
        }
        const word = text.slice(k + 1, prev + 1);
        if (/^(return|throw|else|case|default|do|yield|await)$/.test(word)) {
            return true;
        }
        return false;
    }
    const next = text[ltIndex + 1];
    if (next === '/') {
        return isIdentStart(text[ltIndex + 2] ?? '');
    }
    return next === '>' || isIdentStart(next ?? '') || next === '!' || next === '?';
}

function skipJsxTag(text: string, ltIndex: number): number {
    let i = ltIndex + 1;
    if (text[i] === '/') {
        i++;
    }
    while (i < text.length && isIdentPart(text[i])) {
        i++;
    }
    while (i < text.length) {
        const ch = text[i];
        if (ch === '>') {
            return i + 1;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipStringLike(text, i, true, false).end;
            continue;
        }
        if (ch === '{') {
            i = skipTemplateExpression(text, i, true);
            continue;
        }
        i++;
    }
    return text.length;
}

interface SkipStringResult {
    end: number;
    literal?: JsStringLiteral;
}

function skipStringLike(
    text: string,
    start: number,
    isJsx: boolean,
    emitLiteral: boolean
): SkipStringResult {
    const quote = text[start] as '"' | "'" | '`';
    if (quote !== '"' && quote !== "'" && quote !== '`') {
        return { end: start + 1 };
    }

    let tagStart: number | undefined;
    let templateTag: string | undefined;
    let quoteStart = start;

    if (quote === '`') {
        const prev = charBeforeNonSpace(text, start);
        if (prev >= 0 && (isIdentPart(text[prev]) || text[prev] === '>')) {
            let k = prev;
            while (
                k >= 0 &&
                (isIdentPart(text[k]) ||
                    text[k] === '.' ||
                    text[k] === '$' ||
                    text[k] === '>' ||
                    text[k] === '<')
            ) {
                k--;
            }
            const candidate = text.slice(k + 1, start).trim();
            const tag = stripTrailingTypeArgs(candidate);
            if (/^(?:[\w$]+(?:\.[\w$]+)*)$/.test(tag)) {
                tagStart = k + 1;
                templateTag = tag;
            }
        }
    }

    const contentStart = start + 1;
    let i = contentStart;
    const isTemplate = quote === '`';

    while (i < text.length) {
        const ch = text[i];
        if (!isTemplate && ch === quote) {
            const quoteEnd = i + 1;
            const literal: JsStringLiteral | undefined = emitLiteral
                ? {
                      quoteStart,
                      quoteEnd,
                      contentStart,
                      contentEnd: i,
                      content: text.slice(contentStart, i),
                      quote,
                      isTemplate: false,
                      templateTag,
                      tagStart
                  }
                : undefined;
            return { end: quoteEnd, literal };
        }
        if (isTemplate && ch === '`') {
            const quoteEnd = i + 1;
            const literal: JsStringLiteral | undefined = emitLiteral
                ? {
                      quoteStart,
                      quoteEnd,
                      contentStart,
                      contentEnd: i,
                      content: text.slice(contentStart, i),
                      quote: '`',
                      isTemplate: true,
                      templateTag,
                      tagStart
                  }
                : undefined;
            return { end: quoteEnd, literal };
        }
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (isTemplate && ch === '$' && text[i + 1] === '{') {
            i = skipTemplateExpression(text, i + 1, isJsx);
            continue;
        }
        i++;
    }

    const quoteEnd = text.length;
    const literal: JsStringLiteral | undefined = emitLiteral
        ? {
              quoteStart,
              quoteEnd,
              contentStart,
              contentEnd: text.length,
              content: text.slice(contentStart, text.length),
              quote: isTemplate ? '`' : quote,
              isTemplate,
              templateTag,
              tagStart
          }
        : undefined;
    return { end: quoteEnd, literal };
}

export function tokenizeJsStrings(text: string, isJsx = false): JsStringLiteral[] {
    const results: JsStringLiteral[] = [];
    scanCode(text, 0, text.length, isJsx, results, false);
    return results;
}

/**
 * Scan JS. When `expressionBrace` is true, `start` points at `{` and the
 * scan stops at the matching `}`.
 */
function scanCode(
    text: string,
    start: number,
    end: number,
    isJsx: boolean,
    results: JsStringLiteral[],
    expressionBrace: boolean
): number {
    let i = expressionBrace ? start + 1 : start;
    let brace = expressionBrace ? 1 : 0;
    while (i < end) {
        const ch = text[i];
        if (ch === '/' && text[i + 1] === '/') {
            i = skipLineComment(text, i);
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            i = skipBlockComment(text, i);
            continue;
        }
        if (isJsx && ch === '<' && looksLikeJsxOpen(text, i)) {
            i = scanJsxElement(text, i, results);
            continue;
        }
        if (ch === '/' && canStartRegex(text, i)) {
            i = skipJsRegex(text, i);
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            const skipped = skipStringLike(text, i, isJsx, true);
            if (skipped.literal) {
                results.push(skipped.literal);
            }
            i = skipped.end;
            continue;
        }
        if (expressionBrace && ch === '{') {
            brace++;
            i++;
            continue;
        }
        if (expressionBrace && ch === '}') {
            brace--;
            i++;
            if (brace === 0) {
                return i;
            }
            continue;
        }
        i++;
    }
    return i;
}

/** `<T,>` and `<T extends U>` are types. `<div>` is an element. */
function isTypeArgument(text: string, ltIndex: number): boolean {
    let i = ltIndex + 1;
    if (!isIdentStart(text[i] ?? '')) {
        return false;
    }
    while (isIdentPart(text[i] ?? '')) {
        i++;
    }
    while (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r') {
        i++;
    }
    if (text[i] === ',') {
        return true;
    }
    return text.slice(i, i + 'extends'.length) === 'extends';
}

/** `<div>Don't</div>` — quotes in text are not JS strings. `{...}` still is. */
function scanJsxElement(text: string, ltIndex: number, results: JsStringLiteral[]): number {
    if (text[ltIndex + 1] === '/' || isTypeArgument(text, ltIndex)) {
        return skipJsxTag(text, ltIndex);
    }
    const afterTag = skipJsxTag(text, ltIndex);
    if (afterTag >= 2 && text[afterTag - 2] === '/') {
        return afterTag;
    }
    let i = afterTag;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '<') {
            const next = text[i + 1] ?? '';
            if (next === '/') {
                return skipJsxTag(text, i);
            }
            if (next === '>' || isIdentStart(next)) {
                i = scanJsxElement(text, i, results);
                continue;
            }
        }
        if (ch === '{') {
            i = scanCode(text, i, text.length, true, results, true);
            continue;
        }
        i++;
    }
    return i;
}

function groupAdjacentLiterals(literals: JsStringLiteral[], source: string): JsStringLiteral[][] {
    if (literals.length === 0) {
        return [];
    }
    const groups: JsStringLiteral[][] = [[literals[0]]];
    for (let idx = 1; idx < literals.length; idx++) {
        const prev = literals[idx - 1];
        const curr = literals[idx];
        const between = source.slice(prev.quoteEnd, curr.quoteStart);
        if (/^[\s\n\r]*\+[\s\n\r]*$/.test(between)) {
            groups[groups.length - 1].push(curr);
        } else {
            groups.push([curr]);
        }
    }
    return groups;
}

function classifyJsGroup(group: JsStringLiteral[], source: string): boolean {
    const combined = group.map((literal) => literal.content).join('');
    const first = group[0];
    const lookbackStart =
        first.tagStart !== undefined ? Math.max(0, first.tagStart - 80) : Math.max(0, first.quoteStart - 120);
    const preceding = source.slice(lookbackStart, first.quoteStart);
    const templateTag =
        first.templateTag ??
        (first.tagStart !== undefined
            ? stripTrailingTypeArgs(source.slice(first.tagStart, first.quoteStart))
            : undefined);
    return classifyEmbeddedSqlGroup('javascript', {
        combinedContent: combined,
        preceding,
        templateTag
    });
}

export function extractJsSqlStringLiteralGroups(source: string, isJsx = false): JsStringLiteral[][] {
    const literals = tokenizeJsStrings(source, isJsx);
    return groupAdjacentLiterals(literals, source).filter((group) => classifyJsGroup(group, source));
}

export function extractJsSqlStringLiterals(document: vscode.TextDocument): JsStringLiteral[][] {
    const isJsx =
        document.languageId === 'javascriptreact' || document.languageId === 'typescriptreact';
    return extractJsSqlStringLiteralGroups(document.getText(), isJsx);
}

export function isJavascriptHostLanguage(languageId: string): boolean {
    return (
        languageId === 'javascript' ||
        languageId === 'typescript' ||
        languageId === 'javascriptreact' ||
        languageId === 'typescriptreact'
    );
}
