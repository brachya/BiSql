import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as mssql from 'mssql';
import * as mysql from 'mysql2/promise';
import { FormatKeywordCase, parseKeywordCase } from '../sql/formatEmbeddedSql';
import { lookupParam, rewriteNamedBinds } from '../sql/parameters';
import {
    buildPagedSelect,
    canPageSelect,
    clampOffset,
    clampPageSize,
    QueryPageOptions,
    ResultSort
} from '../sql/resultPage';

export const CONFIG_SECTION = 'bisql';
const LEGACY_CONFIG_SECTION = 'sqlPythonValidator';
const SECRET_KEY_GLOBAL = 'sqlPythonValidator.password.global';
const SECRET_KEY_LEGACY = 'sqlPythonValidator.password';
const SCOPE_STATE_KEY = 'bisql.settingsScope';
const LEGACY_SCOPE_STATE_KEY = 'sqlPythonValidator.settingsScope';
const CACHE_VERSION = 3;

export type DbEngine = 'mssql' | 'mysql';

/** Shared across all projects, or only this workspace. */
export type SettingsScope = 'global' | 'workspace';

/** Maps a bare table name (or schema.table) → preferred database name. */
export type TableDatabasePreferences = Record<string, string>;

const CONNECTION_SETTING_KEYS = [
    'engine',
    'server',
    'database',
    'databases',
    'user',
    'port',
    'encrypt',
    'trustServerCertificate',
    'enabled',
    'password',
    'tableDatabasePreferences'
] as const;

export interface ExtensionConfig {
    enabled: boolean;
    engine: DbEngine;
    server: string;
    /** Default database used for the live pool and dry-run. */
    database: string;
    /** Extra databases whose schema is also loaded (may include `database`). */
    databases: string[];
    user: string;
    passwordSetting: string;
    port: number;
    encrypt: boolean;
    trustServerCertificate: boolean;
    connectionTimeout: number;
    schemaRefreshMinutes: number;
    validateOnType: boolean;
    dryRunOnSave: boolean;
    detectByKeyword: boolean;
    promptQuickSuggestions: boolean;
    cacheSchemaToDisk: boolean;
    /** Remembered choices when the same table name exists in more than one database. */
    tableDatabasePreferences: TableDatabasePreferences;
    /** Max rows shown in the Run Selected SQL results tab. */
    queryMaxRows: number;
    formatKeywordCase: FormatKeywordCase;
    formatTabWidth: number;
}

/**
 * Databases selected for schema loading. Always includes the default database.
 */
export function selectedDatabases(config: ExtensionConfig): string[] {
    const names = [config.database, ...config.databases]
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(name);
    }
    return result;
}

function normalizePreferenceMap(value: unknown): TableDatabasePreferences {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const result: TableDatabasePreferences = {};
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
        const key = rawKey.trim().toLowerCase();
        const db = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (key && db) {
            result[key] = db;
        }
    }
    return result;
}

function normalizeDatabaseList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') {
            continue;
        }
        const name = item.trim();
        if (!name) {
            continue;
        }
        const key = name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(name);
    }
    return result;
}

function bracketIdent(name: string): string {
    return `[${name.replace(/\]/g, ']]')}]`;
}

export interface ColumnInfo {
    name: string;
    ordinal: number;
    typeName: string;
    typeDisplay: string;
    isNullable: boolean;
    isIdentity: boolean;
    isComputed: boolean;
    isPrimaryKey: boolean;
}

export interface TableInfo {
    /** Catalog / database this table lives in. */
    database: string;
    schema: string;
    name: string;
    /** schema.table (MSSQL) or database.table (MySQL). */
    fullName: string;
    /** database.schema.table (MSSQL) or database.table (MySQL). */
    qualifiedName: string;
    isView: boolean;
    columns: ColumnInfo[];
    columnsByLower: Map<string, ColumnInfo>;
}

export type ConnectionState =
    | 'disabled'
    | 'unconfigured'
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'error';

export interface DryRunError {
    number: number | undefined;
    message: string;
    lineNumber: number | undefined;
}

export type DryRunResult =
    | { kind: 'ok' }
    | { kind: 'errors'; errors: DryRunError[] }
    | { kind: 'skipped'; reason: string }
    | { kind: 'unavailable'; reason: string };

export interface QueryResult {
    ok: boolean;
    /** SQL the user selected (before paging wrap or engine rewrite). */
    sql: string;
    /** SQL sent to the driver (`:name` rewritten, paging wrap applied). */
    executedSql: string;
    params: Record<string, string | null>;
    columns: string[];
    rows: string[][];
    rowsAffected: number | undefined;
    elapsedMs: number;
    /** True when another page exists after this one. */
    truncated: boolean;
    /** Rows requested for this page (not including the extra lookahead row). */
    maxRows: number;
    /** Byte offset into the full result (0 for the first page). */
    pageOffset: number;
    /** True when this SELECT was wrapped with LIMIT/OFFSET. */
    paged: boolean;
    sort?: ResultSort;
    error?: string;
}

/** MySQL ER_VIEW_NO_EXPLAIN — SELECT on a view is allowed, EXPLAIN is not. */
const MYSQL_ER_VIEW_NO_EXPLAIN = 1345;

/**
 * True when EXPLAIN failed only because the login lacks base-table / SHOW VIEW
 * rights for a view. That is a dry-run limitation, not a bad query.
 */
export function isMysqlViewExplainPrivilegeError(
    errno: number | undefined,
    message: string
): boolean {
    if (errno === MYSQL_ER_VIEW_NO_EXPLAIN) {
        return true;
    }
    return /EXPLAIN\/SHOW can not be issued/i.test(message)
        || /lacking privileges for underlying table/i.test(message);
}

/**
 * Socket / pool failures, not bad SQL. Do not paint these on the query.
 * MySQL: 2006 gone away, 2013 lost during query, 4031 idle timeout, 1927 aborted.
 */
export function isTransientConnectionError(
    message: string,
    errno?: number
): boolean {
    const lower = message.toLowerCase();
    if (
        lower.includes('etimedout') ||
        lower.includes('econnreset') ||
        lower.includes('econnrefused') ||
        lower.includes('ehostunreach') ||
        lower.includes('epipe') ||
        lower.includes('enotfound') ||
        lower.includes('protocol_connection_lost') ||
        lower.includes('protocol_sequence_timeout') ||
        lower.includes('connection lost') ||
        lower.includes('server closed the connection') ||
        lower.includes('cannot enqueue') ||
        lower.includes('pool is closed') ||
        lower.includes('socket hang up')
    ) {
        return true;
    }
    return errno === 2006 || errno === 2013 || errno === 4031 || errno === 1927;
}

interface SerializedColumn {
    n: string;
    o: number;
    t: string;
    d: string;
    nu: boolean;
    id: boolean;
    co: boolean;
    pk: boolean;
}

interface SerializedTable {
    db: string;
    s: string;
    n: string;
    v: boolean;
    c: SerializedColumn[];
}

interface SerializedSnapshot {
    version: number;
    connectionKey: string;
    fetchedAt: number;
    tables: SerializedTable[];
}

interface RawColumnRow {
    database_name: string;
    schema_name: string;
    table_name: string;
    is_view: boolean;
    column_name: string;
    column_id: number;
    type_name: string;
    max_length: number;
    precision: number;
    scale: number;
    is_nullable: boolean;
    is_identity: boolean;
    is_computed: boolean;
}

interface RawKeyRow {
    database_name: string;
    schema_name: string;
    table_name: string;
    column_name: string;
}

/**
 * Strips [] or "" quoting from a single identifier part.
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

/**
 * Renders a SQL Server type the way it would appear in a CREATE TABLE statement.
 */
export function renderType(
    typeName: string,
    maxLength: number,
    precision: number,
    scale: number
): string {
    const name = typeName.toLowerCase();
    switch (name) {
        case 'char':
        case 'varchar':
        case 'binary':
        case 'varbinary':
            return maxLength === -1 ? `${name}(max)` : `${name}(${maxLength})`;
        case 'nchar':
        case 'nvarchar':
            return maxLength === -1 ? `${name}(max)` : `${name}(${Math.floor(maxLength / 2)})`;
        case 'decimal':
        case 'numeric':
            return `${name}(${precision},${scale})`;
        case 'datetime2':
        case 'time':
        case 'datetimeoffset':
            return `${name}(${scale})`;
        case 'float':
            return precision === 53 ? name : `${name}(${precision})`;
        default:
            return name;
    }
}

export function parseEngine(value: unknown): DbEngine {
    return value === 'mysql' ? 'mysql' : 'mssql';
}

export function defaultPortForEngine(engine: DbEngine): number {
    return engine === 'mysql' ? 3306 : 1433;
}

/** MySQL has no separate schema, so the qualified form is database.table. */
export function buildQualifiedName(
    database: string,
    schema: string,
    name: string,
    engine: DbEngine
): string {
    return engine === 'mysql' ? `${database}.${name}` : `${database}.${schema}.${name}`;
}

export class SchemaCache {
    public readonly tables: TableInfo[];
    public readonly fetchedAt: number;
    public readonly stale: boolean;

    private readonly byQualifiedLower = new Map<string, TableInfo>();
    private readonly byFullLower = new Map<string, TableInfo[]>();
    private readonly byNameLower = new Map<string, TableInfo[]>();

    constructor(tables: TableInfo[], fetchedAt: number, stale: boolean) {
        this.tables = tables;
        this.fetchedAt = fetchedAt;
        this.stale = stale;
        for (const table of tables) {
            this.byQualifiedLower.set(table.qualifiedName.toLowerCase(), table);
            const fullKey = table.fullName.toLowerCase();
            const fullBucket = this.byFullLower.get(fullKey);
            if (fullBucket) {
                fullBucket.push(table);
            } else {
                this.byFullLower.set(fullKey, [table]);
            }
            const nameKey = table.name.toLowerCase();
            const nameBucket = this.byNameLower.get(nameKey);
            if (nameBucket) {
                nameBucket.push(table);
            } else {
                this.byNameLower.set(nameKey, [table]);
            }
        }
    }

    public static empty(): SchemaCache {
        return new SchemaCache([], 0, false);
    }

    public get isEmpty(): boolean {
        return this.tables.length === 0;
    }

    /**
     * All tables matching a reference, before preference / default-DB picking.
     */
    public findTableMatches(reference: string): TableInfo[] {
        const parts = splitIdentifier(reference).filter((part) => part.length > 0);
        if (parts.length === 0) {
            return [];
        }
        if (parts.length >= 3) {
            const database = parts[parts.length - 3].toLowerCase();
            const schema = parts[parts.length - 2].toLowerCase();
            const table = parts[parts.length - 1].toLowerCase();
            const hit = this.byQualifiedLower.get(`${database}.${schema}.${table}`);
            return hit ? [hit] : [];
        }
        if (parts.length === 2) {
            const left = parts[0].toLowerCase();
            const right = parts[1].toLowerCase();
            // Prefer schema.table matches; also accept database.table (MySQL / 2-part catalog).
            const schemaMatches = this.byFullLower.get(`${left}.${right}`) ?? [];
            if (schemaMatches.length > 0) {
                return [...schemaMatches];
            }
            return this.tables.filter(
                (table) =>
                    table.database.toLowerCase() === left && table.name.toLowerCase() === right
            );
        }
        return [...(this.byNameLower.get(parts[0].toLowerCase()) ?? [])];
    }

    /**
     * True when the same bare / schema.table name exists in more than one database.
     */
    public isCrossDatabaseAmbiguous(reference: string): boolean {
        const matches = this.findTableMatches(reference);
        if (matches.length <= 1) {
            return false;
        }
        const databases = new Set(matches.map((table) => table.database.toLowerCase()));
        return databases.size > 1;
    }

    /**
     * Resolves Users, dbo.Users, [dbo].[Users], db.dbo.Users.
     * Preferences and the default database break ties across catalogs.
     */
    public findTable(
        reference: string,
        preferences: TableDatabasePreferences = {},
        defaultDatabase = ''
    ): TableInfo | undefined {
        const matches = this.findTableMatches(reference);
        if (matches.length === 0) {
            return undefined;
        }
        if (matches.length === 1) {
            return matches[0];
        }

        const parts = splitIdentifier(reference).filter((part) => part.length > 0);
        const preferenceKeys: string[] = [];
        if (parts.length === 1) {
            preferenceKeys.push(parts[0].toLowerCase());
        } else if (parts.length >= 2) {
            const schema = parts[parts.length - 2].toLowerCase();
            const table = parts[parts.length - 1].toLowerCase();
            preferenceKeys.push(`${schema}.${table}`, table);
        }

        for (const key of preferenceKeys) {
            const preferredDb = preferences[key]?.toLowerCase();
            if (!preferredDb) {
                continue;
            }
            const preferred = matches.find((table) => table.database.toLowerCase() === preferredDb);
            if (preferred) {
                return preferred;
            }
        }

        const defaultDb = defaultDatabase.trim().toLowerCase();
        if (defaultDb) {
            const inDefault = matches.filter(
                (table) => table.database.toLowerCase() === defaultDb
            );
            if (inDefault.length === 1) {
                return inDefault[0];
            }
            if (inDefault.length > 1) {
                return (
                    inDefault.find((table) => table.schema.toLowerCase() === 'dbo') ?? inDefault[0]
                );
            }
        }

        return matches.find((table) => table.schema.toLowerCase() === 'dbo') ?? matches[0];
    }

    public findColumn(
        tableReference: string,
        columnName: string,
        preferences: TableDatabasePreferences = {},
        defaultDatabase = ''
    ): ColumnInfo | undefined {
        const table = this.findTable(tableReference, preferences, defaultDatabase);
        if (!table) {
            return undefined;
        }
        return table.columnsByLower.get(unquoteIdentifier(columnName).toLowerCase());
    }

    public serialize(connectionKey: string): SerializedSnapshot {
        return {
            version: CACHE_VERSION,
            connectionKey,
            fetchedAt: this.fetchedAt,
            tables: this.tables.map((table) => ({
                db: table.database,
                s: table.schema,
                n: table.name,
                v: table.isView,
                c: table.columns.map((column) => ({
                    n: column.name,
                    o: column.ordinal,
                    t: column.typeName,
                    d: column.typeDisplay,
                    nu: column.isNullable,
                    id: column.isIdentity,
                    co: column.isComputed,
                    pk: column.isPrimaryKey
                }))
            }))
        };
    }

    public static deserialize(snapshot: SerializedSnapshot, engine: DbEngine = 'mssql'): SchemaCache {
        const tables: TableInfo[] = snapshot.tables.map((raw) => {
            const columns: ColumnInfo[] = raw.c.map((column) => ({
                name: column.n,
                ordinal: column.o,
                typeName: column.t,
                typeDisplay: column.d,
                isNullable: column.nu,
                isIdentity: column.id,
                isComputed: column.co,
                isPrimaryKey: column.pk
            }));
            const columnsByLower = new Map<string, ColumnInfo>();
            for (const column of columns) {
                columnsByLower.set(column.name.toLowerCase(), column);
            }
            const database = raw.db || raw.s;
            return {
                database,
                schema: raw.s,
                name: raw.n,
                fullName: `${raw.s}.${raw.n}`,
                qualifiedName: buildQualifiedName(database, raw.s, raw.n, engine),
                isView: raw.v,
                columns,
                columnsByLower
            };
        });
        return new SchemaCache(tables, snapshot.fetchedAt, true);
    }
}

function mssqlColumnQueryForDatabase(database: string): string {
    const db = bracketIdent(database);
    return `
SELECT
    N'${database.replace(/'/g, "''")}' AS database_name,
    s.name        AS schema_name,
    t.name        AS table_name,
    t.is_view     AS is_view,
    c.name        AS column_name,
    c.column_id   AS column_id,
    ty.name       AS type_name,
    c.max_length  AS max_length,
    c.precision   AS precision,
    c.scale       AS scale,
    c.is_nullable AS is_nullable,
    c.is_identity AS is_identity,
    c.is_computed AS is_computed
FROM (
    SELECT object_id, schema_id, name, CAST(0 AS bit) AS is_view FROM ${db}.sys.tables
    UNION ALL
    SELECT object_id, schema_id, name, CAST(1 AS bit) AS is_view FROM ${db}.sys.views
) AS t
INNER JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
INNER JOIN ${db}.sys.columns c ON c.object_id = t.object_id
INNER JOIN ${db}.sys.types   ty ON ty.user_type_id = c.user_type_id
ORDER BY s.name, t.name, c.column_id;
`;
}

function mssqlPrimaryKeyQueryForDatabase(database: string): string {
    const db = bracketIdent(database);
    return `
SELECT
    N'${database.replace(/'/g, "''")}' AS database_name,
    s.name AS schema_name,
    t.name AS table_name,
    c.name AS column_name
FROM ${db}.sys.key_constraints kc
INNER JOIN ${db}.sys.tables  t  ON t.object_id = kc.parent_object_id
INNER JOIN ${db}.sys.schemas s  ON s.schema_id = t.schema_id
INNER JOIN ${db}.sys.index_columns ic
        ON ic.object_id = kc.parent_object_id
       AND ic.index_id  = kc.unique_index_id
INNER JOIN ${db}.sys.columns c
        ON c.object_id = ic.object_id
       AND c.column_id = ic.column_id
WHERE kc.type = 'PK';
`;
}

export class SqlServerService implements vscode.Disposable {
    private mssqlPool: mssql.ConnectionPool | undefined;
    private mysqlPool: mysql.Pool | undefined;
    private connecting: Promise<boolean> | undefined;
    private schemaCache = SchemaCache.empty();
    private state: ConnectionState = 'disconnected';
    private lastError: string | undefined;
    private lastHealthyAt = 0;
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshInFlight: Promise<boolean> | undefined;
    private readonly preferencePromptInFlight = new Set<string>();

    private readonly stateEmitter = new vscode.EventEmitter<ConnectionState>();
    private readonly schemaEmitter = new vscode.EventEmitter<SchemaCache>();

    public readonly onDidChangeState = this.stateEmitter.event;
    public readonly onDidChangeSchema = this.schemaEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel
    ) {}

    /**
     * Asks once which database to use for an ambiguous table name, then remembers it.
     */
    public async promptTableDatabasePreference(
        reference: string,
        matches: TableInfo[]
    ): Promise<string | undefined> {
        const databases = [...new Set(matches.map((table) => table.database))];
        if (databases.length <= 1) {
            return undefined;
        }
        const key = reference.trim().toLowerCase();
        const parts = splitIdentifier(reference).filter((part) => part.length > 0);
        const preferenceKey =
            parts.length >= 2
                ? `${parts[parts.length - 2].toLowerCase()}.${parts[parts.length - 1].toLowerCase()}`
                : parts[0]?.toLowerCase() ?? key;

        if (this.preferencePromptInFlight.has(preferenceKey)) {
            return undefined;
        }
        const existing =
            this.getConfig().tableDatabasePreferences[preferenceKey] ??
            this.getConfig().tableDatabasePreferences[
                parts[parts.length - 1]?.toLowerCase() ?? ''
            ];
        if (existing) {
            return existing;
        }

        this.preferencePromptInFlight.add(preferenceKey);
        try {
            const picked = await vscode.window.showQuickPick(
                databases.map((database) => ({
                    label: database,
                    description: matches
                        .filter(
                            (table) => table.database.toLowerCase() === database.toLowerCase()
                        )
                        .map((table) => table.fullName)
                        .join(', ')
                })),
                {
                    title: `Table "${reference}" is in more than one database`,
                    placeHolder: 'Which database should IntelliSense prefer?',
                    ignoreFocusOut: true
                }
            );
            if (!picked) {
                return undefined;
            }
            await this.setTableDatabasePreference(preferenceKey, picked.label);
            this.schemaEmitter.fire(this.schemaCache);
            return picked.label;
        } finally {
            this.preferencePromptInFlight.delete(preferenceKey);
        }
    }

    public get schema(): SchemaCache {
        return this.schemaCache;
    }

    public get connectionState(): ConnectionState {
        return this.state;
    }

    public get lastErrorMessage(): string | undefined {
        return this.lastError;
    }

    public getConfig(): ExtensionConfig {
        return this.readConfigFromLayers('effective');
    }

    /**
     * Reads values from User settings (shared) or Workspace settings (this project).
     * Missing workspace values fall back to the shared/global ones.
     */
    public getConfigForScope(scope: SettingsScope): ExtensionConfig {
        if (scope === 'global' || !this.hasWorkspaceFolder()) {
            return this.readInspectedGlobalConfig();
        }
        // Effective config already prefers workspace overrides.
        return this.getConfig();
    }

    private readConfigFromLayers(mode: 'effective' | 'global'): ExtensionConfig {
        const pick = <T>(key: string, fallback: T): T => this.pickSetting(key, fallback, mode);
        const engine = parseEngine(pick<string>('engine', 'mssql'));
        return {
            enabled: pick<boolean>('enabled', true),
            engine,
            server: String(pick<string>('server', '')).trim(),
            database: String(pick<string>('database', '')).trim(),
            databases: normalizeDatabaseList(pick('databases', [])),
            user: String(pick<string>('user', '')).trim(),
            passwordSetting: String(pick<string>('password', '')),
            port: pick<number>('port', defaultPortForEngine(engine)),
            encrypt: pick<boolean>('encrypt', true),
            trustServerCertificate: pick<boolean>('trustServerCertificate', false),
            connectionTimeout: pick<number>('connectionTimeout', 15000),
            schemaRefreshMinutes: pick<number>('schemaRefreshMinutes', 30),
            validateOnType: pick<boolean>('validateOnType', true),
            dryRunOnSave: pick<boolean>('dryRunOnSave', true),
            detectByKeyword: pick<boolean>('detectByKeyword', true),
            promptQuickSuggestions: pick<boolean>('promptQuickSuggestions', true),
            cacheSchemaToDisk: pick<boolean>('cacheSchemaToDisk', true),
            tableDatabasePreferences: normalizePreferenceMap(
                pick('tableDatabasePreferences', {})
            ),
            queryMaxRows: Math.max(1, pick<number>('queryMaxRows', 1000)),
            formatKeywordCase: parseKeywordCase(pick<string>('formatKeywordCase', 'upper')),
            formatTabWidth: Math.max(1, Math.min(8, pick<number>('formatTabWidth', 4)))
        };
    }

    private readInspectedGlobalConfig(): ExtensionConfig {
        return this.readConfigFromLayers('global');
    }

    /**
     * Prefer `bisql.*` settings, then the old `sqlPythonValidator.*` keys.
     */
    private pickSetting<T>(key: string, fallback: T, mode: 'effective' | 'global'): T {
        const current = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect<T>(key);
        const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION).inspect<T>(key);
        const layers =
            mode === 'global'
                ? [current?.globalValue, legacy?.globalValue, current?.defaultValue]
                : [
                      current?.workspaceFolderValue,
                      legacy?.workspaceFolderValue,
                      current?.workspaceValue,
                      legacy?.workspaceValue,
                      current?.globalValue,
                      legacy?.globalValue,
                      current?.defaultValue
                  ];
        for (const value of layers) {
            if (value !== undefined) {
                return value;
            }
        }
        return fallback;
    }

    public hasWorkspaceFolder(): boolean {
        return Boolean(vscode.workspace.workspaceFolders?.length);
    }

    /**
     * Which scope this project is using. Defaults to shared (global).
     */
    public getSettingsScope(): SettingsScope {
        const stored =
            this.context.workspaceState.get<SettingsScope>(SCOPE_STATE_KEY) ??
            this.context.workspaceState.get<SettingsScope>(LEGACY_SCOPE_STATE_KEY);
        if (stored === 'workspace' || stored === 'global') {
            return stored;
        }
        // Migrate: if the workspace already has connection overrides, treat as project scope.
        if (this.hasWorkspaceConnectionOverrides()) {
            return 'workspace';
        }
        return 'global';
    }

    public async setSettingsScope(scope: SettingsScope): Promise<void> {
        await this.context.workspaceState.update(SCOPE_STATE_KEY, scope);
    }

    private hasWorkspaceConnectionOverrides(): boolean {
        for (const sectionName of [CONFIG_SECTION, LEGACY_CONFIG_SECTION]) {
            const section = vscode.workspace.getConfiguration(sectionName);
            for (const key of CONNECTION_SETTING_KEYS) {
                if (key === 'password') {
                    continue;
                }
                const inspected = section.inspect(key);
                const value = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
                if (value !== undefined) {
                    return true;
                }
            }
        }
        return false;
    }

    private workspaceSecretKey(): string {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'default';
        const hash = crypto.createHash('sha1').update(folder).digest('hex').slice(0, 12);
        return `sqlPythonValidator.password.workspace.${hash}`;
    }

    private secretKeyForScope(scope: SettingsScope): string {
        return scope === 'workspace' ? this.workspaceSecretKey() : SECRET_KEY_GLOBAL;
    }

    public async setPassword(password: string, scope?: SettingsScope): Promise<void> {
        const resolved = scope ?? this.getSettingsScope();
        await this.context.secrets.store(this.secretKeyForScope(resolved), password);
        // Keep legacy key in sync when saving shared, so older installs keep working.
        if (resolved === 'global') {
            await this.context.secrets.store(SECRET_KEY_LEGACY, password);
        }
    }

    public async clearPassword(scope?: SettingsScope): Promise<void> {
        const resolved = scope ?? this.getSettingsScope();
        await this.context.secrets.delete(this.secretKeyForScope(resolved));
        if (resolved === 'global') {
            await this.context.secrets.delete(SECRET_KEY_LEGACY);
        }
    }

    public async hasStoredPassword(scope?: SettingsScope): Promise<boolean> {
        const value = await this.getPassword(scope);
        return value !== undefined && value !== '';
    }

    /** Reads the password for the active (or given) scope. */
    public async getPassword(scope?: SettingsScope): Promise<string | undefined> {
        const resolved = scope ?? this.getSettingsScope();
        const primary = await this.context.secrets.get(this.secretKeyForScope(resolved));
        if (primary !== undefined && primary !== '') {
            return primary;
        }
        if (resolved === 'global') {
            const legacy = await this.context.secrets.get(SECRET_KEY_LEGACY);
            if (legacy !== undefined && legacy !== '') {
                return legacy;
            }
        }
        // Project scope can fall back to shared password if none is set for the project.
        if (resolved === 'workspace') {
            const shared = await this.context.secrets.get(SECRET_KEY_GLOBAL);
            if (shared !== undefined && shared !== '') {
                return shared;
            }
            const legacy = await this.context.secrets.get(SECRET_KEY_LEGACY);
            if (legacy !== undefined && legacy !== '') {
                return legacy;
            }
        }
        const fromSettings = this.getConfig().passwordSetting;
        return fromSettings !== '' ? fromSettings : undefined;
    }

    /**
     * Writes connection fields to User (shared) or Workspace (this project).
     * Choosing shared also clears project overrides so the shared values apply here.
     */
    public async saveConnectionSettings(
        settings: {
            engine: DbEngine;
            server: string;
            database: string;
            databases?: string[];
            user: string;
            port: number;
            encrypt: boolean;
            trustServerCertificate: boolean;
            enabled: boolean;
            tableDatabasePreferences?: TableDatabasePreferences;
        },
        scope: SettingsScope = 'global'
    ): Promise<void> {
        const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const target =
            scope === 'workspace' && this.hasWorkspaceFolder()
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;

        await this.setSettingsScope(scope === 'workspace' && this.hasWorkspaceFolder() ? 'workspace' : 'global');

        const databases = normalizeDatabaseList(settings.databases ?? [settings.database]);
        const defaultDatabase = settings.database.trim() || databases[0] || '';
        const withDefault = selectedDatabases({
            ...this.getConfig(),
            database: defaultDatabase,
            databases
        });

        await section.update('engine', settings.engine, target);
        await section.update('server', settings.server, target);
        await section.update('database', defaultDatabase, target);
        await section.update('databases', withDefault, target);
        await section.update('user', settings.user, target);
        await section.update('port', settings.port, target);
        await section.update('encrypt', settings.encrypt, target);
        await section.update('trustServerCertificate', settings.trustServerCertificate, target);
        await section.update('enabled', settings.enabled, target);
        await section.update('password', '', target);
        if (settings.tableDatabasePreferences !== undefined) {
            await section.update(
                'tableDatabasePreferences',
                normalizePreferenceMap(settings.tableDatabasePreferences),
                target
            );
        }

        // Shared mode: remove project overrides so every project sees the same values.
        if (target === vscode.ConfigurationTarget.Global && this.hasWorkspaceFolder()) {
            for (const key of CONNECTION_SETTING_KEYS) {
                await section.update(key, undefined, vscode.ConfigurationTarget.Workspace);
            }
        }
    }

    public async setTableDatabasePreference(
        tableKey: string,
        database: string,
        scope?: SettingsScope
    ): Promise<void> {
        const resolved = scope ?? this.getSettingsScope();
        const config = this.getConfigForScope(resolved);
        const preferences = { ...config.tableDatabasePreferences };
        preferences[tableKey.trim().toLowerCase()] = database.trim();
        await this.saveConnectionSettings(
            {
                engine: config.engine,
                server: config.server,
                database: config.database,
                databases: selectedDatabases(config),
                user: config.user,
                port: config.port,
                encrypt: config.encrypt,
                trustServerCertificate: config.trustServerCertificate,
                enabled: config.enabled,
                tableDatabasePreferences: preferences
            },
            resolved
        );
    }

    public async removeTableDatabasePreference(
        tableKey: string,
        scope?: SettingsScope
    ): Promise<void> {
        const resolved = scope ?? this.getSettingsScope();
        const config = this.getConfigForScope(resolved);
        const preferences = { ...config.tableDatabasePreferences };
        delete preferences[tableKey.trim().toLowerCase()];
        await this.saveConnectionSettings(
            {
                engine: config.engine,
                server: config.server,
                database: config.database,
                databases: selectedDatabases(config),
                user: config.user,
                port: config.port,
                encrypt: config.encrypt,
                trustServerCertificate: config.trustServerCertificate,
                enabled: config.enabled,
                tableDatabasePreferences: preferences
            },
            resolved
        );
    }

    /** Preference-aware table lookup used by providers. */
    public findTable(reference: string): TableInfo | undefined {
        const config = this.getConfig();
        return this.schemaCache.findTable(
            reference,
            config.tableDatabasePreferences,
            config.database
        );
    }

    public findTableMatches(reference: string): TableInfo[] {
        return this.schemaCache.findTableMatches(reference);
    }

    private async resolvePassword(config: ExtensionConfig): Promise<string> {
        return (await this.getPassword()) ?? config.passwordSetting ?? '';
    }

    public connectionKey(config: ExtensionConfig): string {
        const dbs = selectedDatabases(config).map((name) => name.toLowerCase()).sort().join(',');
        const raw = `${config.engine}|${config.server}|${config.port}|${dbs}|${config.user}`;
        return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
    }

    private setState(next: ConnectionState, error?: string): void {
        this.lastError = error;
        if (this.state !== next) {
            this.state = next;
            this.stateEmitter.fire(next);
        } else if (error) {
            this.stateEmitter.fire(next);
        }
    }

    private isConfigured(config: ExtensionConfig): boolean {
        return config.server.length > 0 && config.database.length > 0;
    }

    private isLive(): boolean {
        const config = this.getConfig();
        if (config.engine === 'mysql') {
            return this.mysqlPool !== undefined;
        }
        return Boolean(this.mssqlPool && this.mssqlPool.connected);
    }

    /**
     * True when the pool still answers. A dead MySQL socket looks "live"
     * until the next read, which then fails with read ETIMEDOUT.
     */
    private async isHealthy(config: ExtensionConfig): Promise<boolean> {
        if (!this.isLive()) {
            return false;
        }
        if (Date.now() - this.lastHealthyAt < 10_000) {
            return true;
        }
        try {
            if (config.engine === 'mysql') {
                const timeout = Math.min(5_000, config.connectionTimeout);
                await this.mysqlPool!.query({ sql: 'SELECT 1', timeout });
            } else {
                await this.mssqlPool!.request().query('SELECT 1');
            }
            this.lastHealthyAt = Date.now();
            return true;
        } catch (error) {
            const message = errorText(error);
            this.output.appendLine(`[connect] pool health check failed: ${message}`);
            await this.disposePool();
            return false;
        }
    }

    /**
     * Runs a query once, then reconnects and retries if the socket died.
     */
    private async runWithReconnect<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (!isTransientConnectionError(errorText(error), errorErrno(error))) {
                throw error;
            }
            this.output.appendLine(
                `[connect] retry after stale connection: ${errorText(error)}`
            );
            await this.disposePool();
            this.setState('disconnected');
            const ok = await this.ensureConnected();
            if (!ok) {
                throw error;
            }
            return await operation();
        }
    }

    private buildMssqlConfig(config: ExtensionConfig, password: string): mssql.config {
        const [host, instanceName] = config.server.split('\\');
        const options: mssql.config['options'] = {
            encrypt: config.encrypt,
            trustServerCertificate: config.trustServerCertificate,
            enableArithAbort: true,
            appName: 'BiSql'
        };
        if (instanceName) {
            options.instanceName = instanceName;
        }

        const poolConfig: mssql.config = {
            server: host,
            database: config.database,
            user: config.user,
            password,
            connectionTimeout: config.connectionTimeout,
            requestTimeout: config.connectionTimeout,
            options,
            pool: {
                max: 4,
                min: 0,
                idleTimeoutMillis: 30000
            }
        };
        if (!instanceName) {
            poolConfig.port = config.port;
        }
        return poolConfig;
    }

    private buildMysqlPool(config: ExtensionConfig, password: string): mysql.Pool {
        const ssl =
            config.encrypt
                ? config.trustServerCertificate
                    ? { rejectUnauthorized: false }
                    : {}
                : undefined;

        return mysql.createPool({
            host: config.server,
            port: config.port,
            user: config.user,
            password,
            database: config.database,
            waitForConnections: true,
            connectionLimit: 4,
            maxIdle: 2,
            idleTimeout: 60_000,
            connectTimeout: config.connectionTimeout,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10_000,
            ...(ssl ? { ssl } : {})
        });
    }

    /**
     * Ensures a live connection for the configured engine. Never throws.
     */
    public async ensureConnected(): Promise<boolean> {
        const config = this.getConfig();
        if (!config.enabled) {
            this.setState('disabled');
            return false;
        }
        if (!this.isConfigured(config)) {
            this.setState('unconfigured');
            return false;
        }
        if (await this.isHealthy(config)) {
            return true;
        }
        if (this.connecting) {
            return this.connecting;
        }

        this.connecting = (async () => {
            this.setState('connecting');
            const password = await this.resolvePassword(config);
            try {
                if (config.engine === 'mysql') {
                    await this.disposePool();
                    const pool = this.buildMysqlPool(config, password);
                    // Force a real handshake; createPool is lazy.
                    const conn = await pool.getConnection();
                    conn.release();
                    this.mysqlPool = pool;
                } else {
                    await this.disposePool();
                    const poolConfig = this.buildMssqlConfig(config, password);
                    const pool = new mssql.ConnectionPool(poolConfig);
                    pool.on('error', (err: Error) => {
                        this.output.appendLine(`[pool] ${err.message}`);
                    });
                    await pool.connect();
                    this.mssqlPool = pool;
                }
                this.lastHealthyAt = Date.now();
                this.setState('connected');
                this.output.appendLine(
                    `[connect] ${config.engine} ${config.server}:${config.port}/${config.database} as ${config.user || '(empty user)'}`
                );
                return true;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.output.appendLine(`[connect] failed: ${message}`);
                this.output.appendLine(`[connect] hint: ${hintForConnectError(message, config)}`);
                this.setState('error', message);
                await this.disposePool();
                return false;
            } finally {
                this.connecting = undefined;
            }
        })();

        return this.connecting;
    }

    public async testConnection(): Promise<{ ok: boolean; message: string }> {
        const config = this.getConfig();
        if (!config.enabled) {
            return { ok: false, message: 'The extension is disabled (bisql.enabled).' };
        }
        if (!this.isConfigured(config)) {
            return {
                ok: false,
                message: 'Set server and database on the login page first.'
            };
        }
        await this.disposePool();
        const ok = await this.ensureConnected();
        if (!ok) {
            return { ok: false, message: this.lastError ?? 'Could not connect.' };
        }
        try {
            if (config.engine === 'mysql') {
                const [rows] = await this.mysqlPool!.query<mysql.RowDataPacket[]>(
                    'SELECT VERSION() AS version'
                );
                const version = String(rows[0]?.version ?? 'MySQL');
                return { ok: true, message: `MySQL ${version}` };
            }
            const result = await this.mssqlPool!.request().query<{ version: string }>(
                'SELECT @@VERSION AS version;'
            );
            const version = result.recordset[0]?.version ?? 'unknown version';
            return { ok: true, message: version.split('\n')[0].trim() };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, message };
        }
    }

    /**
     * Reloads schema metadata. Returns true when the live fetch succeeded.
     */
    public async refreshSchema(): Promise<boolean> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
        this.refreshInFlight = this.doRefreshSchema().finally(() => {
            this.refreshInFlight = undefined;
        });
        return this.refreshInFlight;
    }

    private async doRefreshSchema(): Promise<boolean> {
        const ok = await this.ensureConnected();
        if (!ok) {
            return false;
        }
        const config = this.getConfig();
        try {
            if (config.engine === 'mysql') {
                return await this.refreshMysqlSchema(config);
            }
            return await this.refreshMssqlSchema(config);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[schema] refresh failed: ${message}`);
            this.setState('error', message);
            return false;
        }
    }

    private async refreshMssqlSchema(config: ExtensionConfig): Promise<boolean> {
        const pool = this.mssqlPool!;
        const databases = selectedDatabases(config);
        const primaryKeys = new Set<string>();
        const tablesByQualified = new Map<string, TableInfo>();

        for (const database of databases) {
            try {
                const [columnResult, keyResult] = await Promise.all([
                    pool.request().query<RawColumnRow>(mssqlColumnQueryForDatabase(database)),
                    pool.request().query<RawKeyRow>(mssqlPrimaryKeyQueryForDatabase(database))
                ]);

                for (const row of keyResult.recordset) {
                    primaryKeys.add(
                        `${row.database_name.toLowerCase()}.${row.schema_name.toLowerCase()}.${row.table_name.toLowerCase()}.${row.column_name.toLowerCase()}`
                    );
                }

                for (const row of columnResult.recordset) {
                    const databaseName = row.database_name || database;
                    const fullName = `${row.schema_name}.${row.table_name}`;
                    const qualifiedName = `${databaseName}.${fullName}`;
                    let table = tablesByQualified.get(qualifiedName.toLowerCase());
                    if (!table) {
                        table = {
                            database: databaseName,
                            schema: row.schema_name,
                            name: row.table_name,
                            fullName,
                            qualifiedName,
                            isView: Boolean(row.is_view),
                            columns: [],
                            columnsByLower: new Map<string, ColumnInfo>()
                        };
                        tablesByQualified.set(qualifiedName.toLowerCase(), table);
                    }
                    const column: ColumnInfo = {
                        name: row.column_name,
                        ordinal: row.column_id,
                        typeName: row.type_name,
                        typeDisplay: renderType(
                            row.type_name,
                            row.max_length,
                            row.precision,
                            row.scale
                        ),
                        isNullable: Boolean(row.is_nullable),
                        isIdentity: Boolean(row.is_identity),
                        isComputed: Boolean(row.is_computed),
                        isPrimaryKey: primaryKeys.has(
                            `${databaseName.toLowerCase()}.${row.schema_name.toLowerCase()}.${row.table_name.toLowerCase()}.${row.column_name.toLowerCase()}`
                        )
                    };
                    table.columns.push(column);
                    table.columnsByLower.set(column.name.toLowerCase(), column);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.output.appendLine(
                    `[schema] skipped database ${database}: ${message}`
                );
            }
        }

        const cache = new SchemaCache([...tablesByQualified.values()], Date.now(), false);
        this.schemaCache = cache;
        this.schemaEmitter.fire(cache);
        this.output.appendLine(
            `[schema] loaded ${cache.tables.length} tables and views from ${databases.join(', ')} (mssql)`
        );
        void this.saveDiskCache();
        return true;
    }

    private async refreshMysqlSchema(config: ExtensionConfig): Promise<boolean> {
        const pool = this.mysqlPool!;
        const databases = selectedDatabases(config);
        if (databases.length === 0) {
            return false;
        }

        const placeholders = databases.map(() => '?').join(', ');
        const [columnRows] = await pool.query<mysql.RowDataPacket[]>(
            `SELECT
                c.TABLE_SCHEMA AS schema_name,
                c.TABLE_NAME AS table_name,
                t.TABLE_TYPE AS table_type,
                c.COLUMN_NAME AS column_name,
                c.ORDINAL_POSITION AS column_id,
                c.DATA_TYPE AS type_name,
                c.COLUMN_TYPE AS column_type,
                c.IS_NULLABLE AS is_nullable,
                c.EXTRA AS extra,
                c.COLUMN_KEY AS column_key
             FROM information_schema.COLUMNS c
             INNER JOIN information_schema.TABLES t
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
             WHERE c.TABLE_SCHEMA IN (${placeholders})
             ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
            databases
        );

        const tablesByQualified = new Map<string, TableInfo>();
        for (const row of columnRows) {
            const schemaName = String(row.schema_name);
            const tableName = String(row.table_name);
            // MySQL: schema == database. Use database.table, not database.database.table.
            const mysqlFull = `${schemaName}.${tableName}`;
            const qualifiedName = buildQualifiedName(schemaName, schemaName, tableName, 'mysql');
            let table = tablesByQualified.get(qualifiedName.toLowerCase());
            if (!table) {
                table = {
                    database: schemaName,
                    schema: schemaName,
                    name: tableName,
                    fullName: mysqlFull,
                    qualifiedName,
                    isView: String(row.table_type).toUpperCase() === 'VIEW',
                    columns: [],
                    columnsByLower: new Map<string, ColumnInfo>()
                };
                tablesByQualified.set(qualifiedName.toLowerCase(), table);
            }
            const typeDisplay = String(row.column_type || row.type_name);
            const extra = String(row.extra || '').toLowerCase();
            const column: ColumnInfo = {
                name: String(row.column_name),
                ordinal: Number(row.column_id) || 0,
                typeName: String(row.type_name),
                typeDisplay,
                isNullable: String(row.is_nullable).toUpperCase() === 'YES',
                isIdentity: extra.includes('auto_increment'),
                isComputed: extra.includes('generated'),
                isPrimaryKey: String(row.column_key).toUpperCase() === 'PRI'
            };
            table.columns.push(column);
            table.columnsByLower.set(column.name.toLowerCase(), column);
        }

        const cache = new SchemaCache([...tablesByQualified.values()], Date.now(), false);
        this.schemaCache = cache;
        this.schemaEmitter.fire(cache);
        this.output.appendLine(
            `[schema] loaded ${cache.tables.length} tables and views from ${databases.join(', ')} (mysql)`
        );
        void this.saveDiskCache();
        return true;
    }

    /**
     * Lists databases the login can see. Uses current settings (or a temporary pool).
     */
    public async listDatabases(): Promise<{ ok: boolean; databases: string[]; message: string }> {
        const config = this.getConfig();
        if (!this.isConfigured(config)) {
            return {
                ok: false,
                databases: [],
                message: 'Set server and a default database first.'
            };
        }
        const ok = await this.ensureConnected();
        if (!ok) {
            return {
                ok: false,
                databases: [],
                message: this.lastError ?? 'Could not connect.'
            };
        }
        try {
            if (config.engine === 'mysql') {
                const [rows] = await this.mysqlPool!.query<mysql.RowDataPacket[]>(
                    `SELECT SCHEMA_NAME AS name
                     FROM information_schema.SCHEMATA
                     WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
                     ORDER BY SCHEMA_NAME`
                );
                const databases = rows.map((row) => String(row.name));
                return { ok: true, databases, message: `${databases.length} databases` };
            }
            const result = await this.mssqlPool!.request().query<{ name: string }>(
                `SELECT name
                 FROM sys.databases
                 WHERE state = 0
                   AND HAS_DBACCESS(name) = 1
                   AND name NOT IN ('master', 'tempdb', 'model', 'msdb')
                 ORDER BY name;`
            );
            const databases = result.recordset.map((row) => row.name);
            return { ok: true, databases, message: `${databases.length} databases` };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, databases: [], message };
        }
    }

    public startRefreshTimer(): void {
        this.stopRefreshTimer();
        const minutes = this.getConfig().schemaRefreshMinutes;
        if (minutes <= 0) {
            return;
        }
        this.refreshTimer = setInterval(() => {
            void this.refreshSchema();
        }, minutes * 60_000);
    }

    private stopRefreshTimer(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private cacheFileUri(config: ExtensionConfig): vscode.Uri {
        return vscode.Uri.joinPath(
            this.context.globalStorageUri,
            `schema-${this.connectionKey(config)}.json`
        );
    }

    /**
     * Loads the on-disk snapshot so completions work before the first connection
     * succeeds. The result is always marked stale until a live fetch replaces it.
     */
    public async loadDiskCache(): Promise<boolean> {
        const config = this.getConfig();
        if (!config.cacheSchemaToDisk || !this.isConfigured(config)) {
            return false;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(this.cacheFileUri(config));
            const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8')) as SerializedSnapshot;
            if (snapshot.version !== CACHE_VERSION) {
                return false;
            }
            if (snapshot.connectionKey !== this.connectionKey(config)) {
                return false;
            }
            const cache = SchemaCache.deserialize(snapshot, config.engine);
            if (cache.isEmpty) {
                return false;
            }
            this.schemaCache = cache;
            this.schemaEmitter.fire(cache);
            this.output.appendLine(
                `[schema] restored ${cache.tables.length} tables from the disk snapshot (stale)`
            );
            return true;
        } catch {
            // A missing or unreadable snapshot is expected on first run.
            return false;
        }
    }

    private async saveDiskCache(): Promise<void> {
        const config = this.getConfig();
        if (!config.cacheSchemaToDisk || this.schemaCache.isEmpty) {
            return;
        }
        try {
            await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
            const payload = JSON.stringify(this.schemaCache.serialize(this.connectionKey(config)));
            await vscode.workspace.fs.writeFile(
                this.cacheFileUri(config),
                Buffer.from(payload, 'utf8')
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[schema] could not write the disk snapshot: ${message}`);
        }
    }

    public async clearDiskCache(): Promise<void> {
        const config = this.getConfig();
        try {
            await vscode.workspace.fs.delete(this.cacheFileUri(config));
            this.output.appendLine('[schema] disk snapshot deleted');
        } catch {
            // Nothing cached for this connection.
        }
        this.schemaCache = SchemaCache.empty();
        this.schemaEmitter.fire(this.schemaCache);
    }

    /**
     * Dry-runs a query without changing data.
     * - SQL Server: SET NOEXEC ON
     * - MySQL: EXPLAIN (parse/plan only)
     */
    public async dryRun(sql: string): Promise<DryRunResult> {
        const config = this.getConfig();
        if (!config.enabled) {
            return { kind: 'unavailable', reason: 'The extension is disabled.' };
        }
        if (sql.trim().length === 0) {
            return { kind: 'ok' };
        }

        if (config.engine === 'mysql') {
            return this.dryRunMysql(sql);
        }
        return this.dryRunMssql(sql);
    }

    private async dryRunMssql(sql: string): Promise<DryRunResult> {
        if (/\bNOEXEC\b/i.test(sql)) {
            return {
                kind: 'skipped',
                reason: 'The query manipulates NOEXEC itself, so it cannot be dry run safely.'
            };
        }
        if (/^[ \t]*GO[ \t]*(--.*)?$/im.test(sql)) {
            return {
                kind: 'skipped',
                reason: 'The query contains a GO batch separator, which cannot be dry run as one batch.'
            };
        }

        const ok = await this.ensureConnected();
        if (!ok || !this.mssqlPool) {
            return {
                kind: 'unavailable',
                reason: this.lastError ?? 'No database connection is available.'
            };
        }

        const batch = `SET NOEXEC ON;\n${sql}\nSET NOEXEC OFF;`;
        try {
            await this.runWithReconnect(() => this.mssqlPool!.request().batch(batch));
            return { kind: 'ok' };
        } catch (error) {
            const message = errorText(error);
            if (isTransientConnectionError(message, errorErrno(error))) {
                this.setState('error', message);
                return { kind: 'unavailable', reason: message };
            }
            const collected = collectRequestErrors(error);
            if (collected.length === 0) {
                return { kind: 'unavailable', reason: message };
            }
            const errors: DryRunError[] = collected.map((item) => ({
                number: item.number,
                message: item.message,
                lineNumber:
                    typeof item.lineNumber === 'number' ? item.lineNumber - 1 : undefined
            }));
            return { kind: 'errors', errors };
        }
    }

    private async dryRunMysql(sql: string): Promise<DryRunResult> {
        if (/^\s*(USE|SET|START\s+TRANSACTION|BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
            return {
                kind: 'skipped',
                reason: 'Session/transaction statements are not dry-run with EXPLAIN.'
            };
        }

        const ok = await this.ensureConnected();
        if (!ok || !this.mysqlPool) {
            return {
                kind: 'unavailable',
                reason: this.lastError ?? 'No database connection is available.'
            };
        }

        try {
            // EXPLAIN plans the statement without applying DML side effects.
            const timeout = this.getConfig().connectionTimeout;
            await this.runWithReconnect(() =>
                this.mysqlPool!.query({ sql: `EXPLAIN ${sql}`, timeout })
            );
            return { kind: 'ok' };
        } catch (error) {
            const err = error as { errno?: number; sqlMessage?: string; message?: string };
            const message = err.sqlMessage || err.message || String(error);
            const errno = typeof err.errno === 'number' ? err.errno : undefined;
            // Dead sockets and VPN drops are not SQL problems — do not underline the query.
            if (isTransientConnectionError(message, errno)) {
                this.setState('error', message);
                return { kind: 'unavailable', reason: message };
            }
            // Read-only logins often can SELECT a view but not EXPLAIN it.
            // Do not surface that as a query error in the editor.
            if (isMysqlViewExplainPrivilegeError(errno, message)) {
                return {
                    kind: 'skipped',
                    reason:
                        'MySQL cannot EXPLAIN this view with the current login privileges. Offline schema checks still apply.'
                };
            }
            return {
                kind: 'errors',
                errors: [
                    {
                        number: errno,
                        message,
                        lineNumber: 1
                    }
                ]
            };
        }
    }

    /**
     * Runs SQL for real and returns a display-ready result set.
     * `:name` binds are rewritten for the engine; values are never pasted into SQL.
     * SELECT queries are wrapped with ORDER BY / LIMIT so only one page is fetched.
     */
    public async executeQuery(
        sql: string,
        params: Record<string, string | null> = {},
        page?: QueryPageOptions
    ): Promise<QueryResult> {
        const config = this.getConfig();
        const pageSize = clampPageSize(page?.limit ?? config.queryMaxRows, config.queryMaxRows);
        const offset = clampOffset(page?.offset ?? 0);
        const sort = page?.sort;
        const started = Date.now();
        const fail = (error: string, executedSql = sql): QueryResult => ({
            ok: false,
            sql,
            executedSql,
            params,
            columns: [],
            rows: [],
            rowsAffected: undefined,
            elapsedMs: Date.now() - started,
            truncated: false,
            maxRows: pageSize,
            pageOffset: offset,
            paged: false,
            sort,
            error
        });

        if (!config.enabled) {
            return fail('The extension is disabled.');
        }
        if (sql.trim().length === 0) {
            return fail('No SQL to run.');
        }

        const ok = await this.ensureConnected();
        if (!ok) {
            return fail(this.lastError ?? 'No database connection is available.');
        }

        const fetchLimit = pageSize + 1;
        const run = (text: string) =>
            config.engine === 'mysql'
                ? this.executeMysql(text, params, fetchLimit, started)
                : this.executeMssql(text, params, fetchLimit, started);

        const stamp = (result: QueryResult, paged: boolean): QueryResult => {
            if (!result.ok || result.columns.length === 0) {
                return {
                    ...result,
                    sql,
                    maxRows: pageSize,
                    pageOffset: result.ok ? 0 : offset,
                    paged: false,
                    sort: undefined
                };
            }
            const hasMore = result.rows.length > pageSize;
            return {
                ...result,
                sql,
                maxRows: pageSize,
                pageOffset: offset,
                paged,
                sort,
                truncated: hasMore,
                rows: hasMore ? result.rows.slice(0, pageSize) : result.rows
            };
        };

        if (!canPageSelect(sql)) {
            return stamp(await run(sql), false);
        }

        const wrapped = buildPagedSelect(sql, config.engine, offset, fetchLimit, sort);
        const pagedResult = await run(wrapped);
        if (pagedResult.ok) {
            return stamp(pagedResult, true);
        }

        if (offset === 0 && !sort) {
            const raw = await run(sql);
            if (raw.ok) {
                this.output.appendLine(
                    '[query] paging wrap failed; ran the original SQL for the first page instead'
                );
                return stamp(raw, false);
            }
        }

        return {
            ...pagedResult,
            sql,
            executedSql: pagedResult.executedSql,
            maxRows: pageSize,
            pageOffset: offset,
            paged: false,
            sort,
            error: pagedResult.error
        };
    }

    private async executeMssql(
        sql: string,
        params: Record<string, string | null>,
        maxRows: number,
        started: number
    ): Promise<QueryResult> {
        const rewritten = rewriteNamedBinds(sql, 'at');
        const fail = (error: string): QueryResult => ({
            ok: false,
            sql,
            executedSql: rewritten.sql,
            params,
            columns: [],
            rows: [],
            rowsAffected: undefined,
            elapsedMs: Date.now() - started,
            truncated: false,
            maxRows,
            pageOffset: 0,
            paged: false,
            error
        });
        if (!this.mssqlPool) {
            return fail(this.lastError ?? 'No database connection is available.');
        }
        try {
            const result = await this.runWithReconnect(() => {
                const request = this.mssqlPool!.request();
                const bound = new Set<string>();
                for (const name of rewritten.namesInOrder) {
                    const key = name.toLowerCase();
                    if (bound.has(key)) {
                        continue;
                    }
                    bound.add(key);
                    request.input(name, mssql.NVarChar, lookupParam(params, name));
                }
                return request.query(rewritten.sql);
            });
            const recordset = firstMssqlRecordset(result);
            const columns = mssqlColumns(recordset);
            const rawRows = recordset ?? [];
            const truncated = rawRows.length > maxRows;
            const sliced = truncated ? rawRows.slice(0, maxRows) : rawRows;
            const rows = sliced.map((row) => columns.map((column) => formatQueryCell(row[column])));
            const rowsAffected = sumRowsAffected(result.rowsAffected);
            this.output.appendLine(
                `[query] mssql ${rows.length} row(s) in ${Date.now() - started}ms`
            );
            return {
                ok: true,
                sql,
                executedSql: rewritten.sql,
                params,
                columns,
                rows,
                rowsAffected,
                elapsedMs: Date.now() - started,
                truncated,
                maxRows,
                pageOffset: 0,
                paged: false
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[query] mssql failed: ${message}`);
            return fail(message);
        }
    }

    private async executeMysql(
        sql: string,
        params: Record<string, string | null>,
        maxRows: number,
        started: number
    ): Promise<QueryResult> {
        const rewritten = rewriteNamedBinds(sql, 'qmark');
        const fail = (error: string): QueryResult => ({
            ok: false,
            sql,
            executedSql: rewritten.sql,
            params,
            columns: [],
            rows: [],
            rowsAffected: undefined,
            elapsedMs: Date.now() - started,
            truncated: false,
            maxRows,
            pageOffset: 0,
            paged: false,
            error
        });
        if (!this.mysqlPool) {
            return fail(this.lastError ?? 'No database connection is available.');
        }
        try {
            const values = rewritten.namesInOrder.map((name) => lookupParam(params, name));
            const [raw, fields] = await this.runWithReconnect(() =>
                this.mysqlPool!.query(rewritten.sql, values)
            );
            if (isMysqlResultSetHeader(raw)) {
                this.output.appendLine(
                    `[query] mysql ${raw.affectedRows} row(s) affected in ${Date.now() - started}ms`
                );
                return {
                    ok: true,
                    sql,
                    executedSql: rewritten.sql,
                    params,
                    columns: [],
                    rows: [],
                    rowsAffected: raw.affectedRows,
                    elapsedMs: Date.now() - started,
                    truncated: false,
                    maxRows,
                    pageOffset: 0,
                    paged: false
                };
            }
            const rowPackets = firstMysqlRowset(raw);
            const columns = mysqlColumns(rowPackets, fields);
            const truncated = rowPackets.length > maxRows;
            const sliced = truncated ? rowPackets.slice(0, maxRows) : rowPackets;
            const rows = sliced.map((row) =>
                columns.map((column) => formatQueryCell((row as mysql.RowDataPacket)[column]))
            );
            this.output.appendLine(
                `[query] mysql ${rows.length} row(s) in ${Date.now() - started}ms`
            );
            return {
                ok: true,
                sql,
                executedSql: rewritten.sql,
                params,
                columns,
                rows,
                rowsAffected: undefined,
                elapsedMs: Date.now() - started,
                truncated,
                maxRows,
                pageOffset: 0,
                paged: false
            };
        } catch (error) {
            const err = error as { sqlMessage?: string; message?: string };
            const message = err.sqlMessage || err.message || String(error);
            this.output.appendLine(`[query] mysql failed: ${message}`);
            return fail(message);
        }
    }

    private async disposePool(): Promise<void> {
        const mssqlPool = this.mssqlPool;
        const mysqlPool = this.mysqlPool;
        this.mssqlPool = undefined;
        this.mysqlPool = undefined;
        this.lastHealthyAt = 0;
        if (mssqlPool) {
            try {
                await mssqlPool.close();
            } catch {
                // Closing a broken pool is best effort.
            }
        }
        if (mysqlPool) {
            try {
                await mysqlPool.end();
            } catch {
                // Closing a broken pool is best effort.
            }
        }
    }

    /**
     * Rebuilds the connection after a settings change and reloads metadata.
     */
    public async reconfigure(): Promise<void> {
        await this.disposePool();
        this.setState('disconnected');
        this.schemaCache = SchemaCache.empty();
        const config = this.getConfig();
        if (!config.enabled) {
            this.setState('disabled');
            this.stopRefreshTimer();
            this.schemaEmitter.fire(this.schemaCache);
            return;
        }
        await this.loadDiskCache();
        this.schemaEmitter.fire(this.schemaCache);
        this.startRefreshTimer();
        await this.refreshSchema();
    }

    public dispose(): void {
        this.stopRefreshTimer();
        void this.disposePool();
        this.stateEmitter.dispose();
        this.schemaEmitter.dispose();
    }
}

function formatQueryCell(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
        return value.length === 0 ? '[binary]' : `[binary ${value.length} bytes]`;
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function firstMssqlRecordset(
    result: mssql.IResult<Record<string, unknown>>
): mssql.IRecordSet<Record<string, unknown>> | undefined {
    const sets = result.recordsets;
    if (Array.isArray(sets) && sets.length > 0 && Array.isArray(sets[0])) {
        return sets[0] as mssql.IRecordSet<Record<string, unknown>>;
    }
    return result.recordset as mssql.IRecordSet<Record<string, unknown>> | undefined;
}

function mssqlColumns(
    recordset: mssql.IRecordSet<Record<string, unknown>> | undefined
): string[] {
    if (!recordset) {
        return [];
    }
    if (recordset.columns) {
        return Object.keys(recordset.columns);
    }
    if (recordset.length > 0) {
        return Object.keys(recordset[0]);
    }
    return [];
}

function sumRowsAffected(values: number[] | undefined): number | undefined {
    if (!values || values.length === 0) {
        return undefined;
    }
    return values.reduce((sum, value) => sum + value, 0);
}

function isMysqlResultSetHeader(raw: unknown): raw is mysql.ResultSetHeader {
    return Boolean(
        raw && typeof raw === 'object' && !Array.isArray(raw) && 'affectedRows' in raw
    );
}

function firstMysqlRowset(raw: unknown): mysql.RowDataPacket[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    if (raw.length === 0) {
        return [];
    }
    if (Array.isArray(raw[0])) {
        return (raw[0] as mysql.RowDataPacket[]) ?? [];
    }
    return raw as mysql.RowDataPacket[];
}

function mysqlColumns(
    rows: mysql.RowDataPacket[],
    fields: unknown
): string[] {
    if (Array.isArray(fields) && fields.length > 0) {
        const first = fields[0];
        const list = Array.isArray(first)
            ? (first as mysql.FieldPacket[])
            : (fields as mysql.FieldPacket[]);
        const names = list
            .map((field) => field?.name)
            .filter((name): name is string => typeof name === 'string' && name.length > 0);
        if (names.length > 0) {
            return names;
        }
    }
    if (rows.length > 0) {
        return Object.keys(rows[0]);
    }
    return [];
}

function collectRequestErrors(error: unknown): mssql.RequestError[] {
    if (!(error instanceof Error)) {
        return [];
    }
    const candidate = error as mssql.RequestError & { precedingErrors?: unknown };
    const results: mssql.RequestError[] = [];
    if (Array.isArray(candidate.precedingErrors)) {
        for (const preceding of candidate.precedingErrors) {
            if (preceding instanceof Error) {
                results.push(preceding as mssql.RequestError);
            }
        }
    }
    if (typeof candidate.number === 'number' || candidate.name === 'RequestError') {
        results.push(candidate);
    }
    return results;
}

function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function errorErrno(error: unknown): number | undefined {
    const err = error as { errno?: number; number?: number };
    if (typeof err.errno === 'number') {
        return err.errno;
    }
    if (typeof err.number === 'number') {
        return err.number;
    }
    return undefined;
}

function hintForConnectError(message: string, config: ExtensionConfig): string {
    const lower = message.toLowerCase();
    if (lower.includes('unable to process incoming packet') || lower.includes('connection lost')) {
        if (config.engine === 'mssql') {
            return (
                'This usually means the host is not SQL Server, or TLS failed. ' +
                'If you use MySQL, set Engine to MySQL (port 3306) on the login page. ' +
                'For local SQL Server: enable Trust server certificate, or turn Encrypt off.'
            );
        }
        return 'MySQL handshake failed. Check host, port 3306, user/password, and TLS settings.';
    }
    if (lower.includes('login failed') || lower.includes('access denied')) {
        return 'Username or password is wrong, or the login cannot access this database.';
    }
    if (lower.includes('getaddrinfo') || lower.includes('enotfound')) {
        return 'Server host name could not be resolved. Check the Server field.';
    }
    if (lower.includes('etimeout') || lower.includes('timeout')) {
        return 'Timed out. Check VPN/firewall, port, and that the database server is running.';
    }
    if (lower.includes('certificate') || lower.includes('self signed')) {
        return 'Enable "Trust server certificate" on the login page for local/self-signed TLS.';
    }
    return 'Open BiSql: Open Connection / Login and verify engine, server, and port.';
}
