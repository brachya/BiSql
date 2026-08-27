import * as vscode from 'vscode';
import {
    DryRunError,
    DryRunResult,
    SchemaCache,
    SqlServerService,
    TableInfo,
    defaultSchemaForEngine
} from '../db/connection';
import {
    SqlBlock,
    SYNTHETIC_TABLE_DRY_RUN_SKIP,
    clearDocumentCache,
    hasSyntheticTablePlaceholder,
    isBisqlDocument,
    isCteDefinitionName,
    sqlBlocksInDocument,
    tokenizeSql
} from '../parser/sqlExtractor';
import { findSqlFunction } from '../sql/functions';
import { findRelation, resolveCteTables, rewriteSyntheticSelectLists } from '../sql/cteSchema';
import { isSystemCatalogTable } from '../sql/systemCatalogs';

export interface FixSuggestion {
    replacement: string;
    label: string;
}

export const DIAGNOSTIC_SOURCE = 'BiSql';

export class DiagnosticsManager implements vscode.Disposable {
    private readonly collection: vscode.DiagnosticCollection;
    private readonly fixMap = new Map<string, FixSuggestion[]>();
    private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly db: SqlServerService) {
        this.collection = vscode.languages.createDiagnosticCollection('bisql');
        this.disposables.push(this.collection);

        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((doc) => {
                if (isBisqlDocument(doc)) {
                    void this.validateDocument(doc, true);
                }
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (isBisqlDocument(doc)) {
                    void this.validateDocument(doc, true);
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (!isBisqlDocument(event.document)) {
                    return;
                }
                const config = this.db.getConfig();
                if (!config.enabled || !config.validateOnType) {
                    return;
                }
                this.scheduleOffline(event.document);
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.clearDocument(doc.uri);
            }),
            this.db.onDidChangeSchema(() => {
                void this.revalidateOpenDocuments(false);
            })
        );

        for (const doc of vscode.workspace.textDocuments) {
            if (isBisqlDocument(doc)) {
                void this.validateDocument(doc, true);
            }
        }
    }

    public getFixes(uri: vscode.Uri, range: vscode.Range): FixSuggestion[] {
        return this.fixMap.get(fixKey(uri, range)) ?? [];
    }

    public clearDocument(uri: vscode.Uri): void {
        this.collection.delete(uri);
        clearDocumentCache(uri);
        for (const key of [...this.fixMap.keys()]) {
            if (key.startsWith(uri.toString() + '|')) {
                this.fixMap.delete(key);
            }
        }
        const timer = this.debounceTimers.get(uri.toString());
        if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(uri.toString());
        }
    }

    public async validateDocument(
        document: vscode.TextDocument,
        includeDryRun: boolean
    ): Promise<void> {
        const config = this.db.getConfig();
        if (!config.enabled || !isBisqlDocument(document)) {
            this.collection.delete(document.uri);
            return;
        }

        // Drop previous fixes for this document before rebuilding.
        // Keep the parse cache — extractSqlBlocks already rebuilds on a new version.
        for (const key of [...this.fixMap.keys()]) {
            if (key.startsWith(document.uri.toString() + '|')) {
                this.fixMap.delete(key);
            }
        }

        const blocks = sqlBlocksInDocument(document, config.detectByKeyword);
        if (blocks.length > 0) {
            this.db.requestLiveSchema();
        }
        const schema = this.db.schema;
        const diagnostics: vscode.Diagnostic[] = [];
        const nameIndex = buildKnownNameIndex(schema, config.engine);

        for (const block of blocks) {
            diagnostics.push(...this.offlineValidate(document.uri, block, schema, nameIndex));
        }

        if (includeDryRun && config.dryRunOnSave && blocks.length > 0) {
            const dryRuns = await Promise.all(blocks.map((block) => this.dryRunBlock(block)));
            for (let i = 0; i < blocks.length; i++) {
                const result = dryRuns[i];
                if (result.kind === 'errors') {
                    diagnostics.push(
                        ...this.mapDryRunErrors(document.uri, blocks[i], result.errors, diagnostics)
                    );
                }
            }
        }

        this.collection.set(document.uri, diagnostics);
    }

    /**
     * Offline check + dry-run for one statement or Python SQL string.
     * Other diagnostics on the file are kept.
     */
    public async validateTarget(
        document: vscode.TextDocument,
        block: SqlBlock
    ): Promise<{ issues: number; notice?: string }> {
        const config = this.db.getConfig();
        if (!config.enabled || !isBisqlDocument(document)) {
            return { issues: 0 };
        }

        const blockRange = new vscode.Range(
            document.positionAt(block.docStart),
            document.positionAt(Math.max(block.docStart, block.docEnd))
        );
        const previous = this.collection.get(document.uri) ?? [];
        for (const diagnostic of previous) {
            if (blockRange.contains(diagnostic.range.start)) {
                this.fixMap.delete(fixKey(document.uri, diagnostic.range));
            }
        }
        const kept = previous.filter((diagnostic) => !blockRange.contains(diagnostic.range.start));

        this.db.requestLiveSchema();
        const schema = this.db.schema;
        const nameIndex = buildKnownNameIndex(schema, config.engine);
        const diagnostics = [...kept, ...this.offlineValidate(document.uri, block, schema, nameIndex)];

        const dryRun = await this.dryRunBlock(block);
        let notice: string | undefined;
        if (dryRun.kind === 'errors') {
            diagnostics.push(...this.mapDryRunErrors(document.uri, block, dryRun.errors, diagnostics));
        } else if (dryRun.kind === 'skipped' || dryRun.kind === 'unavailable') {
            notice = dryRun.reason;
        }

        this.collection.set(document.uri, diagnostics);
        return { issues: diagnostics.length - kept.length, notice };
    }

    public async revalidateOpenDocuments(includeDryRun: boolean): Promise<void> {
        for (const doc of vscode.workspace.textDocuments) {
            if (isBisqlDocument(doc)) {
                await this.validateDocument(doc, includeDryRun);
            }
        }
    }

    /**
     * Live EXPLAIN / NOEXEC. Skipped when a placeholder is the table name —
     * analysis SQL uses NULL there, which is invalid after FROM / JOIN / INTO / UPDATE.
     */
    private dryRunBlock(block: SqlBlock): Promise<DryRunResult> {
        const isSynthetic = (offset: number) => block.isSyntheticSqlOffset(offset);
        if (hasSyntheticTablePlaceholder(block.getTokens(), isSynthetic)) {
            return Promise.resolve({
                kind: 'skipped',
                reason: SYNTHETIC_TABLE_DRY_RUN_SKIP
            });
        }
        const rewritten = rewriteSyntheticSelectLists(block.text, block.getTokens(), isSynthetic);
        return this.db.dryRun(rewritten);
    }

    private scheduleOffline(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const existing = this.debounceTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        this.debounceTimers.set(
            key,
            setTimeout(() => {
                this.debounceTimers.delete(key);
                void this.validateDocument(document, false);
            }, 300)
        );
    }

    private offlineValidate(
        uri: vscode.Uri,
        block: SqlBlock,
        schema: SchemaCache,
        nameIndex: KnownNameIndex
    ): vscode.Diagnostic[] {
        if (schema.isEmpty) {
            return [];
        }

        const { refs, aliasToTable, cteNames, hasDerived, hasExec, tokens, selectAliases } =
            block.analyze();

        const diagnostics: vscode.Diagnostic[] = [];
        const severity = schema.stale
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error;
        const staleSuffix = schema.stale ? ' (from cached schema, not yet refreshed)' : '';

        const config = this.db.getConfig();
        const findTable = (reference: string) =>
            schema.findTable(
                reference,
                config.database,
                defaultSchemaForEngine(config.engine) ?? 'dbo'
            );
        const ctes = resolveCteTables(tokens, findTable);
        const lookup = (reference: string) => findRelation(reference, findTable, ctes);

        for (const ref of refs) {
            if (cteNames.has(ref.table.toLowerCase()) || ctes.has(ref.table.toLowerCase())) {
                continue;
            }
            const table = lookup(ref.table);
            const range = block.toDocRange(ref.start, ref.end);

            if (table) {
                continue;
            }
            // Engine catalogs are real, but we do not load them into the user-schema cache.
            if (isSystemCatalogTable(ref.table, config.engine)) {
                continue;
            }
            const suggestion = bestMatch(ref.table, nameIndex.names);
            const message = suggestion
                ? `Unknown table or view '${ref.table}'. Did you mean '${suggestion}'?${staleSuffix}`
                : `Unknown table or view '${ref.table}'.${staleSuffix}`;
            const diagnostic = new vscode.Diagnostic(range, message, severity);
            diagnostic.source = DIAGNOSTIC_SOURCE;
            diagnostic.code = 'unknown-table';
            diagnostics.push(diagnostic);
            if (suggestion) {
                this.fixMap.set(fixKey(uri, range), [
                    { replacement: suggestion, label: `Change to '${suggestion}'` }
                ]);
            }
        }

        // EXEC result sets are unknown. Derived tables can still use alias.column
        // checks when the alias maps to a real table or a calculated CTE.
        if (hasExec) {
            return diagnostics;
        }

        const resolvedTables: TableInfo[] = [];
        let allResolved = refs.length > 0;
        for (const ref of refs) {
            const table = lookup(ref.table);
            if (table && table.columns.length > 0) {
                resolvedTables.push(table);
            } else if (cteNames.has(ref.table.toLowerCase())) {
                allResolved = false;
            } else if (!table) {
                allResolved = false;
            }
        }

        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (tok.kind !== 'ident') {
                continue;
            }

            // Skip identifiers that are themselves table references we already checked.
            if (refs.some((ref) => tok.start >= ref.start && tok.end <= ref.end)) {
                continue;
            }
            // `WITH a AS (...), b AS (...)` — `b` follows a comma, which looks like
            // a SELECT-list column. It is a CTE name, not a column.
            if (isCteDefinitionName(tokens, i)) {
                continue;
            }

            // Function call: NAME(
            if (i + 1 < tokens.length && tokens[i + 1].text === '(') {
                continue;
            }
            if (findSqlFunction(tok.value, config.engine)) {
                continue;
            }
            // SELECT list aliases (and ORDER BY references to them).
            if (selectAliases.has(tok.value.toLowerCase())) {
                continue;
            }

            // alias.column
            if (
                i + 2 < tokens.length &&
                tokens[i + 1].text === '.' &&
                tokens[i + 2].kind === 'ident'
            ) {
                const alias = tok.value;
                const columnTok = tokens[i + 2];
                const tableName = aliasToTable.get(alias.toLowerCase());
                if (!tableName) {
                    // Unknown alias — leave alone; could be a derived table.
                    i += 2;
                    continue;
                }
                const table = lookup(tableName);
                if (!table || table.columns.length === 0) {
                    i += 2;
                    continue;
                }
                if (!table.columnsByLower.has(columnTok.value.toLowerCase())) {
                    const names = table.columns.map((column) => column.name);
                    const suggestion = bestMatch(columnTok.value, names);
                    const range = block.toDocRange(columnTok.start, columnTok.end);
                    const message = suggestion
                        ? `Unknown column '${columnTok.value}' on ${table.fullName}. Did you mean '${suggestion}'?${staleSuffix}`
                        : `Unknown column '${columnTok.value}' on ${table.fullName}.${staleSuffix}`;
                    const diagnostic = new vscode.Diagnostic(range, message, severity);
                    diagnostic.source = DIAGNOSTIC_SOURCE;
                    diagnostic.code = 'unknown-column';
                    diagnostics.push(diagnostic);
                    if (suggestion) {
                        this.fixMap.set(fixKey(uri, range), [
                            { replacement: suggestion, label: `Change to '${suggestion}'` }
                        ]);
                    }
                }
                i += 2;
                continue;
            }

            // Bare column — only flag when every FROM table resolved and the name
            // exists on none of them. Skip keywords / SQL function names handled elsewhere.
            if (hasDerived || !allResolved || resolvedTables.length === 0) {
                continue;
            }
            // Skip if this token is used as an alias definition.
            if (refs.some((ref) => ref.alias.toLowerCase() === tok.value.toLowerCase())) {
                continue;
            }
            if (cteNames.has(tok.value.toLowerCase()) || ctes.has(tok.value.toLowerCase())) {
                continue;
            }
            // Skip schema / table name tokens already covered.
            if (schema.findTable(
                tok.value,
                config.database,
                defaultSchemaForEngine(config.engine) ?? 'dbo'
            )) {
                continue;
            }

            const existsSomewhere = resolvedTables.some((table) =>
                table.columnsByLower.has(tok.value.toLowerCase())
            );
            if (existsSomewhere) {
                continue;
            }

            // Only complain about bare columns when they appear in SELECT / WHERE /
            // ON / SET / HAVING / ORDER BY / GROUP BY contexts roughly — use a simple
            // heuristic: previous keyword is one of those, or previous punct is `,`.
            if (!looksLikeColumnContext(tokens, i)) {
                continue;
            }

            const allColumnNames = resolvedTables.flatMap((table) =>
                table.columns.map((column) => column.name)
            );
            const suggestion = bestMatch(tok.value, allColumnNames);
            const range = block.toDocRange(tok.start, tok.end);
            const message = suggestion
                ? `Unknown column '${tok.value}'. Did you mean '${suggestion}'?${staleSuffix}`
                : `Unknown column '${tok.value}'.${staleSuffix}`;
            const diagnostic = new vscode.Diagnostic(range, message, severity);
            diagnostic.source = DIAGNOSTIC_SOURCE;
            diagnostic.code = 'unknown-column';
            diagnostics.push(diagnostic);
            if (suggestion) {
                this.fixMap.set(fixKey(uri, range), [
                    { replacement: suggestion, label: `Change to '${suggestion}'` }
                ]);
            }
        }

        return diagnostics;
    }

    private mapDryRunErrors(
        uri: vscode.Uri,
        block: SqlBlock,
        errors: DryRunError[],
        existing: vscode.Diagnostic[]
    ): vscode.Diagnostic[] {
        const results: vscode.Diagnostic[] = [];
        for (const error of errors) {
            const range = this.rangeForDryRunError(block, error);
            // Deduplicate against an offline diagnostic covering the same span.
            const duplicate = existing.some(
                (diag) =>
                    diag.range.start.isEqual(range.start) &&
                    diag.range.end.isEqual(range.end)
            );
            if (duplicate) {
                continue;
            }

            const synthetic = block.isSyntheticSqlOffset(
                block.lineToSqlOffset(error.lineNumber ?? 1)
            );
            const severity = synthetic
                ? vscode.DiagnosticSeverity.Information
                : vscode.DiagnosticSeverity.Error;
            const diagnostic = new vscode.Diagnostic(range, error.message, severity);
            diagnostic.source = DIAGNOSTIC_SOURCE;
            if (typeof error.number === 'number') {
                diagnostic.code = error.number;
            }
            results.push(diagnostic);

            // Offer a rename fix when the message quotes an identifier and we can
            // find a close match in the schema.
            const quoted = /'([^']+)'/.exec(error.message);
            if (quoted) {
                const schema = this.db.schema;
                const names = [
                    ...schema.tables.map((table) => table.fullName),
                    ...schema.tables.map((table) => table.name),
                    ...schema.tables.flatMap((table) => table.columns.map((column) => column.name))
                ];
                const suggestion = bestMatch(quoted[1], names);
                if (suggestion) {
                    this.fixMap.set(fixKey(uri, range), [
                        { replacement: suggestion, label: `Change to '${suggestion}'` }
                    ]);
                }
            }
        }
        return results;
    }

    private rangeForDryRunError(block: SqlBlock, error: DryRunError): vscode.Range {
        const lineNumber = error.lineNumber ?? 1;
        const lineStart = block.lineToSqlOffset(lineNumber);
        const nextLine =
            lineNumber < block.lineStarts.length
                ? block.lineStarts[lineNumber]
                : block.text.length;
        const lineText = block.text.slice(lineStart, nextLine);

        const quoted = /'([^']+)'/.exec(error.message);
        if (quoted) {
            const needle = quoted[1];
            // Prefer an exact identifier match on this line.
            const patterns = [
                `[${needle}]`,
                `"${needle}"`,
                needle
            ];
            for (const pattern of patterns) {
                const idx = lineText.indexOf(pattern);
                if (idx !== -1) {
                    return block.toDocRange(lineStart + idx, lineStart + idx + pattern.length);
                }
            }
            // Search the whole SQL text as a fallback.
            const globalIdx = block.text.indexOf(needle);
            if (globalIdx !== -1) {
                return block.toDocRange(globalIdx, globalIdx + needle.length);
            }
        }

        // Underline the trimmed contents of the reported line.
        const trimmedStart = lineText.search(/\S/);
        const trimmedEnd = lineText.search(/\s*$/);
        if (trimmedStart === -1) {
            return block.toDocRange(lineStart, Math.min(lineStart + 1, block.text.length));
        }
        return block.toDocRange(
            lineStart + trimmedStart,
            lineStart + (trimmedEnd === -1 ? lineText.length : trimmedEnd)
        );
    }

    public dispose(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}

function fixKey(uri: vscode.Uri, range: vscode.Range): string {
    return `${uri.toString()}|${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function looksLikeColumnContext(
    tokens: ReturnType<typeof tokenizeSql>,
    index: number
): boolean {
    if (isCteDefinitionName(tokens, index)) {
        return false;
    }
    // Walk backwards skipping dots of a multi-part name we already handled.
    for (let i = index - 1; i >= 0; i--) {
        const tok = tokens[i];
        if (tok.kind === 'punct' && (tok.text === ',' || tok.text === '(')) {
            return true;
        }
        if (tok.kind === 'keyword') {
            const lower = tok.value.toLowerCase();
            return (
                lower === 'select' ||
                lower === 'where' ||
                lower === 'and' ||
                lower === 'or' ||
                lower === 'on' ||
                lower === 'set' ||
                lower === 'update' ||
                lower === 'having' ||
                lower === 'by' ||
                lower === 'when' ||
                lower === 'then' ||
                lower === 'else' ||
                lower === 'top' ||
                lower === 'distinct'
            );
        }
        if (tok.kind === 'ident' || (tok.kind === 'punct' && tok.text === '.')) {
            continue;
        }
        return false;
    }
    return false;
}

/**
 * Classic Levenshtein with an early exit when the best candidate is still too far.
 */
interface KnownNameIndex {
    names: string[];
}

function buildKnownNameIndex(schema: SchemaCache, engine: string): KnownNameIndex {
    const multiDb = new Set(schema.tables.map((table) => table.database.toLowerCase())).size > 1;
    const names: string[] = [];
    const seen = new Set<string>();
    const add = (name: string): void => {
        const key = name.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        names.push(name);
    };
    for (const table of schema.tables) {
        if (engine === 'mysql') {
            add(`${table.database}.${table.name}`);
        } else if (engine !== 'postgres' && multiDb) {
            add(table.qualifiedName);
        } else {
            add(table.fullName);
        }
        add(table.name);
    }
    return { names };
}

const MAX_LEVENSHTEIN_CANDIDATES = 250;

/**
 * Classic Levenshtein with length pruning and an early exit.
 */
export function bestMatch(target: string, candidates: string[]): string | undefined {
    if (candidates.length === 0) {
        return undefined;
    }
    const needle = target.toLowerCase();
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    const maxDistance = Math.max(2, Math.floor(needle.length / 2));
    let considered = 0;

    for (const candidate of candidates) {
        const other = candidate.toLowerCase();
        if (Math.abs(other.length - needle.length) > maxDistance) {
            continue;
        }
        if (considered >= MAX_LEVENSHTEIN_CANDIDATES && bestDistance <= 2) {
            break;
        }
        considered++;
        const distance = levenshtein(needle, other, maxDistance);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
            if (bestDistance === 1) {
                break;
            }
        }
    }
    if (best === undefined || bestDistance > maxDistance || bestDistance === 0) {
        return undefined;
    }
    return best;
}

function levenshtein(a: string, b: string, maxDistance: number): number {
    if (a === b) {
        return 0;
    }
    if (Math.abs(a.length - b.length) > maxDistance) {
        return maxDistance + 1;
    }
    if (a.length === 0) {
        return b.length;
    }
    if (b.length === 0) {
        return a.length;
    }

    let prev = new Array<number>(b.length + 1);
    let curr = new Array<number>(b.length + 1);
    for (let j = 0; j <= b.length; j++) {
        prev[j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        let rowMin = curr[0];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            curr[j] = value;
            if (value < rowMin) {
                rowMin = value;
            }
        }
        if (rowMin > maxDistance) {
            return maxDistance + 1;
        }
        const swap = prev;
        prev = curr;
        curr = swap;
    }
    return prev[b.length];
}
