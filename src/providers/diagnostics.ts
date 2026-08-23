import * as vscode from 'vscode';
import {
    DryRunError,
    SchemaCache,
    SqlServerService,
    TableInfo,
    TableDatabasePreferences,
    splitIdentifier
} from '../db/connection';
import {
    SqlBlock,
    clearDocumentCache,
    collectSelectAliases,
    collectTableRefs,
    extractSqlBlocks,
    tokenizeSql
} from '../parser/sqlExtractor';
import { findSqlFunction } from '../sql/functions';

export interface FixSuggestion {
    replacement: string;
    label: string;
    /** When set, the quick fix stores a table→database preference instead of editing text. */
    preferDatabase?: string;
    preferTableKey?: string;
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
                if (doc.languageId === 'python') {
                    void this.validateDocument(doc, true);
                }
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.languageId === 'python') {
                    void this.validateDocument(doc, true);
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.languageId !== 'python') {
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
            if (doc.languageId === 'python') {
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
        if (!config.enabled || document.languageId !== 'python') {
            this.collection.delete(document.uri);
            return;
        }

        clearDocumentCache(document.uri);
        // Drop previous fixes for this document before rebuilding.
        for (const key of [...this.fixMap.keys()]) {
            if (key.startsWith(document.uri.toString() + '|')) {
                this.fixMap.delete(key);
            }
        }

        const blocks = extractSqlBlocks(document, config.detectByKeyword);
        const schema = this.db.schema;
        const diagnostics: vscode.Diagnostic[] = [];
        const ambiguousToPrompt: { table: string; matches: TableInfo[] }[] = [];

        for (const block of blocks) {
            const { diagnostics: blockDiags, ambiguous } = this.offlineValidate(
                document.uri,
                block,
                schema
            );
            diagnostics.push(...blockDiags);
            for (const item of ambiguous) {
                if (!ambiguousToPrompt.some((existing) => existing.table === item.table)) {
                    ambiguousToPrompt.push(item);
                }
            }
        }

        if (includeDryRun) {
            for (const item of ambiguousToPrompt) {
                void this.db.promptTableDatabasePreference(item.table, item.matches);
            }
        }

        if (includeDryRun && config.dryRunOnSave) {
            for (const block of blocks) {
                const result = await this.db.dryRun(block.text);
                if (result.kind === 'errors') {
                    diagnostics.push(
                        ...this.mapDryRunErrors(document.uri, block, result.errors, diagnostics)
                    );
                }
            }
        }

        this.collection.set(document.uri, diagnostics);
    }

    public async revalidateOpenDocuments(includeDryRun: boolean): Promise<void> {
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'python') {
                await this.validateDocument(doc, includeDryRun);
            }
        }
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
        schema: SchemaCache
    ): { diagnostics: vscode.Diagnostic[]; ambiguous: { table: string; matches: TableInfo[] }[] } {
        if (schema.isEmpty) {
            return { diagnostics: [], ambiguous: [] };
        }

        const { refs, aliasToTable, hasCte, hasDerived, hasExec } = collectTableRefs(block.text);
        if (hasCte || hasDerived || hasExec) {
            // Skip noisy false positives for shapes we do not fully model.
            // Still validate the table names themselves when present.
        }

        const diagnostics: vscode.Diagnostic[] = [];
        const ambiguous: { table: string; matches: TableInfo[] }[] = [];
        const severity = schema.stale
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error;
        const staleSuffix = schema.stale ? ' (from cached schema, not yet refreshed)' : '';

        const config = this.db.getConfig();
        const multiDb = new Set(schema.tables.map((table) => table.database.toLowerCase())).size > 1;
        const knownTableNames = schema.tables.map((table) =>
            config.engine === 'mysql'
                ? `${table.database}.${table.name}`
                : multiDb
                  ? table.qualifiedName
                  : table.fullName
        );
        const knownBareNames = schema.tables.map((table) => table.name);

        for (const ref of refs) {
            const matches = schema.findTableMatches(ref.table);
            const table = schema.findTable(
                ref.table,
                config.tableDatabasePreferences,
                config.database
            );
            const range = block.toDocRange(ref.start, ref.end);

            if (
                matches.length > 1 &&
                schema.isCrossDatabaseAmbiguous(ref.table) &&
                !hasPreferenceFor(ref.table, config.tableDatabasePreferences)
            ) {
                const dbNames = uniqueDatabases(matches);
                const message = `Table '${ref.table}' exists in ${dbNames.join(' and ')}. Choose which database to prefer.${staleSuffix}`;
                const diagnostic = new vscode.Diagnostic(
                    range,
                    message,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.source = DIAGNOSTIC_SOURCE;
                diagnostic.code = 'ambiguous-table';
                diagnostics.push(diagnostic);
                this.fixMap.set(
                    fixKey(uri, range),
                    dbNames.map((database) => ({
                        replacement: ref.table,
                        label: `Prefer database '${database}' for '${ref.table}'`,
                        preferDatabase: database,
                        preferTableKey: preferenceKeyFor(ref.table)
                    }))
                );
                if (!ambiguous.some((item) => item.table === ref.table)) {
                    ambiguous.push({ table: ref.table, matches });
                }
                // Still resolve via default DB for column checks until the user picks.
            }

            if (table) {
                continue;
            }
            const suggestion = bestMatch(ref.table, [...knownTableNames, ...knownBareNames]);
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

        // Column checks: skip when CTE / derived / EXEC would make them unreliable.
        if (hasCte || hasDerived || hasExec) {
            return { diagnostics, ambiguous };
        }

        const resolvedTables: TableInfo[] = [];
        let allResolved = refs.length > 0;
        for (const ref of refs) {
            const table = schema.findTable(
                ref.table,
                config.tableDatabasePreferences,
                config.database
            );
            if (table) {
                resolvedTables.push(table);
            } else {
                allResolved = false;
            }
        }

        const tokens = tokenizeSql(block.text);
        const selectAliases = collectSelectAliases(block.text);

        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (tok.kind !== 'ident') {
                continue;
            }

            // Skip identifiers that are themselves table references we already checked.
            if (refs.some((ref) => tok.start >= ref.start && tok.end <= ref.end)) {
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
                    // Unknown alias — leave alone; could be a CTE we skipped.
                    i += 2;
                    continue;
                }
                const table = schema.findTable(
                    tableName,
                    config.tableDatabasePreferences,
                    config.database
                );
                if (!table) {
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
            if (!allResolved || resolvedTables.length === 0) {
                continue;
            }
            // Skip if this token is used as an alias definition.
            if (refs.some((ref) => ref.alias.toLowerCase() === tok.value.toLowerCase())) {
                continue;
            }
            // Skip schema / table name tokens already covered.
            if (schema.findTable(tok.value, config.tableDatabasePreferences, config.database)) {
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

        return { diagnostics, ambiguous };
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

function uniqueDatabases(tables: TableInfo[]): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const table of tables) {
        const key = table.database.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(table.database);
    }
    return names;
}

function preferenceKeyFor(reference: string): string {
    const parts = splitIdentifier(reference).filter((part) => part.length > 0);
    if (parts.length === 0) {
        return reference.toLowerCase();
    }
    if (parts.length === 1) {
        return parts[0].toLowerCase();
    }
    return `${parts[parts.length - 2].toLowerCase()}.${parts[parts.length - 1].toLowerCase()}`;
}

function hasPreferenceFor(
    reference: string,
    preferences: TableDatabasePreferences
): boolean {
    const key = preferenceKeyFor(reference);
    if (preferences[key]) {
        return true;
    }
    const parts = splitIdentifier(reference).filter((part) => part.length > 0);
    if (parts.length >= 1 && preferences[parts[parts.length - 1].toLowerCase()]) {
        return true;
    }
    return false;
}

/**
 * Classic Levenshtein with an early exit when the best candidate is still too far.
 */
export function bestMatch(target: string, candidates: string[]): string | undefined {
    if (candidates.length === 0) {
        return undefined;
    }
    const needle = target.toLowerCase();
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    const maxDistance = Math.max(2, Math.floor(needle.length / 2));

    for (const candidate of candidates) {
        const distance = levenshtein(needle, candidate.toLowerCase());
        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
        }
    }
    if (best === undefined || bestDistance > maxDistance || bestDistance === 0) {
        return undefined;
    }
    return best;
}

function levenshtein(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    if (a.length === 0) {
        return b.length;
    }
    if (b.length === 0) {
        return a.length;
    }
    const rows = a.length + 1;
    const cols = b.length + 1;
    const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = 0; i < rows; i++) {
        matrix[i][0] = i;
    }
    for (let j = 0; j < cols; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    return matrix[a.length][b.length];
}
