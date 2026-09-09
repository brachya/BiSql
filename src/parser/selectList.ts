import { SQL_KEYWORDS, SqlToken, tokenizeSql } from './sqlTokens';

export type SelectListItem =
    | { kind: 'star' }
    | { kind: 'qualifiedStar'; qualifier: string }
    | { kind: 'column'; name: string; qualifier?: string }
    | { kind: 'expr'; alias?: string };

export interface SelectListSpan {
    items: SelectListItem[];
    /** First token index of the SELECT list items (after DISTINCT / TOP). */
    itemStart: number;
    /** Token index of FROM / INTO / UNION / `)` / end. */
    itemEnd: number;
}

/** Result-grid mapping. Alias is stripped; expressions stay expressions. */
export type EditSelectItem =
    | { kind: 'star'; qualifier?: string }
    | { kind: 'column'; qualifier?: string; column: string }
    | { kind: 'expression' };

/**
 * Top-level SELECT list items in `tokens[start, end)`. Stops at UNION / first FROM.
 */
export function parseSelectItems(
    tokens: SqlToken[],
    start = 0,
    end = tokens.length
): SelectListItem[] {
    return findSelectListInRange(tokens, start, end)?.items ?? [];
}

/**
 * Every SELECT list in the batch, including CTE bodies and subqueries.
 */
export function collectSelectLists(tokens: SqlToken[]): SelectListSpan[] {
    const lists: SelectListSpan[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'keyword' || tokens[i].value.toLowerCase() !== 'select') {
            continue;
        }
        const span = parseSelectListFrom(tokens, i + 1, tokens.length);
        if (span && span.itemStart < span.itemEnd) {
            lists.push(span);
        }
    }
    return lists;
}

export function collectEditSelectItems(sql: string): EditSelectItem[] {
    const tokens = tokenizeSql(sql);
    let i = 0;
    while (i < tokens.length) {
        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'select') {
            i++;
            break;
        }
        i++;
    }
    if (i >= tokens.length) {
        return [];
    }
    const start = skipSelectListPrefix(tokens, i, tokens.length);
    if (start === undefined) {
        return [];
    }
    return splitSelectItemGroups(tokens, start, tokens.length, SELECT_ITEM_END).map(
        classifyEditSelectItem
    );
}

function findSelectListInRange(
    tokens: SqlToken[],
    start: number,
    end: number
): SelectListSpan | undefined {
    let i = start;
    let depth = 0;
    while (i < end) {
        if (tokens[i].text === '(') {
            depth++;
        } else if (tokens[i].text === ')') {
            depth = Math.max(0, depth - 1);
        } else if (
            depth === 0 &&
            tokens[i].kind === 'keyword' &&
            tokens[i].value.toLowerCase() === 'select'
        ) {
            return parseSelectListFrom(tokens, i + 1, end);
        }
        i++;
    }
    return undefined;
}

function parseSelectListFrom(
    tokens: SqlToken[],
    from: number,
    end: number
): SelectListSpan | undefined {
    let i = skipSelectListPrefix(tokens, from, end);
    if (i === undefined) {
        return undefined;
    }

    const itemStart = i;
    const items: SelectListItem[] = [];
    while (i < end) {
        const lower = tokens[i].value.toLowerCase();
        if (tokens[i].kind === 'keyword' && (lower === 'from' || lower === 'into' || lower === 'union')) {
            break;
        }
        if (tokens[i].text === ')') {
            break;
        }

        const itemTokens: SqlToken[] = [];
        let itemDepth = 0;
        while (i < end) {
            const tok = tokens[i];
            const itemLower = tok.value.toLowerCase();
            if (tok.text === '(') {
                itemDepth++;
                itemTokens.push(tok);
                i++;
                continue;
            }
            if (tok.text === ')') {
                if (itemDepth === 0) {
                    break;
                }
                itemDepth--;
                itemTokens.push(tok);
                i++;
                continue;
            }
            if (itemDepth === 0 && tok.text === ',') {
                i++;
                break;
            }
            if (
                itemDepth === 0 &&
                tok.kind === 'keyword' &&
                (itemLower === 'from' || itemLower === 'into' || itemLower === 'union')
            ) {
                break;
            }
            itemTokens.push(tok);
            i++;
        }
        if (itemTokens.length > 0) {
            items.push(classifySelectItem(itemTokens));
        }
    }
    return { items, itemStart, itemEnd: i };
}

function skipSelectListPrefix(
    tokens: SqlToken[],
    from: number,
    end: number
): number | undefined {
    let i = from;
    if (i >= end) {
        return undefined;
    }

    while (i < end) {
        const lower = tokens[i].value.toLowerCase();
        if (tokens[i].kind === 'keyword' && (lower === 'distinct' || lower === 'all')) {
            i++;
            continue;
        }
        if (tokens[i].kind === 'keyword' && lower === 'top') {
            i++;
            if (i < end && tokens[i].kind === 'number') {
                i++;
            }
            if (i < end && tokens[i].value.toLowerCase() === 'percent') {
                i++;
            }
            continue;
        }
        break;
    }
    return i;
}

function splitSelectItemGroups(
    tokens: SqlToken[],
    start: number,
    end: number,
    extraStops?: Set<string>
): SqlToken[][] {
    const groups: SqlToken[][] = [];
    let i = start;
    while (i < end) {
        if (isSelectItemStop(tokens[i], extraStops)) {
            break;
        }
        if (tokens[i].text === ')') {
            break;
        }

        const itemTokens: SqlToken[] = [];
        let itemDepth = 0;
        while (i < end) {
            const tok = tokens[i];
            if (tok.text === '(') {
                itemDepth++;
                itemTokens.push(tok);
                i++;
                continue;
            }
            if (tok.text === ')') {
                if (itemDepth === 0) {
                    break;
                }
                itemDepth--;
                itemTokens.push(tok);
                i++;
                continue;
            }
            if (itemDepth === 0 && tok.text === ',') {
                i++;
                break;
            }
            if (itemDepth === 0 && isSelectItemStop(tok, extraStops)) {
                break;
            }
            itemTokens.push(tok);
            i++;
        }
        if (itemTokens.length > 0) {
            groups.push(itemTokens);
        }
    }
    return groups;
}

function isSelectItemStop(tok: SqlToken, extraStops?: Set<string>): boolean {
    if (tok.kind !== 'keyword') {
        return false;
    }
    const lower = tok.value.toLowerCase();
    if (lower === 'from' || lower === 'into' || lower === 'union') {
        return true;
    }
    return extraStops ? extraStops.has(lower) : false;
}

function classifySelectItem(item: SqlToken[]): SelectListItem {
    const { body, alias } = stripSelectAlias(item);
    if (body.length === 1 && body[0].text === '*') {
        return { kind: 'star' };
    }
    if (
        body.length === 3 &&
        body[0].kind === 'ident' &&
        body[1].text === '.' &&
        body[2].text === '*'
    ) {
        return { kind: 'qualifiedStar', qualifier: body[0].value };
    }
    if (isDottedIdent(body)) {
        const idents = body.filter((tok) => tok.kind === 'ident');
        const name = alias ?? idents[idents.length - 1].value;
        const qualifier = idents.length >= 2 ? idents[idents.length - 2].value : undefined;
        return qualifier ? { kind: 'column', name, qualifier } : { kind: 'column', name };
    }
    if (alias) {
        return { kind: 'column', name: alias };
    }
    return { kind: 'expr' };
}

function classifyEditSelectItem(tokens: SqlToken[]): EditSelectItem {
    const expr = stripTrailingAlias(tokens);
    if (expr.length === 0) {
        return { kind: 'expression' };
    }
    if (expr.length === 1 && expr[0].text === '*') {
        return { kind: 'star' };
    }
    if (
        expr.length === 3 &&
        isNameToken(expr[0]) &&
        expr[1].text === '.' &&
        expr[2].text === '*'
    ) {
        return { kind: 'star', qualifier: expr[0].value };
    }
    if (isDottedName(expr)) {
        const names = expr.filter((tok) => isNameToken(tok)).map((tok) => tok.value);
        const column = names[names.length - 1];
        const qualifier = names.length >= 2 ? names[names.length - 2] : undefined;
        return { kind: 'column', column, qualifier };
    }
    return { kind: 'expression' };
}

function stripSelectAlias(item: SqlToken[]): { body: SqlToken[]; alias?: string } {
    if (item.length === 0) {
        return { body: item };
    }
    const last = item[item.length - 1];
    if (item.length >= 2) {
        const prev = item[item.length - 2];
        if (
            prev.kind === 'keyword' &&
            prev.value.toLowerCase() === 'as' &&
            last.kind === 'ident'
        ) {
            return { body: item.slice(0, -2), alias: last.value };
        }
        if (
            last.kind === 'ident' &&
            prev.text !== '.' &&
            !SQL_KEYWORDS.has(last.value.toLowerCase())
        ) {
            const prevIsValue =
                prev.kind === 'ident' ||
                prev.kind === 'number' ||
                prev.kind === 'string' ||
                prev.text === ')';
            if (prevIsValue) {
                return { body: item.slice(0, -1), alias: last.value };
            }
        }
    }
    return { body: item };
}

const SELECT_ITEM_END = new Set([
    'from',
    'into',
    'where',
    'group',
    'order',
    'having',
    'limit',
    'union',
    'except',
    'intersect',
    'window',
    'fetch',
    'for',
    'offset'
]);

function stripTrailingAlias(tokens: SqlToken[]): SqlToken[] {
    if (tokens.length < 2) {
        return tokens;
    }
    const last = tokens[tokens.length - 1];
    const prev = tokens[tokens.length - 2];
    if (isAliasToken(last) && prev.kind === 'keyword' && prev.value.toLowerCase() === 'as') {
        return tokens.slice(0, -2);
    }
    if (isAliasToken(last) && prev.text !== '.' && tokens.length >= 2) {
        return tokens.slice(0, -1);
    }
    return tokens;
}

function isAliasToken(tok: SqlToken): boolean {
    if (tok.kind === 'keyword' && SELECT_ITEM_END.has(tok.value.toLowerCase())) {
        return false;
    }
    return tok.kind === 'ident' || tok.kind === 'keyword';
}

function isNameToken(tok: SqlToken): boolean {
    return tok.kind === 'ident' || tok.kind === 'keyword';
}

function isDottedIdent(tokens: SqlToken[]): boolean {
    if (tokens.length === 0) {
        return false;
    }
    for (let i = 0; i < tokens.length; i++) {
        if (i % 2 === 0) {
            if (tokens[i].kind !== 'ident') {
                return false;
            }
        } else if (tokens[i].text !== '.') {
            return false;
        }
    }
    return tokens[tokens.length - 1].kind === 'ident';
}

function isDottedName(tokens: SqlToken[]): boolean {
    if (tokens.length === 0 || tokens.length % 2 === 0) {
        return false;
    }
    for (let i = 0; i < tokens.length; i++) {
        if (i % 2 === 0) {
            if (!isNameToken(tokens[i])) {
                return false;
            }
        } else if (tokens[i].text !== '.') {
            return false;
        }
    }
    return true;
}
