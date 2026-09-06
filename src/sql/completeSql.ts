import { ColumnInfo, SchemaCache, SqlServerService, TableInfo, defaultSchemaForEngine } from '../db/connection';
import { SqlBlock } from '../parser/sqlExtractor';
import { findRelation, resolveCteTables } from './cteSchema';
import {
    SqlFunctionInfo,
    functionsForEngine,
    quoteIdent
} from './functions';

/** Keep the popup small. More typing asks again with a tighter filter. */
const MAX_COMPLETION_ITEMS = 80;
const EMPTY_PREFIX_FUNCTION_LIMIT = 16;
const EMPTY_PREFIX_KEYWORD_LIMIT = 20;

/**
 * Common next-clause phrases on an empty prefix. Prefer the pair people
 * actually type (`ORDER BY`, not a bare `ORDER`).
 */
const CLAUSE_PHRASES = [
    'select',
    'insert into',
    'update',
    'delete from',
    'with',
    'from',
    'where',
    'join',
    'left join',
    'inner join',
    'right join',
    'group by',
    'order by',
    'having',
    'limit',
    'union',
    'union all',
    'distinct',
    'case',
    'as',
    'set',
    'values'
] as const;

/** Full phrase list once the user has started a word. */
const KEYWORD_PHRASES = [
    ...CLAUSE_PHRASES,
    'and',
    'or',
    'not',
    'not in',
    'not exists',
    'not like',
    'not null',
    'is null',
    'is not null',
    'in',
    'like',
    'between',
    'exists',
    'on',
    'into',
    'full join',
    'full outer join',
    'cross join',
    'cross apply',
    'outer apply',
    'partition by',
    'offset',
    'top',
    'except',
    'intersect',
    'when',
    'then',
    'else',
    'end',
    'create table',
    'alter table',
    'drop table',
    'create view',
    'drop view',
    'create index',
    'over',
    'asc',
    'desc',
    'fetch next',
    'begin',
    'commit',
    'rollback',
    'declare',
    'exec',
    'execute',
    'if',
    'while',
    'return',
    'true',
    'false',
    'null'
] as const;

/** After the user typed the first word, offer the rest of the pair. */
const FOLLOW_ONS: Readonly<Record<string, readonly string[]>> = {
    order: ['by'],
    group: ['by'],
    partition: ['by'],
    insert: ['into'],
    delete: ['from'],
    left: ['join', 'outer join'],
    right: ['join', 'outer join'],
    inner: ['join'],
    full: ['join', 'outer join'],
    cross: ['join', 'apply'],
    outer: ['join', 'apply'],
    union: ['all'],
    is: ['null', 'not null'],
    not: ['null', 'in', 'exists', 'like', 'between'],
    create: ['table', 'view', 'index'],
    drop: ['table', 'view', 'index'],
    alter: ['table'],
    fetch: ['next']
};

export type PlainCompletionKind = 'table' | 'column' | 'function' | 'alias' | 'keyword';

export interface PlainCompletion {
    label: string;
    insertText: string;
    detail: string;
    kind: PlainCompletionKind;
    description?: string;
    sortText?: string;
    filterText?: string;
}

export interface SqlCompletionHit {
    item: PlainCompletion;
    table?: TableInfo;
    column?: ColumnInfo;
    functionName?: string;
    snippet?: string;
}

export interface SqlCompletionResult {
    items: SqlCompletionHit[];
    truncated: boolean;
    prefixLength: number;
    /** Characters of the current token to overwrite, including brackets. */
    replaceLength: number;
}

interface SchemaMeta {
    schema: SchemaCache;
    engine: string;
    database: string;
    multiDb: boolean;
}

/**
 * Schema-aware completions for a raw SQL string. Python IntelliSense and
 * `.sql` editors both call this.
 */
export class SqlCompleter {
    private schemaMeta: SchemaMeta | undefined;
    private functionItemsCache: { engine: string; items: SqlCompletionHit[] } | undefined;

    constructor(private readonly db: SqlServerService) {}

    public complete(sql: string, offset: number): SqlCompletionResult | undefined {
        const schema = this.db.schema;
        const config = this.db.getConfig();
        const clamped = Math.max(0, Math.min(offset, sql.length));
        const block = SqlBlock.fromText(sql);
        const analysis = block.analyze();
        const findTable = (reference: string) =>
            schema.findTable(
                reference,
                config.database,
                defaultSchemaForEngine(config.engine) ?? 'dbo'
            );
        const ctes = resolveCteTables(analysis.tokens, findTable);
        const lookup = (reference: string) => findRelation(reference, findTable, ctes);
        const before = sql.slice(0, clamped);
        const { context: sqlBefore, prefix, replaceLength } = takeTypedPrefix(before);
        const prefixLength = prefix.length;
        const items: SqlCompletionHit[] = [];
        let truncated = false;

        const dotMatch = /([A-Za-z_][\w$]*|\[(?:[^\]]|\]\])+\])\s*\.\s*$/.exec(sqlBefore);
        if (dotMatch) {
            const aliasOrTable = stripBrackets(dotMatch[1]);
            const { aliasToTable } = analysis;
            const aliasKey = aliasOrTable.toLowerCase();
            const aliased = aliasToTable.get(aliasKey);
            if (aliased) {
                const table = lookup(aliased);
                if (table) {
                    this.addColumnItems(items, table, prefix);
                    return {
                        items,
                        truncated: items.length >= MAX_COMPLETION_ITEMS,
                        prefixLength,
                        replaceLength
                    };
                }
            }
            const qualifierTables = tablesInQualifier(schema.tables, aliasOrTable);
            if (qualifierTables.length > 0) {
                const picked = pickTables(qualifierTables, prefix, qualifierTables.length);
                const multiDb = this.getSchemaMeta().multiDb;
                for (const dbTable of picked.tables) {
                    items.push(this.tableHit(dbTable, '0', multiDb, true));
                }
                return { items, truncated: false, prefixLength, replaceLength };
            }
            const table = lookup(aliasOrTable);
            if (table) {
                this.addColumnItems(items, table, prefix);
                return {
                    items,
                    truncated: items.length >= MAX_COMPLETION_ITEMS,
                    prefixLength,
                    replaceLength
                };
            }
            return { items, truncated: false, prefixLength, replaceLength };
        }

        if (/\b(from|join|into|update|table)\s+$/i.test(sqlBefore)) {
            const built = this.buildTableItems(prefix, schema.tables.length + 8, ctes);
            if (!prefix) {
                return { items: built.items, truncated: built.truncated, prefixLength, replaceLength };
            }
            const keywords = this.pickKeywordItems(prefix, MAX_COMPLETION_ITEMS - built.items.length, '2');
            return {
                items: built.items.concat(keywords.items),
                truncated: built.truncated || keywords.truncated,
                prefixLength,
                replaceLength
            };
        }

        const followLead = lastSqlWord(sqlBefore);
        const followPhrases = FOLLOW_ONS[followLead];
        if (followPhrases) {
            const follows = this.pickPhraseItems(followPhrases, prefix, MAX_COMPLETION_ITEMS, '0');
            if (follows.items.length > 0 || !prefix) {
                return {
                    items: follows.items,
                    truncated: follows.truncated,
                    prefixLength,
                    replaceLength
                };
            }
        }

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
                const table = lookup(ref.table);
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
                    items.push(this.columnHit(column, table, '0'));
                    if (items.length >= MAX_COMPLETION_ITEMS) {
                        truncated = true;
                        break;
                    }
                }
            }
            for (const [alias, tableName] of aliasToTable) {
                const table = lookup(tableName);
                if (!table || !nameMatches(alias, prefix)) {
                    continue;
                }
                items.push({
                    item: {
                        label: alias,
                        insertText: alias,
                        detail: table.fullName,
                        kind: 'alias',
                        sortText: `1_${alias}`
                    }
                });
            }
            const keywords = this.pickKeywordItems(prefix, MAX_COMPLETION_ITEMS - items.length, '1');
            truncated = truncated || keywords.truncated;
            items.push(...keywords.items);
            const functions = this.pickFunctionItems(prefix, MAX_COMPLETION_ITEMS - items.length);
            truncated = truncated || functions.truncated;
            items.push(...functions.items);
            return { items, truncated, prefixLength, replaceLength };
        }

        if (!prefix) {
            const keywords = this.pickKeywordItems('', MAX_COMPLETION_ITEMS, '0');
            if (keywords.items.length === 0) {
                return undefined;
            }
            return { items: keywords.items, truncated: keywords.truncated, prefixLength, replaceLength };
        }
        const mixed = this.mixedNameList(prefix, ctes);
        return { items: mixed.items, truncated: mixed.truncated, prefixLength, replaceLength };
    }

    private mixedNameList(
        prefix: string,
        ctes?: Map<string, TableInfo>
    ): { items: SqlCompletionHit[]; truncated: boolean } {
        // Keywords first so SELECT/FROM are not dropped when many tables match.
        const keywords = this.pickKeywordItems(prefix, MAX_COMPLETION_ITEMS, '0');
        const remainingAfterKw = MAX_COMPLETION_ITEMS - keywords.items.length;
        const tables = this.buildTableItems(prefix, remainingAfterKw, ctes);
        const remaining = remainingAfterKw - tables.items.length;
        const functions = this.pickFunctionItems(prefix, remaining);
        return {
            items: keywords.items.concat(tables.items, functions.items),
            truncated: keywords.truncated || tables.truncated || functions.truncated
        };
    }

    private buildTableItems(
        prefix: string,
        limit: number,
        ctes?: Map<string, TableInfo>
    ): { items: SqlCompletionHit[]; truncated: boolean } {
        const meta = this.getSchemaMeta();
        const items: SqlCompletionHit[] = [];
        let truncated = false;
        if (ctes) {
            for (const cte of ctes.values()) {
                if (!nameMatches(cte.name, prefix)) {
                    continue;
                }
                if (items.length >= limit) {
                    truncated = true;
                    break;
                }
                items.push(this.cteHit(cte, '0'));
            }
        }
        for (const table of meta.schema.tables) {
            if (!tableMatchesPrefix(table, prefix)) {
                continue;
            }
            if (items.length >= limit) {
                truncated = true;
                break;
            }
            items.push(this.tableHit(table, '0', meta.multiDb));
        }
        return { items, truncated };
    }

    private addColumnItems(items: SqlCompletionHit[], table: TableInfo, prefix: string): void {
        for (const column of table.columns) {
            if (!nameMatches(column.name, prefix)) {
                continue;
            }
            items.push(this.columnHit(column, table, '0'));
            if (items.length >= MAX_COMPLETION_ITEMS) {
                return;
            }
        }
    }

    private pickFunctionItems(
        prefix: string,
        limit: number
    ): { items: SqlCompletionHit[]; truncated: boolean } {
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
        const matched: SqlCompletionHit[] = [];
        let truncated = false;
        for (const hit of all) {
            if (!nameMatches(hit.item.label, prefix)) {
                continue;
            }
            if (matched.length >= limit) {
                truncated = true;
                break;
            }
            matched.push(hit);
        }
        return { items: matched, truncated };
    }

    private pickKeywordItems(
        prefix: string,
        limit: number,
        sortPrefix: string
    ): { items: SqlCompletionHit[]; truncated: boolean } {
        return this.pickPhraseItems(
            prefix ? KEYWORD_PHRASES : CLAUSE_PHRASES,
            prefix,
            limit,
            sortPrefix
        );
    }

    private pickPhraseItems(
        source: readonly string[],
        prefix: string,
        limit: number,
        sortPrefix: string
    ): { items: SqlCompletionHit[]; truncated: boolean } {
        if (limit <= 0) {
            return { items: [], truncated: true };
        }
        const cap = prefix ? limit : Math.min(EMPTY_PREFIX_KEYWORD_LIMIT, limit);
        const items: SqlCompletionHit[] = [];
        let truncated = false;
        for (const phrase of source) {
            if (!phraseMatches(phrase, prefix)) {
                continue;
            }
            if (items.length >= cap) {
                truncated = true;
                break;
            }
            items.push(this.keywordHit(phrase, sortPrefix));
        }
        return { items, truncated };
    }

    private getFunctionItems(): SqlCompletionHit[] {
        const engine = this.db.getConfig().engine;
        const hit = this.functionItemsCache;
        if (hit && hit.engine === engine) {
            return hit.items;
        }
        const items = functionsForEngine(engine).map((fn) => this.functionHit(fn, '2'));
        this.functionItemsCache = { engine, items };
        return items;
    }

    private getSchemaMeta(): SchemaMeta {
        const config = this.db.getConfig();
        const schema = this.db.schema;
        const hit = this.schemaMeta;
        if (
            hit &&
            hit.schema === schema &&
            hit.engine === config.engine &&
            hit.database === config.database
        ) {
            return hit;
        }
        const multiDb =
            new Set(schema.tables.map((entry) => entry.database.toLowerCase())).size > 1;
        this.schemaMeta = {
            schema,
            engine: config.engine,
            database: config.database,
            multiDb
        };
        return this.schemaMeta;
    }

    private tableHit(
        table: TableInfo,
        sortPrefix: string,
        multiDb: boolean,
        nameOnly = false
    ): SqlCompletionHit {
        const config = this.db.getConfig();
        const engine = config.engine;
        const defaultSchema = defaultSchemaForEngine(engine);
        const qualified =
            quoteIdent(table.schema, engine) === table.schema &&
            defaultSchema !== undefined &&
            table.schema.toLowerCase() === defaultSchema
                ? quoteIdent(table.name, engine)
                : `${quoteIdent(table.schema, engine)}.${quoteIdent(table.name, engine)}`;
        let insertText = nameOnly
            ? quoteIdent(table.name, engine)
            : engine === 'mysql' &&
                table.schema.toLowerCase() === config.database.toLowerCase()
              ? quoteIdent(table.name, engine)
              : qualified;
        if (!nameOnly && multiDb && engine !== 'postgres') {
            insertText =
                engine === 'mysql'
                    ? `${quoteIdent(table.database, engine)}.${quoteIdent(table.name, engine)}`
                    : `${quoteIdent(table.database, engine)}.${qualified}`;
        }
        const displayName =
            engine === 'mysql'
                ? `${table.database}.${table.name}`
                : multiDb
                  ? table.qualifiedName
                  : table.fullName;
        const detail = multiDb
            ? `${table.isView ? 'view' : 'table'} · ${table.database}`
            : table.isView
              ? 'view'
              : 'table';
        return {
            item: {
                label: displayName,
                insertText,
                detail,
                kind: 'table',
                filterText: `${table.name} ${displayName}`,
                sortText: `${sortPrefix}_${displayName.toLowerCase()}`
            },
            table
        };
    }

    private cteHit(table: TableInfo, sortPrefix: string): SqlCompletionHit {
        return {
            item: {
                label: table.name,
                insertText: table.name,
                detail: 'CTE',
                kind: 'table',
                filterText: table.name,
                sortText: `${sortPrefix}_cte_${table.name.toLowerCase()}`
            },
            table
        };
    }

    private columnHit(
        column: ColumnInfo,
        table: TableInfo,
        sortPrefix: string
    ): SqlCompletionHit {
        const engine = this.db.getConfig().engine;
        return {
            item: {
                label: column.name,
                insertText: quoteIdent(column.name, engine),
                detail: `${column.typeDisplay}${column.isNullable ? ' NULL' : ' NOT NULL'}`,
                kind: 'column',
                description: table.name,
                filterText: column.name,
                sortText: `${sortPrefix}_${column.ordinal.toString().padStart(4, '0')}_${column.name.toLowerCase()}`
            },
            table,
            column
        };
    }

    private keywordHit(name: string, sortPrefix: string): SqlCompletionHit {
        const text = formatKeyword(name, this.db.getConfig().formatKeywordCase);
        // Plain text, not a snippet. Cursor drops CompletionItem.range on
        // SnippetString, so Enter would insert SELECT after sel.
        return {
            item: {
                label: text,
                insertText: `${text} `,
                detail: 'keyword',
                kind: 'keyword',
                filterText: name,
                sortText: `${sortPrefix}_${name}`
            }
        };
    }

    private functionHit(fn: SqlFunctionInfo, sortPrefix: string): SqlCompletionHit {
        return {
            item: {
                label: fn.name,
                insertText: flattenSnippet(fn.snippet),
                detail: fn.detail,
                kind: 'function',
                filterText: fn.name,
                sortText: `${sortPrefix}_${fn.name.toLowerCase()}`
            },
            functionName: fn.name,
            snippet: fn.snippet
        };
    }
}

function formatKeyword(
    name: string,
    keywordCase: string | undefined
): string {
    return keywordCase === 'lower' ? name.toLowerCase() : name.toUpperCase();
}

function phraseMatches(phrase: string, prefix: string): boolean {
    if (!prefix) {
        return true;
    }
    const lower = prefix.toLowerCase();
    if (phrase.includes(lower)) {
        return true;
    }
    return phrase.split(' ').some((word) => word.includes(lower));
}

function lastSqlWord(text: string): string {
    const match = /([A-Za-z_][\w$]*)\s*$/.exec(text);
    return match ? match[1].toLowerCase() : '';
}

function flattenSnippet(snippet: string): string {
    return snippet.replace(/\$\{\d+:([^}]+)\}/g, '$1').replace(/\$\d+/g, '');
}

function tablesInQualifier(tables: readonly TableInfo[], qualifier: string): TableInfo[] {
    const key = qualifier.toLowerCase();
    return tables.filter(
        (table) =>
            table.database.toLowerCase() === key || table.schema.toLowerCase() === key
    );
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

function tableMatchesPrefix(table: TableInfo, prefix: string): boolean {
    if (nameMatches(table.name, prefix) || nameMatches(table.schema, prefix)) {
        return true;
    }
    return prefix.length >= 3 && nameMatches(table.database, prefix);
}

function nameMatches(text: string, prefix: string): boolean {
    if (!prefix) {
        return true;
    }
    return text.toLowerCase().includes(prefix.toLowerCase());
}

function takeTypedPrefix(before: string): {
    context: string;
    prefix: string;
    replaceLength: number;
} {
    const match = /([A-Za-z_][\w$]*|\[(?:[^\]]|\]\])+\])$/.exec(before);
    if (!match) {
        return { context: before, prefix: '', replaceLength: 0 };
    }
    return {
        context: before.slice(0, -match[0].length),
        prefix: stripBrackets(match[0]),
        replaceLength: match[0].length
    };
}

const IDENT_PATH =
    /(?:[A-Za-z_][\w$]*|\[(?:[^\]]|\]\])+\])(?:\s*\.\s*(?:[A-Za-z_][\w$]*|\[(?:[^\]]|\]\])+\])?)*$/;

/** Dotted name under the caret (`db.schema.tab`), spaces around dots stripped. */
export function currentIdentPath(before: string): string {
    const match = IDENT_PATH.exec(before);
    return match ? match[0].replace(/\s+/g, '') : '';
}

export interface CompletionFit {
    /** Text to insert at the caret. Already-typed letters are omitted. */
    addition: string;
    /** True when the last token is not a prefix of the suggestion and must be deleted. */
    replaceToken: boolean;
    /** Suggestion spelling of the typed path, when only the case differs. */
    recase?: string;
}

/**
 * Cursor ignores CompletionItem.range, so Enter appends. Return only the
 * leftover so `datalign_ghma.roles_pol` + table name becomes `…icy_groups`.
 */
export function completionFit(path: string, suggestion: string): CompletionFit {
    if (!suggestion) {
        return { addition: '', replaceToken: false };
    }
    if (!path) {
        return { addition: suggestion, replaceToken: false };
    }
    const pathLower = path.toLowerCase();
    const suggestionLower = suggestion.toLowerCase();
    if (suggestionLower.startsWith(pathLower)) {
        const addition = suggestion.slice(path.length);
        const recase = suggestion.slice(0, path.length);
        return recase === path
            ? { addition, replaceToken: false }
            : { addition, replaceToken: false, recase };
    }
    const lastDot = path.lastIndexOf('.');
    const last = lastDot === -1 ? path : path.slice(lastDot + 1);
    if (last) {
        const lastLower = last.toLowerCase();
        let from = 0;
        while (from < suggestion.length) {
            const idx = suggestionLower.indexOf(lastLower, from);
            if (idx === -1) {
                break;
            }
            const atStart = idx === 0 || suggestion[idx - 1] === '.';
            if (atStart) {
                return { addition: suggestion.slice(idx + last.length), replaceToken: false };
            }
            from = idx + 1;
        }
    }
    return { addition: suggestion, replaceToken: last.length > 0 };
}

function stripBrackets(name: string): string {
    if (name.startsWith('[') && name.endsWith(']')) {
        return name.slice(1, -1).replace(/\]\]/g, ']');
    }
    return name;
}
