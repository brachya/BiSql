import * as vscode from 'vscode';
import { normalizeContent } from './normalizeSql';
import { extractJsSqlStringLiteralGroups, isJavascriptHostLanguage } from './jsBlocks';
import {
    buildLineStarts,
    extractSqlStringLiteralGroups,
    offsetToPosition
} from './pythonBlocks';
import { SQL_KEYWORDS, SqlToken, tokenizeSql } from './sqlTokens';
import { splitSqlStatements, statementAtOffset } from './sqlStatements';

export { skipFStringExpression } from './fString';
export {
    hasDroppedLeadingInterpolation,
    isFragmentPosition,
    lastSqlToken,
    normalizeEmbeddedSql
} from './normalizeSql';
export {
    collectSelectLists,
    parseSelectItems,
    type SelectListItem,
    type SelectListSpan
} from './selectList';
export { SQL_KEYWORDS, tokenizeSql } from './sqlTokens';
export type { SqlToken, SqlTokenKind } from './sqlTokens';
export type { PythonStringLiteral } from './pythonBlocks';
export {
    extractSqlStringLiteralGroups,
    extractSqlStringLiterals,
    isSqlStatementStart,
    tokenizePythonStrings
} from './pythonBlocks';
export {
    extractJsSqlStringLiteralGroups,
    extractJsSqlStringLiterals,
    isJavascriptHostLanguage,
    type JsStringLiteral
} from './jsBlocks';
export {
    classifyEmbeddedSqlGroup,
    hasSqlContentMarker,
    looksLikeSqlAssignName,
    looksLikeSqlTemplateTag,
    type EmbeddedSqlHost
} from './sqlHostRules';
export {
    type SqlStatementSlice,
    explainDryRunSkipReason,
    firstSqlKeyword,
    isExplainableStatement,
    splitSqlStatements,
    statementAtOffset,
    statementsForExplainDryRun
} from './sqlStatements';

export interface Piece {
    sqlStart: number;
    sqlEnd: number;
    /** Absolute document offset of the matching content, or null for synthetic fillers. */
    docOffset: number | null;
}

export class SqlBlock {
    /**
     * SQL used for analysis. Named binds (`:name`) and other placeholders
     * are rewritten to NULL so parse/hover/complete stay valid.
     */
    public readonly text: string;
    /**
     * Python string contents as written. Run / Explain use this so `:name`
     * and `{name}` still prompt. Same as `text` for `.sql` files.
     */
    public readonly originalText: string;
    public readonly pieces: Piece[];
    public readonly lineStarts: number[];
    /** Absolute document offsets covering the original Python string(s). */
    public readonly docStart: number;
    public readonly docEnd: number;
    /** Full Python source, used only for offset → Position conversion. */
    private readonly source: string;
    /** Line starts for the Python source. Shared across blocks in one file. */
    private readonly sourceLineStarts: number[];
    private cachedTokens: SqlToken[] | undefined;
    private cachedAnalysis: SqlAnalysis | undefined;

    constructor(
        text: string,
        pieces: Piece[],
        docStart: number,
        docEnd: number,
        source: string,
        sourceLineStarts?: number[],
        originalText?: string
    ) {
        this.text = text;
        this.originalText = originalText ?? text;
        this.pieces = pieces;
        this.docStart = docStart;
        this.docEnd = docEnd;
        this.source = source;
        this.sourceLineStarts = sourceLineStarts ?? buildLineStarts(source);
        this.lineStarts = buildLineStarts(text);
    }

    /** Analyze a standalone SQL string (.sql files and the results editor link). */
    public static fromText(sql: string): SqlBlock {
        return new SqlBlock(
            sql,
            [{ sqlStart: 0, sqlEnd: sql.length, docOffset: 0 }],
            0,
            sql.length,
            sql
        );
    }

    /** One statement inside a `.sql` document, with ranges mapped back to the file. */
    public static fromDocumentSlice(
        source: string,
        start: number,
        end: number,
        sourceLineStarts?: number[]
    ): SqlBlock {
        const from = Math.max(0, Math.min(start, source.length));
        const to = Math.max(from, Math.min(end, source.length));
        const text = source.slice(from, to);
        return new SqlBlock(
            text,
            [{ sqlStart: 0, sqlEnd: text.length, docOffset: from }],
            from,
            to,
            source,
            sourceLineStarts
        );
    }

    public getTokens(): SqlToken[] {
        if (!this.cachedTokens) {
            this.cachedTokens = tokenizeSql(this.text);
        }
        return this.cachedTokens;
    }

    public analyze(): SqlAnalysis {
        if (!this.cachedAnalysis) {
            const tokens = this.getTokens();
            this.cachedAnalysis = {
                tokens,
                ...collectTableRefsFromTokens(tokens),
                selectAliases: collectSelectAliasesFromTokens(tokens)
            };
        }
        return this.cachedAnalysis;
    }

    public containsDocOffset(docOffset: number): boolean {
        return docOffset >= this.docStart && docOffset < this.docEnd;
    }

    public toSqlOffset(docOffset: number): number | null {
        for (const piece of this.pieces) {
            if (piece.docOffset === null) {
                continue;
            }
            const length = piece.sqlEnd - piece.sqlStart;
            if (docOffset >= piece.docOffset && docOffset < piece.docOffset + length) {
                return piece.sqlStart + (docOffset - piece.docOffset);
            }
            // Allow the caret sitting exactly at the end of a real piece.
            if (docOffset === piece.docOffset + length) {
                return piece.sqlEnd;
            }
        }
        return null;
    }

    public toDocRange(sqlStart: number, sqlEnd: number): vscode.Range {
        const start = this.sqlOffsetToDocPosition(sqlStart);
        const end = this.sqlOffsetToDocPosition(Math.max(sqlStart, sqlEnd));
        return new vscode.Range(start, end);
    }

    public sqlOffsetToDocPosition(sqlOffset: number): vscode.Position {
        for (const piece of this.pieces) {
            if (sqlOffset >= piece.sqlStart && sqlOffset <= piece.sqlEnd) {
                if (piece.docOffset === null) {
                    // Synthetic filler: snap to the nearest real piece start that follows,
                    // or the previous piece end.
                    const neighbour = this.nearestRealDocOffset(sqlOffset);
                    return offsetToPosition(this.source, neighbour, this.sourceLineStarts);
                }
                const docOffset = piece.docOffset + (sqlOffset - piece.sqlStart);
                return offsetToPosition(this.source, docOffset, this.sourceLineStarts);
            }
        }
        // Fall back to the block's document start.
        return offsetToPosition(this.source, this.docStart, this.sourceLineStarts);
    }

    public isSyntheticSqlOffset(sqlOffset: number): boolean {
        for (const piece of this.pieces) {
            if (sqlOffset >= piece.sqlStart && sqlOffset < piece.sqlEnd) {
                return piece.docOffset === null;
            }
        }
        return false;
    }

    public lineToSqlOffset(lineNumber: number): number {
        // SQL Server line numbers are 1-based relative to the batch we sent.
        const index = Math.max(0, lineNumber - 1);
        if (index >= this.lineStarts.length) {
            return this.text.length;
        }
        return this.lineStarts[index];
    }

    private nearestRealDocOffset(sqlOffset: number): number {
        let previous: number | null = null;
        for (const piece of this.pieces) {
            if (piece.docOffset === null) {
                continue;
            }
            if (piece.sqlStart >= sqlOffset) {
                return piece.docOffset;
            }
            previous = piece.docOffset + (piece.sqlEnd - piece.sqlStart);
        }
        return previous ?? this.docStart;
    }
}

interface DocumentCacheEntry {
    version: number;
    languageId: string;
    blocks: SqlBlock[];
}

const documentCache = new Map<string, DocumentCacheEntry>();

interface EmbeddedLiteralLike {
    content: string;
    contentStart: number;
    isFString: boolean;
    isTemplate: boolean;
    quoteStart: number;
    quoteEnd: number;
}

function buildBlockFromLiterals(
    literals: EmbeddedLiteralLike[],
    source: string,
    sourceLineStarts: number[]
): SqlBlock {
    const pieces: Piece[] = [];
    let sql = '';
    for (const literal of literals) {
        const segments = normalizeContent(
            literal.content,
            literal.contentStart,
            literal.isFString,
            sql,
            literal.isTemplate
        );
        for (const segment of segments) {
            const sqlStart = sql.length;
            sql += segment.text;
            pieces.push({
                sqlStart,
                sqlEnd: sql.length,
                docOffset: segment.docOffset
            });
        }
    }
    const docStart = literals[0].quoteStart;
    const docEnd = literals[literals.length - 1].quoteEnd;
    const originalText = literals.map((literal) => literal.content).join('');
    return new SqlBlock(sql, pieces, docStart, docEnd, source, sourceLineStarts, originalText);
}

/**
 * Adjacent string literals joined by whitespace or an explicit `+` / `(`
 * inside a call or assignment form one SQL block.
 */
export function extractSqlBlocksFromSource(source: string): SqlBlock[] {
    const groups = extractSqlStringLiteralGroups(source);
    const sourceLineStarts = buildLineStarts(source);
    const mapped = groups.map((group) =>
        group.map((literal) => ({
            ...literal,
            isTemplate: false
        }))
    );
    return mapped.map((group) => buildBlockFromLiterals(group, source, sourceLineStarts));
}

export function extractJsSqlBlocksFromSource(source: string, isJsx = false): SqlBlock[] {
    const groups = extractJsSqlStringLiteralGroups(source, isJsx);
    const sourceLineStarts = buildLineStarts(source);
    const mapped = groups.map((group) =>
        group.map((literal) => ({
            content: literal.content,
            contentStart: literal.contentStart,
            isFString: false,
            isTemplate: literal.isTemplate,
            quoteStart: literal.quoteStart,
            quoteEnd: literal.quoteEnd
        }))
    );
    return mapped.map((group) => buildBlockFromLiterals(group, source, sourceLineStarts));
}

export type SqlSourceKind = 'sql' | 'python' | 'javascript';

export function sqlSourceKindFromPath(fsPath: string): SqlSourceKind | null {
    const lower = fsPath.toLowerCase();
    if (lower.endsWith('.sql')) {
        return 'sql';
    }
    if (lower.endsWith('.py')) {
        return 'python';
    }
    if (/\.(jsx?|tsx?)$/.test(lower)) {
        return 'javascript';
    }
    return null;
}

export function isJsxPath(fsPath: string): boolean {
    return /\.(jsx|tsx)$/i.test(fsPath);
}

export function extractBlocksForSourceKind(source: string, kind: SqlSourceKind, fsPath = ''): SqlBlock[] {
    if (kind === 'sql') {
        return buildSqlFileBlocks(source);
    }
    if (kind === 'python') {
        return extractSqlBlocksFromSource(source);
    }
    return extractJsSqlBlocksFromSource(source, isJsxPath(fsPath));
}

function cachedDocumentBlocks(
    document: vscode.TextDocument,
    build: (source: string) => SqlBlock[]
): SqlBlock[] {
    const key = document.uri.toString();
    const cached = documentCache.get(key);
    if (
        cached &&
        cached.version === document.version &&
        cached.languageId === document.languageId
    ) {
        return cached.blocks;
    }

    const blocks = build(document.getText());
    documentCache.set(key, {
        version: document.version,
        languageId: document.languageId,
        blocks
    });
    return blocks;
}

/** Split a `.sql` source into statement blocks. One shared line-start table per file. */
function buildSqlFileBlocks(source: string): SqlBlock[] {
    const sourceLineStarts = buildLineStarts(source);
    const slices = splitSqlStatements(source);
    if (slices.length === 0) {
        return [SqlBlock.fromDocumentSlice(source, 0, source.length, sourceLineStarts)];
    }
    return slices.map((slice) =>
        SqlBlock.fromDocumentSlice(source, slice.start, slice.end, sourceLineStarts)
    );
}

function buildBlocksForDocument(source: string, languageId: string): SqlBlock[] {
    if (languageId === 'sql') {
        return buildSqlFileBlocks(source);
    }
    if (languageId === 'python') {
        return extractSqlBlocksFromSource(source);
    }
    if (isJavascriptHostLanguage(languageId)) {
        const isJsx = languageId === 'javascriptreact' || languageId === 'typescriptreact';
        return extractJsSqlBlocksFromSource(source, isJsx);
    }
    return [];
}

export function extractSqlBlocks(document: vscode.TextDocument): SqlBlock[] {
    return cachedDocumentBlocks(document, (source) =>
        buildBlocksForDocument(source, document.languageId)
    );
}

export function clearDocumentCache(uri?: vscode.Uri): void {
    if (uri) {
        documentCache.delete(uri.toString());
    } else {
        documentCache.clear();
    }
}

export function isSqlDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'sql';
}

export function isBisqlDocument(document: vscode.TextDocument): boolean {
    return (
        document.languageId === 'python' ||
        isSqlDocument(document) ||
        isJavascriptHostLanguage(document.languageId)
    );
}

/** @deprecated Prefer extractBlocksForSourceKind for project scan; `false` means Python only. */
export function sqlBlocksInSource(source: string, isSqlFile: boolean): SqlBlock[] {
    if (isSqlFile) {
        return buildSqlFileBlocks(source);
    }
    return extractSqlBlocksFromSource(source);
}

export function sqlBlocksInDocument(document: vscode.TextDocument): SqlBlock[] {
    return extractSqlBlocks(document);
}

/**
 * Which statement block owns a document offset. Delegates to statementAtOffset;
 * when the file has no splittable statements, uses the single fallback block.
 */
export function findSqlBlockAtDocOffset(
    blocks: readonly SqlBlock[],
    source: string,
    docOffset: number
): SqlBlock | undefined {
    if (blocks.length === 0) {
        return undefined;
    }
    const slice = statementAtOffset(source, docOffset);
    if (!slice) {
        return blocks.length === 1 ? blocks[0] : undefined;
    }
    return blocks.find((block) => block.docStart === slice.start && block.docEnd === slice.end);
}

/**
 * Cached statement block for Run / Explain when the caret sits on real SQL.
 * Comment-only files and gaps with no statement return undefined.
 */
export function sqlStatementBlockAtDocOffset(
    document: vscode.TextDocument,
    docOffset: number
): SqlBlock | undefined {
    if (!isSqlDocument(document)) {
        return undefined;
    }
    const source = document.getText();
    const slice = statementAtOffset(source, docOffset);
    if (!slice || slice.text.trim().length === 0) {
        return undefined;
    }
    const blocks = sqlBlocksInDocument(document);
    return blocks.find((block) => block.docStart === slice.start && block.docEnd === slice.end);
}

export function findBlockAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): { block: SqlBlock; sqlOffset: number } | undefined {
    const blocks = extractSqlBlocks(document);
    const docOffset = document.offsetAt(position);
    for (const block of blocks) {
        if (!block.containsDocOffset(docOffset)) {
            continue;
        }
        const sqlOffset = block.toSqlOffset(docOffset);
        if (sqlOffset === null) {
            // Cursor is on the quote characters themselves — treat as just inside.
            if (docOffset < block.pieces[0]?.docOffset!) {
                return { block, sqlOffset: 0 };
            }
            return { block, sqlOffset: block.text.length };
        }
        return { block, sqlOffset };
    }
    return undefined;
}

/** Python string under the caret, or the `.sql` statement under the caret. */
export function findSqlAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): { block: SqlBlock; sqlOffset: number } | undefined {
    if (isSqlDocument(document)) {
        const source = document.getText();
        const blocks = sqlBlocksInDocument(document);
        const docOffset = document.offsetAt(position);
        const block = findSqlBlockAtDocOffset(blocks, source, docOffset);
        if (!block) {
            return undefined;
        }
        const sqlOffset = block.toSqlOffset(docOffset);
        if (sqlOffset === null) {
            return {
                block,
                sqlOffset: docOffset <= block.docStart ? 0 : block.text.length
            };
        }
        return { block, sqlOffset };
    }
    return findBlockAtPosition(document, position);
}


export interface TableRef {
    /** Resolved table reference as written (e.g. dbo.Users). */
    table: string;
    /** Alias if present, otherwise the table name. */
    alias: string;
    /** SQL offset of the table name. */
    start: number;
    end: number;
}

export interface TableRefResult {
    refs: TableRef[];
    aliasToTable: Map<string, string>;
    cteNames: Set<string>;
    hasCte: boolean;
    hasDerived: boolean;
    hasExec: boolean;
    /** FROM / JOIN / INTO / UPDATE whose name is a placeholder (`NULL` after rewrite). */
    hasUnresolvedFrom: boolean;
}

export interface CteDef {
    name: string;
    declaredColumns: string[];
    /** Token index of the '(' that opens the CTE body. */
    bodyOpen: number;
    /** Token index of the matching ')'. */
    bodyClose: number;
}

export interface SqlAnalysis extends TableRefResult {
    tokens: SqlToken[];
    selectAliases: Set<string>;
}

/**
 * Dry-run sends EXPLAIN / NOEXEC of analysis SQL. A placeholder table name
 * becomes `NULL`, and `FROM NULL` is a syntax error — skip that check.
 */
export const SYNTHETIC_TABLE_DRY_RUN_SKIP =
    'A table name is a placeholder after FROM, JOIN, INTO, or UPDATE, so this query cannot be dry-run. Offline schema checks still apply.';

export const SYNTHETIC_CTE_DRY_RUN_SKIP =
    'A CTE is a placeholder in the WITH list, so this query cannot be dry-run. Offline schema checks still apply.';

/**
 * True when an f-string / bind placeholder sits where a table name goes.
 * Value placeholders (`WHERE id = {x}`) do not count.
 */
export function hasSyntheticTablePlaceholder(
    tokens: SqlToken[],
    isSynthetic: (offset: number) => boolean
): boolean {
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const lower = tok.value.toLowerCase();
        const introducesTable =
            tok.kind === 'keyword' &&
            (lower === 'from' ||
                lower === 'join' ||
                lower === 'into' ||
                (lower === 'update' && isTableIntroducingUpdate(tokens, i)));
        if (!introducesTable) {
            continue;
        }
        let j = i + 1;
        if (j >= tokens.length || tokens[j].text === '(') {
            continue;
        }
        while (j < tokens.length) {
            const part = tokens[j];
            if (part.text === '.') {
                j += 1;
                continue;
            }
            if (isSynthetic(part.start)) {
                return true;
            }
            if (part.kind !== 'ident') {
                break;
            }
            j += 1;
            if (j < tokens.length && tokens[j].text === '.') {
                j += 1;
            }
        }
    }
    return false;
}

/**
 * True when an f-string sits in a WITH list (`WITH {cte}` or `cte AS (…), {cte}`).
 * Analysis SQL uses NULL there, which is `WITH …, NULL SELECT` — skip dry-run.
 * Value placeholders inside a CTE body do not count.
 */
export function hasSyntheticCtePlaceholder(
    tokens: SqlToken[],
    isSynthetic: (offset: number) => boolean
): boolean {
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'keyword' || tokens[i].value.toLowerCase() !== 'with') {
            continue;
        }
        let j = i + 1;
        if (j < tokens.length && tokens[j].value.toLowerCase() === 'recursive') {
            j++;
        }
        if (j < tokens.length && isSynthetic(tokens[j].start)) {
            return true;
        }
    }
    for (const def of collectCteDefs(tokens)) {
        let j = def.bodyClose + 1;
        if (j >= tokens.length || tokens[j].text !== ',') {
            continue;
        }
        j++;
        if (j < tokens.length && isSynthetic(tokens[j].start)) {
            return true;
        }
    }
    return false;
}

/**
 * CREATE TABLE defines a name. Walking back skips TEMPORARY / OR REPLACE / etc.
 * `TABLE t` (MySQL) and ALTER/DROP/TRUNCATE TABLE still count as real refs.
 */
function isCreateTableKeyword(tokens: SqlToken[], tableIndex: number): boolean {
    for (let i = tableIndex - 1; i >= 0; i--) {
        const tok = tokens[i];
        if (tok.kind === 'punct' && tok.text === ';') {
            return false;
        }
        if (tok.kind !== 'keyword' && tok.kind !== 'ident') {
            continue;
        }
        const lower = tok.value.toLowerCase();
        if (lower === 'create') {
            return true;
        }
        if (lower === 'alter' || lower === 'drop' || lower === 'truncate') {
            return false;
        }
    }
    return false;
}

/** True when UPDATE names a target table, not a clause like ON DUPLICATE KEY UPDATE. */
function isTableIntroducingUpdate(tokens: SqlToken[], updateIndex: number): boolean {
    if (updateIndex < 1) {
        return true;
    }
    const prev = tokens[updateIndex - 1].value.toLowerCase();
    if (prev === 'for') {
        return false;
    }
    return !(
        updateIndex >= 3 &&
        tokens[updateIndex - 3].value.toLowerCase() === 'on' &&
        tokens[updateIndex - 2].value.toLowerCase() === 'duplicate' &&
        prev === 'key'
    );
}

/**
 * Collects table references and aliases from FROM / JOIN / UPDATE / INTO / DELETE FROM.
 * Skips derived tables `(SELECT …)` and CTEs introduced by WITH.
 */
export function collectTableRefs(sql: string, tokens: SqlToken[] = tokenizeSql(sql)): TableRefResult {
    return collectTableRefsFromTokens(tokens);
}

/** Short name of the first table in the SQL. Used on the results tab. */
export function primaryResultTable(sql: string): string | undefined {
    const table = collectTableRefs(sql).refs[0]?.table;
    if (!table) {
        return undefined;
    }
    const short = table.slice(table.lastIndexOf('.') + 1);
    return short || undefined;
}

function collectTableRefsFromTokens(tokens: SqlToken[]): TableRefResult {
    const refs: TableRef[] = [];
    const aliasToTable = new Map<string, string>();
    const cteNames = collectCteNames(tokens);
    const hasCte = cteNames.size > 0;
    let hasDerived = false;
    let hasExec = false;
    let hasUnresolvedFrom = false;
    // Only FROM / JOIN `(` … `)`, not WITH x AS ( … ) or IFNULL(.
    const derivedCloseAt: number[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const lower = tok.value.toLowerCase();

        while (derivedCloseAt.length > 0 && i > derivedCloseAt[derivedCloseAt.length - 1]) {
            derivedCloseAt.pop();
        }

        if (tok.kind === 'keyword' && (lower === 'exec' || lower === 'execute')) {
            hasExec = true;
        }

        const isFromLike =
            tok.kind === 'keyword' &&
            (lower === 'from' ||
                lower === 'join' ||
                lower === 'into' ||
                (lower === 'update' && isTableIntroducingUpdate(tokens, i)) ||
                // ALTER/DROP/TRUNCATE TABLE name an existing table. CREATE TABLE does not.
                (lower === 'table' && i > 0 && !isCreateTableKeyword(tokens, i)));

        // DELETE FROM …
        const isDeleteFrom =
            tok.kind === 'keyword' &&
            lower === 'from' &&
            i > 0 &&
            tokens[i - 1].kind === 'keyword' &&
            tokens[i - 1].value.toLowerCase() === 'delete';

        if (!isFromLike && !isDeleteFrom) {
            continue;
        }

        // Skip JOIN qualifiers already handled by looking at 'join' itself.
        let j = i + 1;
        if (j >= tokens.length) {
            continue;
        }

        // Derived table: FROM ( SELECT …
        if (tokens[j].text === '(') {
            hasDerived = true;
            const close = matchingCloseParen(tokens, j);
            derivedCloseAt.push(close === -1 ? tokens.length : close);
            continue;
        }
        // `{table}` rewrites to NULL. Real SQL cannot FROM NULL.
        if (tokens[j].kind === 'keyword' && tokens[j].value.toLowerCase() === 'null') {
            hasUnresolvedFrom = true;
            continue;
        }

        // Read a possibly schema-qualified name: a.b, [a].[b], or
        // BigQuery `project-id.dataset.table` (hyphens stay in the project id).
        const name = readQualifiedName(tokens, j);
        if (!name) {
            continue;
        }
        j = name.next;
        const table = name.parts.join('.');
        const start = name.start;
        const end = name.end;

        // Optional AS alias, or bare alias (not a keyword / punct).
        let alias = name.parts[name.parts.length - 1];
        if (j < tokens.length) {
            if (
                tokens[j].kind === 'keyword' &&
                tokens[j].value.toLowerCase() === 'as' &&
                j + 1 < tokens.length &&
                tokens[j + 1].kind === 'ident'
            ) {
                alias = tokens[j + 1].value;
                j += 2;
            } else if (
                tokens[j].kind === 'ident' &&
                !SQL_KEYWORDS.has(tokens[j].value.toLowerCase())
            ) {
                alias = tokens[j].value;
                j++;
            }
        }

        refs.push({ table, alias, start, end });
        // Inner JOIN aliases must not leak. Outer `) r` is then an unknown
        // alias, so `r.col` is left alone instead of checked on the inner table.
        // WITH x AS ( SELECT u.id FROM users u ) stays at depth 0, so `u` is kept.
        if (derivedCloseAt.length === 0) {
            aliasToTable.set(alias.toLowerCase(), table);
            // Also map the bare table name so `Users.Id` works without an alias.
            aliasToTable.set(name.parts[name.parts.length - 1].toLowerCase(), table);
        }
    }

    return { refs, aliasToTable, cteNames, hasCte, hasDerived, hasExec, hasUnresolvedFrom };
}

/**
 * Table / relation name at `startIndex`: `a.b`, `[a].[b]`, or BigQuery
 * `project-id.dataset.table`. Hyphens are folded only here. In SELECT,
 * `a-b` is still subtraction because the tokenizer keeps `-` as punct.
 */
function readQualifiedName(
    tokens: SqlToken[],
    startIndex: number
): { parts: string[]; start: number; end: number; next: number } | undefined {
    let j = startIndex;
    if (j >= tokens.length || tokens[j].kind !== 'ident') {
        return undefined;
    }
    const start = tokens[j].start;
    const parts: string[] = [];
    let end = tokens[j].end;
    while (j < tokens.length && tokens[j].kind === 'ident') {
        let part = tokens[j].value;
        end = tokens[j].end;
        j += 1;
        while (
            j + 1 < tokens.length &&
            tokens[j].kind === 'punct' &&
            tokens[j].text === '-' &&
            (tokens[j + 1].kind === 'ident' || tokens[j + 1].kind === 'number')
        ) {
            part += `-${tokens[j + 1].value}`;
            end = tokens[j + 1].end;
            j += 2;
        }
        parts.push(part);
        if (j < tokens.length && tokens[j].text === '.') {
            j += 1;
            continue;
        }
        break;
    }
    return { parts, start, end, next: j };
}

function matchingCloseParen(tokens: SqlToken[], openIndex: number): number {
    let depth = 0;
    for (let k = openIndex; k < tokens.length; k++) {
        if (tokens[k].text === '(') {
            depth++;
        } else if (tokens[k].text === ')') {
            depth--;
            if (depth === 0) {
                return k;
            }
        }
    }
    return -1;
}

/**
 * CTE definitions from `WITH cte AS (…), other AS (…)`. Skips `WITH (NOLOCK)` hints.
 */
export function collectCteDefs(tokens: SqlToken[]): CteDef[] {
    const defs: CteDef[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'keyword' || tokens[i].value.toLowerCase() !== 'with') {
            continue;
        }
        let j = i + 1;
        if (j < tokens.length && tokens[j].value.toLowerCase() === 'recursive') {
            j++;
        }
        while (j < tokens.length && tokens[j].kind === 'ident') {
            const name = tokens[j].value;
            j++;
            const declaredColumns: string[] = [];
            if (j < tokens.length && tokens[j].text === '(') {
                j++;
                while (j < tokens.length && tokens[j].text !== ')') {
                    if (tokens[j].kind === 'ident') {
                        declaredColumns.push(tokens[j].value);
                    }
                    j++;
                }
                if (j < tokens.length && tokens[j].text === ')') {
                    j++;
                }
            }
            while (
                j < tokens.length &&
                !(tokens[j].kind === 'keyword' && tokens[j].value.toLowerCase() === 'as')
            ) {
                j++;
            }
            if (j < tokens.length) {
                j++;
            }
            if (j >= tokens.length || tokens[j].text !== '(') {
                break;
            }
            const bodyOpen = j;
            let depth = 0;
            let bodyClose = -1;
            while (j < tokens.length) {
                if (tokens[j].text === '(') {
                    depth++;
                } else if (tokens[j].text === ')') {
                    depth--;
                    if (depth === 0) {
                        bodyClose = j;
                        j++;
                        break;
                    }
                }
                j++;
            }
            if (bodyClose !== -1) {
                defs.push({ name, declaredColumns, bodyOpen, bodyClose });
            }
            if (j < tokens.length && tokens[j].text === ',') {
                j++;
                continue;
            }
            break;
        }
    }
    return defs;
}

export function collectCteNames(tokens: SqlToken[]): Set<string> {
    return new Set(collectCteDefs(tokens).map((def) => def.name.toLowerCase()));
}

/**
 * True when the token sits in `CREATE/ALTER TABLE name ( ... )`.
 * Those tokens are new columns and types (`INTEGER`), not column references.
 * CREATE TABLE AS SELECT has no paren list after the name, so SELECT is unchecked here.
 */
export function isInsideDdlColumnList(tokens: SqlToken[], index: number): boolean {
    for (let i = 0; i < tokens.length; i++) {
        const lower = tokens[i].value.toLowerCase();
        if (tokens[i].kind !== 'keyword' || (lower !== 'create' && lower !== 'alter')) {
            continue;
        }
        let j = i + 1;
        while (j < tokens.length && tokens[j].value.toLowerCase() !== 'table') {
            if (tokens[j].text === ';') {
                break;
            }
            j++;
        }
        if (j >= tokens.length || tokens[j].value.toLowerCase() !== 'table') {
            continue;
        }
        j += 1;
        while (j < tokens.length) {
            const tok = tokens[j];
            const word = tok.value.toLowerCase();
            if (
                tok.kind === 'ident' ||
                tok.text === '.' ||
                (tok.kind === 'keyword' && (word === 'if' || word === 'not' || word === 'exists'))
            ) {
                j++;
                continue;
            }
            break;
        }
        if (j >= tokens.length || tokens[j].text !== '(') {
            continue;
        }
        const open = j;
        const close = matchingCloseParen(tokens, open);
        if (close !== -1 && index > open && index < close) {
            return true;
        }
    }
    return false;
}

const INSERT_TABLE_PREFIX = new Set([
    'into',
    'ignore',
    'overwrite',
    'delayed',
    'low_priority',
    'high_priority'
]);

/**
 * `INSERT/REPLACE INTO t (a, b)` — `a` and `b` belong to `t`, not to FROM tables.
 * A placeholder table becomes NULL, so `table` is null and callers skip the check.
 * `INSERT(...)` is a function: no table name before `(`, so this returns null.
 */
export function insertColumnListAt(
    tokens: SqlToken[],
    index: number
): { table: string | null } | null {
    for (let i = 0; i < tokens.length; i++) {
        const lower = tokens[i].value.toLowerCase();
        const isInsert =
            (tokens[i].kind === 'keyword' && lower === 'insert') ||
            ((tokens[i].kind === 'ident' || tokens[i].kind === 'keyword') && lower === 'replace');
        if (!isInsert) {
            continue;
        }
        let j = i + 1;
        while (j < tokens.length) {
            const word = tokens[j].value.toLowerCase();
            if (
                (tokens[j].kind === 'keyword' || tokens[j].kind === 'ident') &&
                INSERT_TABLE_PREFIX.has(word)
            ) {
                j++;
                continue;
            }
            break;
        }
        const nameParts: string[] = [];
        let unresolved = false;
        while (j < tokens.length) {
            const tok = tokens[j];
            if (tok.kind === 'ident') {
                nameParts.push(tok.value);
                j++;
                continue;
            }
            if (tok.text === '.') {
                j++;
                continue;
            }
            if (tok.kind === 'keyword' && tok.value.toLowerCase() === 'null') {
                unresolved = true;
                j++;
                continue;
            }
            break;
        }
        if (!unresolved && nameParts.length === 0) {
            continue;
        }
        if (j >= tokens.length || tokens[j].text !== '(') {
            continue;
        }
        const close = matchingCloseParen(tokens, j);
        if (close !== -1 && index > j && index < close) {
            return { table: unresolved || nameParts.length === 0 ? null : nameParts.join('.') };
        }
    }
    return null;
}

export function isInsideInsertColumnList(tokens: SqlToken[], index: number): boolean {
    return insertColumnListAt(tokens, index) !== null;
}

/**
 * True for the name in `cte AS (` and `cte (a, b) AS (`.
 * A later CTE sits after a comma, which otherwise looks like a SELECT-list column.
 */
export function isCteDefinitionName(tokens: SqlToken[], index: number): boolean {
    if (index < 0 || index >= tokens.length || tokens[index].kind !== 'ident') {
        return false;
    }
    let i = index + 1;
    if (i < tokens.length && tokens[i].text === '(') {
        let depth = 0;
        while (i < tokens.length) {
            if (tokens[i].text === '(') {
                depth++;
            } else if (tokens[i].text === ')') {
                depth--;
                if (depth === 0) {
                    i++;
                    break;
                }
            }
            i++;
        }
        if (depth !== 0) {
            return false;
        }
    }
    return (
        i < tokens.length &&
        tokens[i].kind === 'keyword' &&
        tokens[i].value.toLowerCase() === 'as' &&
        i + 1 < tokens.length &&
        tokens[i + 1].text === '('
    );
}

export function collectSelectAliases(
    sql: string,
    tokens: SqlToken[] = tokenizeSql(sql)
): Set<string> {
    return collectSelectAliasesFromTokens(tokens);
}

function collectSelectAliasesFromTokens(tokens: SqlToken[]): Set<string> {
    const aliases = new Set<string>();
    let i = 0;
    while (i < tokens.length) {
        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'select') {
            i++;
            break;
        }
        i++;
    }
    if (i >= tokens.length) {
        return aliases;
    }

    // Skip DISTINCT / TOP n
    while (i < tokens.length) {
        const lower = tokens[i].value.toLowerCase();
        if (tokens[i].kind === 'keyword' && (lower === 'distinct' || lower === 'all')) {
            i++;
            continue;
        }
        if (tokens[i].kind === 'keyword' && lower === 'top') {
            i++;
            if (i < tokens.length && tokens[i].kind === 'number') {
                i++;
            }
            continue;
        }
        break;
    }

    while (i < tokens.length) {
        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'from') {
            break;
        }

        // Walk one select-item until comma or FROM.
        let depth = 0;
        let lastValueToken = -1;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (tok.text === '(') {
                depth++;
                i++;
                continue;
            }
            if (tok.text === ')') {
                depth = Math.max(0, depth - 1);
                lastValueToken = i;
                i++;
                continue;
            }
            if (depth === 0 && tok.text === ',') {
                i++;
                break;
            }
            if (depth === 0 && tok.kind === 'keyword' && tok.value.toLowerCase() === 'from') {
                break;
            }

            if (depth === 0 && tok.kind === 'keyword' && tok.value.toLowerCase() === 'as') {
                if (i + 1 < tokens.length && tokens[i + 1].kind === 'ident') {
                    aliases.add(tokens[i + 1].value.toLowerCase());
                    i += 2;
                    // Consume until comma / FROM
                    while (i < tokens.length) {
                        if (tokens[i].text === ',' ) {
                            i++;
                            break;
                        }
                        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'from') {
                            break;
                        }
                        i++;
                    }
                    break;
                }
            }

            // Implicit alias: <expr> <ident> where expr ended with ) / ident / number / string.
            // `p.cred` is one expression — the ident after `.` is not an alias.
            if (
                depth === 0 &&
                tok.kind === 'ident' &&
                lastValueToken >= 0 &&
                !(i > 0 && tokens[i - 1].text === '.') &&
                !SQL_KEYWORDS.has(tok.value.toLowerCase())
            ) {
                const prev = tokens[lastValueToken];
                const prevIsValue =
                    prev.kind === 'ident' ||
                    prev.kind === 'number' ||
                    prev.kind === 'string' ||
                    prev.text === ')';
                const nextIsCall = i + 1 < tokens.length && tokens[i + 1].text === '(';
                if (prevIsValue && !nextIsCall && lastValueToken !== i) {
                    aliases.add(tok.value.toLowerCase());
                    i++;
                    while (i < tokens.length) {
                        if (tokens[i].text === ',') {
                            i++;
                            break;
                        }
                        if (tokens[i].kind === 'keyword' && tokens[i].value.toLowerCase() === 'from') {
                            break;
                        }
                        i++;
                    }
                    break;
                }
            }

            if (tok.kind === 'ident' || tok.kind === 'number' || tok.kind === 'string') {
                lastValueToken = i;
            }
            i++;
        }
    }

    return aliases;
}

/**
 * Returns the identifier (or dotted path) under a SQL offset.
 */
export function identifierAt(
    sql: string,
    offset: number,
    tokens: SqlToken[] = tokenizeSql(sql)
): { text: string; value: string; start: number; end: number; parts: string[] } | undefined {
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.kind !== 'ident') {
            continue;
        }
        if (offset < tok.start || offset > tok.end) {
            continue;
        }

        // Expand left/right across dots to form a.b.c
        let left = i;
        while (
            left > 1 &&
            tokens[left - 1].text === '.' &&
            tokens[left - 2].kind === 'ident'
        ) {
            left -= 2;
        }
        let right = i;
        while (
            right + 2 < tokens.length &&
            tokens[right + 1].text === '.' &&
            tokens[right + 2].kind === 'ident'
        ) {
            right += 2;
        }

        const parts: string[] = [];
        for (let k = left; k <= right; k++) {
            if (tokens[k].kind === 'ident') {
                parts.push(tokens[k].value);
            }
        }
        return {
            text: sql.slice(tokens[left].start, tokens[right].end),
            value: parts.join('.'),
            start: tokens[left].start,
            end: tokens[right].end,
            parts
        };
    }
    return undefined;
}
