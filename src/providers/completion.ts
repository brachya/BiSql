import * as vscode from 'vscode';
import { ColumnInfo, SchemaCache, SqlServerService, TableInfo } from '../db/connection';
import { findBlockAtPosition } from '../parser/sqlExtractor';
import {
    SqlFunctionInfo,
    findSqlFunction,
    functionMarkdown,
    functionsForEngine,
    quoteIdent
} from '../sql/functions';

interface ItemPayload {
    kind: 'table' | 'column' | 'function';
    table?: TableInfo;
    column?: ColumnInfo;
    functionName?: string;
}

const PAYLOAD = new WeakMap<vscode.CompletionItem, ItemPayload>();

/** Keep the popup small. More typing asks again with a tighter filter. */
const MAX_COMPLETION_ITEMS = 80;
const EMPTY_PREFIX_FUNCTION_LIMIT = 16;

interface SchemaMeta {
    schema: SchemaCache;
    engine: string;
    database: string;
    prefsKey: string;
    multiDb: boolean;
}

interface FunctionItemCache {
    engine: string;
    items: vscode.CompletionItem[];
}

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
    private schemaMeta: SchemaMeta | undefined;
    private functionItemsCache: FunctionItemCache | undefined;

    constructor(private readonly db: SqlServerService) {}

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionList> {
        const config = this.db.getConfig();
        if (!config.enabled || document.languageId !== 'python') {
            return undefined;
        }

        const hit = findBlockAtPosition(document, position, config.detectByKeyword);
        if (!hit) {
            return undefined;
        }

        // Closing quote sits at the block end — findBlockAtPosition already missed it.
        if (
            context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
            (context.triggerCharacter === "'" || context.triggerCharacter === '"')
        ) {
            const offset = document.offsetAt(position);
            if (offset <= hit.block.docStart || offset >= hit.block.docEnd) {
                return undefined;
            }
        }

        const schema = this.db.schema;
        if (schema.isEmpty) {
            return undefined;
        }

        const { block, sqlOffset } = hit;
        const analysis = block.analyze();
        const before = block.text.slice(0, sqlOffset);
        // Keep the last keyword as the context while the user types a name.
        const { context: sqlBefore, prefix } = takeTypedPrefix(before);
        const items: vscode.CompletionItem[] = [];
        let truncated = false;

        // alias. or table. → columns of that relation
        const dotMatch = /([A-Za-z_][\w$]*|\[(?:[^\]]|\]\])+\])\s*\.\s*$/.exec(sqlBefore);
        if (dotMatch) {
            const aliasOrTable = stripBrackets(dotMatch[1]);
            const { aliasToTable } = analysis;
            const tableName =
                aliasToTable.get(aliasOrTable.toLowerCase()) ?? aliasOrTable;
            const table = schema.findTable(
                tableName,
                config.tableDatabasePreferences,
                config.database
            );
            if (table) {
                this.addColumnItems(items, table, prefix);
                return completeList(items, items.length >= MAX_COMPLETION_ITEMS);
            }
            const dbKey = aliasOrTable.toLowerCase();
            const dbTables = schema.tables.filter(
                (entry) => entry.database.toLowerCase() === dbKey
            );
            const picked = pickTables(dbTables, prefix, MAX_COMPLETION_ITEMS);
            const multiDb = this.getSchemaMeta().multiDb;
            for (const dbTable of picked.tables) {
                items.push(this.tableItem(dbTable, '0', multiDb));
            }
            return completeList(items, picked.truncated);
        }

        // After FROM / JOIN / INTO / UPDATE / TABLE → tables
        if (/\b(from|join|into|update|table)\s+$/i.test(sqlBefore)) {
            return this.tableList(prefix);
        }

        // After SELECT / WHERE / AND / OR / ON / SET / HAVING / GROUP BY / ORDER BY / ,
        const columnContext =
            /\b(select|where|and|or|on|set|having|when|then|else|by)\s+$/i.test(sqlBefore) ||
            /,\s*$/.test(sqlBefore) ||
            /\(\s*$/.test(sqlBefore);

        if (columnContext) {
            const { refs, aliasToTable } = analysis;
            const seen = new Set<string>();
            for (const ref of refs) {
                if (items.length >= MAX_COMPLETION_ITEMS) {
                    truncated = true;
                    break;
                }
                const table = schema.findTable(
                    ref.table,
                    config.tableDatabasePreferences,
                    config.database
                );
                if (!table) {
                    continue;
                }
                for (const column of table.columns) {
                    if (!nameMatches(column.name, prefix)) {
                        continue;
                    }
                    const key = `${table.qualifiedName}.${column.name}`.toLowerCase();
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    items.push(this.columnItem(column, table, '0'));
                    if (items.length >= MAX_COMPLETION_ITEMS) {
                        truncated = true;
                        break;
                    }
                }
            }
            // Also offer alias.column forms when aliases exist.
            for (const [alias, tableName] of aliasToTable) {
                const table = schema.findTable(
                    tableName,
                    config.tableDatabasePreferences,
                    config.database
                );
                if (!table) {
                    continue;
                }
                if (!nameMatches(alias, prefix)) {
                    continue;
                }
                const aliasItem = new vscode.CompletionItem(
                    alias,
                    vscode.CompletionItemKind.Variable
                );
                aliasItem.detail = table.fullName;
                aliasItem.filterText = alias;
                aliasItem.sortText = `1_${alias}`;
                items.push(aliasItem);
            }
            const functions = this.pickFunctionItems(prefix, MAX_COMPLETION_ITEMS - items.length);
            truncated = truncated || functions.truncated;
            items.push(...functions.items);
            return completeList(items, truncated);
        }

        // Default: only search when the user has started a name. Dumping every
        // table + function on an empty prefix made the popup hang on large schemas.
        if (!prefix) {
            return undefined;
        }
        return this.mixedNameList(prefix);
    }

    public resolveCompletionItem(
        item: vscode.CompletionItem,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem> {
        const payload = PAYLOAD.get(item);
        if (!payload) {
            return item;
        }
        if (payload.kind === 'table' && payload.table) {
            item.documentation = tableMarkdown(payload.table);
        } else if (payload.kind === 'column' && payload.table && payload.column) {
            item.documentation = columnMarkdown(payload.table, payload.column);
        } else if (payload.kind === 'function' && payload.functionName) {
            const fn = findSqlFunction(payload.functionName, this.db.getConfig().engine);
            if (fn) {
                item.documentation = new vscode.MarkdownString(functionMarkdown(fn));
            }
        }
        return item;
    }

    private tableList(prefix: string): vscode.CompletionList {
        const built = this.buildTableItems(prefix, MAX_COMPLETION_ITEMS);
        return completeList(built.items, built.truncated);
    }

    private mixedNameList(prefix: string): vscode.CompletionList {
        const tables = this.buildTableItems(prefix, MAX_COMPLETION_ITEMS);
        const remaining = MAX_COMPLETION_ITEMS - tables.items.length;
        const functions = this.pickFunctionItems(prefix, remaining);
        return completeList(
            tables.items.concat(functions.items),
            tables.truncated || functions.truncated
        );
    }

    private buildTableItems(
        prefix: string,
        limit: number
    ): { items: vscode.CompletionItem[]; truncated: boolean } {
        const meta = this.getSchemaMeta();
        const config = this.db.getConfig();
        const items: vscode.CompletionItem[] = [];
        let truncated = false;
        const seenBare = new Set<string>();
        for (const table of meta.schema.tables) {
            if (!tableMatchesPrefix(table, prefix)) {
                continue;
            }
            if (items.length >= limit) {
                truncated = true;
                break;
            }
            items.push(this.tableItem(table, '0', meta.multiDb));
            if (!meta.multiDb || items.length >= limit) {
                continue;
            }
            const key = table.name.toLowerCase();
            if (seenBare.has(key) || (prefix && !nameMatches(table.name, prefix))) {
                continue;
            }
            seenBare.add(key);
            const resolved =
                meta.schema.findTable(
                    table.name,
                    config.tableDatabasePreferences,
                    config.database
                ) ?? table;
            items.push(this.bareTableItem(resolved, '0'));
        }
        return { items, truncated };
    }

    private addColumnItems(items: vscode.CompletionItem[], table: TableInfo, prefix: string): void {
        for (const column of table.columns) {
            if (!nameMatches(column.name, prefix)) {
                continue;
            }
            items.push(this.columnItem(column, table, '0'));
            if (items.length >= MAX_COMPLETION_ITEMS) {
                return;
            }
        }
    }

    private pickFunctionItems(
        prefix: string,
        limit: number
    ): { items: vscode.CompletionItem[]; truncated: boolean } {
        if (limit <= 0) {
            return { items: [], truncated: true };
        }
        const all = this.getFunctionItems();
        if (!prefix) {
            return {
                items: all.slice(0, Math.min(EMPTY_PREFIX_FUNCTION_LIMIT, limit)),
                truncated: all.length > Math.min(EMPTY_PREFIX_FUNCTION_LIMIT, limit)
            };
        }
        return pickCachedItems(all, prefix, limit);
    }

    private getFunctionItems(): vscode.CompletionItem[] {
        const engine = this.db.getConfig().engine;
        const hit = this.functionItemsCache;
        if (hit && hit.engine === engine) {
            return hit.items;
        }
        const items = functionsForEngine(engine).map((fn) => this.functionItem(fn, '2'));
        this.functionItemsCache = { engine, items };
        return items;
    }

    private getSchemaMeta(): SchemaMeta {
        const config = this.db.getConfig();
        const schema = this.db.schema;
        const prefsKey = JSON.stringify(config.tableDatabasePreferences);
        const hit = this.schemaMeta;
        if (
            hit &&
            hit.schema === schema &&
            hit.engine === config.engine &&
            hit.database === config.database &&
            hit.prefsKey === prefsKey
        ) {
            return hit;
        }
        const multiDb =
            new Set(schema.tables.map((entry) => entry.database.toLowerCase())).size > 1;
        this.schemaMeta = {
            schema,
            engine: config.engine,
            database: config.database,
            prefsKey,
            multiDb
        };
        return this.schemaMeta;
    }

    private tableItem(
        table: TableInfo,
        sortPrefix: string,
        multiDb: boolean
    ): vscode.CompletionItem {
        const config = this.db.getConfig();
        const engine = config.engine;
        const defaultSchema = engine === 'mysql' ? undefined : 'dbo';
        const label =
            quoteIdent(table.schema, engine) === table.schema &&
            defaultSchema !== undefined &&
            table.schema.toLowerCase() === defaultSchema
                ? quoteIdent(table.name, engine)
                : `${quoteIdent(table.schema, engine)}.${quoteIdent(table.name, engine)}`;
        // For MySQL, prefer bare table name when schema matches the connected database.
        let insertText =
            engine === 'mysql' &&
            table.schema.toLowerCase() === config.database.toLowerCase()
                ? quoteIdent(table.name, engine)
                : label;
        if (multiDb) {
            insertText =
                engine === 'mysql'
                    ? `${quoteIdent(table.database, engine)}.${quoteIdent(table.name, engine)}`
                    : `${quoteIdent(table.database, engine)}.${label}`;
        }
        const displayName =
            engine === 'mysql'
                ? `${table.database}.${table.name}`
                : multiDb
                  ? table.qualifiedName
                  : table.fullName;
        const item = new vscode.CompletionItem(
            displayName,
            table.isView ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class
        );
        item.insertText = insertText;
        // Filter on the table name only. Including the database made every
        // table match while typing (e.g. "user" vs "datalign_users").
        item.filterText = table.name;
        item.detail = multiDb
            ? `${table.isView ? 'view' : 'table'} · ${table.database}`
            : table.isView
              ? 'view'
              : 'table';
        item.sortText = `${sortPrefix}_${displayName.toLowerCase()}`;
        PAYLOAD.set(item, { kind: 'table', table });
        return item;
    }

    private bareTableItem(table: TableInfo, sortPrefix: string): vscode.CompletionItem {
        const engine = this.db.getConfig().engine;
        const insertText = quoteIdent(table.name, engine);
        const item = new vscode.CompletionItem(
            table.name,
            table.isView ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class
        );
        item.insertText = insertText;
        item.filterText = table.name;
        item.detail = table.isView ? 'view · short name' : 'table · short name';
        item.sortText = `${sortPrefix}_${table.name.toLowerCase()}`;
        PAYLOAD.set(item, { kind: 'table', table });
        return item;
    }

    private columnItem(
        column: ColumnInfo,
        table: TableInfo,
        sortPrefix: string
    ): vscode.CompletionItem {
        const engine = this.db.getConfig().engine;
        const item = new vscode.CompletionItem(
            { label: column.name, description: table.name },
            vscode.CompletionItemKind.Field
        );
        item.insertText = quoteIdent(column.name, engine);
        item.detail = `${column.typeDisplay}${column.isNullable ? ' NULL' : ' NOT NULL'}`;
        item.sortText = `${sortPrefix}_${column.ordinal.toString().padStart(4, '0')}_${column.name.toLowerCase()}`;
        item.filterText = column.name;
        PAYLOAD.set(item, { kind: 'column', table, column });
        return item;
    }

    private functionItem(fn: SqlFunctionInfo, sortPrefix: string): vscode.CompletionItem {
        const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
        item.insertText = new vscode.SnippetString(fn.snippet);
        item.detail = fn.detail;
        item.filterText = fn.name;
        item.sortText = `${sortPrefix}_${fn.name.toLowerCase()}`;
        PAYLOAD.set(item, { kind: 'function', functionName: fn.name });
        return item;
    }
}

/**
 * Complete lists let the editor filter as the user types.
 * Incomplete lists are asked again so a large catalog can narrow after more keys.
 */
function completeList(
    items: vscode.CompletionItem[],
    truncated: boolean
): vscode.CompletionList {
    // Re-ask when we hid matches, or when the prefix is still short.
    return new vscode.CompletionList(items, truncated);
}

function pickCachedItems(
    items: readonly vscode.CompletionItem[],
    prefix: string,
    limit: number
): { items: vscode.CompletionItem[]; truncated: boolean } {
    if (limit <= 0) {
        return { items: [], truncated: items.length > 0 };
    }
    if (!prefix) {
        if (items.length <= limit) {
            return { items: items.slice(), truncated: false };
        }
        return { items: items.slice(0, limit), truncated: true };
    }
    const matched: vscode.CompletionItem[] = [];
    let truncated = false;
    for (const item of items) {
        if (!itemMatchesPrefix(item, prefix)) {
            continue;
        }
        if (matched.length >= limit) {
            truncated = true;
            break;
        }
        matched.push(item);
    }
    return { items: matched, truncated };
}

function pickTables(
    tables: readonly TableInfo[],
    prefix: string,
    limit: number
): { tables: TableInfo[]; truncated: boolean } {
    const matched: TableInfo[] = [];
    let truncated = false;
    for (const table of tables) {
        if (!tableMatchesPrefix(table, prefix)) {
            continue;
        }
        if (matched.length >= limit) {
            truncated = true;
            break;
        }
        matched.push(table);
    }
    return { tables: matched, truncated };
}

function itemMatchesPrefix(item: vscode.CompletionItem, prefix: string): boolean {
    const filter = item.filterText ?? labelText(item.label);
    if (nameMatches(filter, prefix)) {
        return true;
    }
    return nameMatches(labelText(item.label), prefix);
}

function labelText(label: string | vscode.CompletionItemLabel): string {
    return typeof label === 'string' ? label : label.label;
}

function tableMatchesPrefix(table: TableInfo, prefix: string): boolean {
    if (nameMatches(table.name, prefix) || nameMatches(table.schema, prefix)) {
        return true;
    }
    // Avoid one-letter prefixes matching every database name.
    return prefix.length >= 3 && nameMatches(table.database, prefix);
}

function nameMatches(text: string, prefix: string): boolean {
    if (!prefix) {
        return true;
    }
    return text.toLowerCase().includes(prefix.toLowerCase());
}

/**
 * Split a trailing identifier so `SELECT use|` still counts as SELECT context.
 */
function takeTypedPrefix(before: string): { context: string; prefix: string } {
    const match = /([A-Za-z_][\w$]*|\[(?:[^\]]|\]\])+\])$/.exec(before);
    if (!match) {
        return { context: before, prefix: '' };
    }
    return {
        context: before.slice(0, -match[0].length),
        prefix: stripBrackets(match[0])
    };
}

function stripBrackets(name: string): string {
    if (name.startsWith('[') && name.endsWith(']')) {
        return name.slice(1, -1).replace(/\]\]/g, ']');
    }
    return name;
}

function tableMarkdown(table: TableInfo): vscode.MarkdownString {
    const title =
        table.database.toLowerCase() === table.schema.toLowerCase()
            ? `${table.database}.${table.name}`
            : table.qualifiedName;
    const lines = [
        `**${title}** ${table.isView ? '(view)' : '(table)'}`,
        '',
        '| | Column | Type | Null |',
        '| --- | --- | --- | --- |'
    ];
    for (const column of table.columns) {
        const pk = column.isPrimaryKey ? 'PK' : '';
        lines.push(
            `| ${pk} | \`${column.name}\` | ${column.typeDisplay} | ${column.isNullable ? 'YES' : 'NO'} |`
        );
    }
    return new vscode.MarkdownString(lines.join('\n'));
}

function columnMarkdown(table: TableInfo, column: ColumnInfo): vscode.MarkdownString {
    const flags: string[] = [];
    if (column.isPrimaryKey) {
        flags.push('PRIMARY KEY');
    }
    if (column.isIdentity) {
        flags.push('IDENTITY');
    }
    if (column.isComputed) {
        flags.push('COMPUTED');
    }
    flags.push(column.isNullable ? 'NULL' : 'NOT NULL');
    return new vscode.MarkdownString(
        [
            `**${table.fullName}.${column.name}**`,
            '',
            `\`${column.typeDisplay}\``,
            '',
            flags.join(' · ')
        ].join('\n')
    );
}

/** Exported for hover docs reuse. */
export function buildTableHover(table: TableInfo): vscode.MarkdownString {
    return tableMarkdown(table);
}

export function buildColumnHover(table: TableInfo, column: ColumnInfo): vscode.MarkdownString {
    return columnMarkdown(table, column);
}
