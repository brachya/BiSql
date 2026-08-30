import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as mssql from 'mssql';
import * as mysql from 'mysql2/promise';
import * as pg from 'pg';
import {
    collectCteNames,
    collectTableRefs,
    statementsForExplainDryRun,
    tokenizeSql
} from '../parser/sqlExtractor';
import { FormatKeywordCase, parseKeywordCase } from '../sql/formatEmbeddedSql';
import { applyPlaceholders, lookupParam, rewriteNamedBinds } from '../sql/parameters';
import { qualifyCrossDatabaseSql } from '../sql/qualifyTables';
import {
    buildPagedSelect,
    canPageSelect,
    clampOffset,
    clampPageSize,
    QueryPageOptions,
    ResultSort
} from '../sql/resultPage';
import {
    DbEngine,
    LoginKind,
    defaultPortForEngine,
    engineForLoginKind,
    parseEngine,
    parseLoginKind
} from './engines';
import {
    ConnectionProfile,
    FlatLogin,
    emptyProfile,
    migrateFromFlat,
    newConnectionId,
    normalizeProfiles,
    profileFromFlat
} from './connectionProfiles';

export const CONFIG_SECTION = 'bisql';
const LEGACY_CONFIG_SECTION = 'sqlPythonValidator';
const SECRET_KEY_GLOBAL = 'sqlPythonValidator.password.global';
const SECRET_KEY_LEGACY = 'sqlPythonValidator.password';
const SCOPE_STATE_KEY = 'bisql.settingsScope';
const LEGACY_SCOPE_STATE_KEY = 'sqlPythonValidator.settingsScope';
const CACHE_VERSION = 3;

export type { DbEngine, LoginKind } from './engines';
export {
    defaultPortForEngine,
    engineForLoginKind,
    parseEngine,
    parseLoginKind
} from './engines';
export type { ConnectionProfile } from './connectionProfiles';

/** Shared across all projects, or only this workspace. */
export type SettingsScope = 'global' | 'workspace';

const CONNECTION_SETTING_KEYS = [
    'engine',
    'loginKind',
    'server',
    'database',
    'databases',
    'user',
    'port',
    'encrypt',
    'trustServerCertificate',
    'enabled',
    'password'
] as const;

export interface ExtensionConfig {
    enabled: boolean;
    connectionId: string;
    connectionName: string;
    engine: DbEngine;
    loginKind: LoginKind;
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
    /** Max rows shown in the Run Selected SQL results tab. */
    queryMaxRows: number;
    formatKeywordCase: FormatKeywordCase;
    formatTabWidth: number;
    /** Register a localhost MCP server so Cursor's agent can use this connection. */
    mcpEnabled: boolean;
    /** Allow INSERT/UPDATE/DELETE and similar through MCP. Default off. */
    mcpAllowMutating: boolean;
    /** Max rows returned to the agent in one MCP tool reply. */
    mcpMaxResultRows: number;
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

/** System catalog used only to list database names when the user has not picked a default yet. */
function catalogDatabaseForEngine(engine: DbEngine): string {
    if (engine === 'mysql') {
        return 'information_schema';
    }
    if (engine === 'postgres') {
        return 'postgres';
    }
    return 'master';
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
    /** schema.table (MSSQL / Postgres) or database.table (MySQL). */
    fullName: string;
    /** database.schema.table (MSSQL), schema.table (Postgres), or database.table (MySQL). */
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
    /**
     * JSON-safe cells when `page.raw` was true. `null` is SQL NULL, not the
     * string `"NULL"`. Numbers stay numbers.
     */
    rawRows?: unknown[][];
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
    /** Plan / EXPLAIN tabs. Refresh re-explains; cells cannot be edited. */
    readOnly?: boolean;
}

export interface ExplainResult {
    ok: boolean;
    sql: string;
    executedSql: string;
    engine: DbEngine;
    columns: string[];
    rows: unknown[][];
    elapsedMs: number;
    error?: string;
    /** Extra note (for example MySQL fell back from FORMAT=JSON). */
    note?: string;
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

/** Default schema used when a bare table name matches more than one schema. */
export function defaultSchemaForEngine(engine: DbEngine): string | undefined {
    if (engine === 'mysql') {
        return undefined;
    }
    return engine === 'postgres' ? 'public' : 'dbo';
}

/**
 * Cache / display name. Postgres SQL itself uses schema.table only
 * (see formatQualifiedTable); this still stores schema.table so lookups work.
 */
export function buildQualifiedName(
    database: string,
    schema: string,
    name: string,
    engine: DbEngine
): string {
    if (engine === 'mysql') {
        return `${database}.${name}`;
    }
    if (engine === 'postgres') {
        return `${schema}.${name}`;
    }
    return `${database}.${schema}.${name}`;
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
     * All tables matching a reference, before default-DB picking.
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
            if (hit) {
                return [hit];
            }
            // Postgres (and other 2-part catalogs): last two parts are schema.table.
            return [...(this.byFullLower.get(`${schema}.${table}`) ?? [])];
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
     * Resolves Users, dbo.Users, [dbo].[Users], db.dbo.Users.
     * The default database breaks ties across catalogs.
     */
    public findTable(
        reference: string,
        defaultDatabase = '',
        defaultSchema = 'dbo'
    ): TableInfo | undefined {
        const matches = this.findTableMatches(reference);
        if (matches.length === 0) {
            return undefined;
        }
        if (matches.length === 1) {
            return matches[0];
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
                const schemaKey = defaultSchema.toLowerCase();
                return (
                    inDefault.find((table) => table.schema.toLowerCase() === schemaKey) ??
                    inDefault[0]
                );
            }
        }

        const schemaKey = defaultSchema.toLowerCase();
        return matches.find((table) => table.schema.toLowerCase() === schemaKey) ?? matches[0];
    }

    public findColumn(
        tableReference: string,
        columnName: string,
        defaultDatabase = '',
        defaultSchema = 'dbo'
    ): ColumnInfo | undefined {
        const table = this.findTable(tableReference, defaultDatabase, defaultSchema);
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
    private pgPool: pg.Pool | undefined;
    private connecting: Promise<boolean> | undefined;
    private schemaCache = SchemaCache.empty();
    private state: ConnectionState = 'disconnected';
    private lastError: string | undefined;
    private lastHealthyAt = 0;
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshInFlight: Promise<boolean> | undefined;
    private liveSchemaRequested = false;
    private cachedConfig: ExtensionConfig | undefined;

    private readonly stateEmitter = new vscode.EventEmitter<ConnectionState>();
    private readonly schemaEmitter = new vscode.EventEmitter<SchemaCache>();

    public readonly onDidChangeState = this.stateEmitter.event;
    public readonly onDidChangeSchema = this.schemaEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel
    ) {}

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
        if (!this.cachedConfig) {
            this.cachedConfig = this.readConfigFromLayers('effective');
        }
        return this.cachedConfig;
    }

    public invalidateConfigCache(): void {
        this.cachedConfig = undefined;
    }

    /**
     * Connect and load live schema the first time a file actually contains SQL,
     * or a command needs the database. Opening a plain Python file does nothing.
     */
    public requestLiveSchema(): void {
        if (this.liveSchemaRequested) {
            return;
        }
        this.liveSchemaRequested = true;
        this.startRefreshTimer();
        void this.refreshSchema();
    }

    /**
     * Reads values from User settings (shared) or Workspace settings (this project).
     * Missing workspace values fall back to the shared/global ones.
     */
    public getConfigForScope(scope: SettingsScope): ExtensionConfig {
        if (scope === 'global' || !this.hasWorkspaceFolder()) {
            return this.readInspectedGlobalConfig();
        }
        return this.getConfig();
    }

    public listProfiles(): ConnectionProfile[] {
        return this.readProfiles();
    }

    public getActiveConnectionId(): string {
        return this.readActiveConnectionId(this.readProfiles());
    }

    public isActivePinnedToWorkspace(): boolean {
        if (!this.hasWorkspaceFolder()) {
            return false;
        }
        const id = this.inspectActiveConnectionId('workspace');
        return Boolean(id) && this.readProfiles().some((profile) => profile.id === id);
    }

    public getProfile(id: string): ConnectionProfile | undefined {
        return this.readProfiles().find((profile) => profile.id === id);
    }

    public configForProfile(profile: ConnectionProfile): ExtensionConfig {
        return this.configFromLogin(this.readPrefs('effective'), profile);
    }

    /**
     * Copy the old single login into `bisql.connections` once. Keeps old keys.
     */
    public async migrateSavedConnections(): Promise<void> {
        const existing = this.readProfiles();
        const result = migrateFromFlat({
            existingProfiles: existing,
            existingActiveId: this.inspectActiveConnectionId('global') ?? this.inspectActiveConnectionId('workspace'),
            global: this.readInspectedFlat('global'),
            workspace: this.hasWorkspaceFolder() ? this.readInspectedFlat('workspace') : undefined,
            effective: this.readInspectedFlat('effective') ?? {
                loginKind: 'mssql',
                engine: 'mssql',
                server: '',
                database: '',
                databases: [],
                user: '',
                port: 1433,
                encrypt: true,
                trustServerCertificate: false
            }
        });
        if (!result.ran) {
            return;
        }

        await this.writeProfiles(result.profiles);
        if (result.activeId) {
            await this.writeActiveConnectionId(result.activeId, vscode.ConfigurationTarget.Global);
        }
        this.invalidateConfigCache();

        const written = this.readProfiles();
        if (written.length === 0) {
            this.output.appendLine('[migrate] write failed; keeping the old single login');
            return;
        }

        if (result.globalId) {
            const password = await this.readLegacyPassword('global');
            if (password) {
                await this.storePasswordForId(result.globalId, password);
            }
        }
        if (result.workspaceId) {
            const password = await this.readLegacyPassword('workspace');
            if (password) {
                await this.storePasswordForId(result.workspaceId, password);
            }
        }
        this.output.appendLine(
            `[migrate] saved ${written.length} connection(s); active ${result.activeId || '(none)'}`
        );
    }

    private readConfigFromLayers(mode: 'effective' | 'global'): ExtensionConfig {
        const prefs = this.readPrefs(mode);
        const profiles = this.readProfiles();
        if (profiles.length > 0) {
            const activeId = this.readActiveConnectionId(profiles);
            const profile = profiles.find((item) => item.id === activeId) ?? profiles[0];
            return this.configFromLogin(prefs, profile);
        }
        const flat = this.readInspectedFlat(mode === 'global' ? 'global' : 'effective');
        if (flat) {
            return this.configFromLogin(prefs, profileFromFlat(flat, ''));
        }
        return this.configFromLogin(prefs, emptyProfile(''));
    }

    private readPrefs(mode: 'effective' | 'global'): Omit<
        ExtensionConfig,
        | 'connectionId'
        | 'connectionName'
        | 'engine'
        | 'loginKind'
        | 'server'
        | 'database'
        | 'databases'
        | 'user'
        | 'port'
        | 'encrypt'
        | 'trustServerCertificate'
    > {
        const pick = <T>(key: string, fallback: T): T => this.pickSetting(key, fallback, mode);
        return {
            enabled: pick<boolean>('enabled', true),
            passwordSetting: String(pick<string>('password', '')),
            connectionTimeout: pick<number>('connectionTimeout', 15000),
            schemaRefreshMinutes: pick<number>('schemaRefreshMinutes', 30),
            validateOnType: pick<boolean>('validateOnType', true),
            dryRunOnSave: pick<boolean>('dryRunOnSave', true),
            detectByKeyword: pick<boolean>('detectByKeyword', true),
            promptQuickSuggestions: pick<boolean>('promptQuickSuggestions', true),
            cacheSchemaToDisk: pick<boolean>('cacheSchemaToDisk', true),
            queryMaxRows: Math.max(1, pick<number>('queryMaxRows', 1000)),
            formatKeywordCase: parseKeywordCase(pick<string>('formatKeywordCase', 'upper')),
            formatTabWidth: Math.max(1, Math.min(8, pick<number>('formatTabWidth', 4))),
            mcpEnabled: pick<boolean>('mcpEnabled', true),
            mcpAllowMutating: pick<boolean>('mcpAllowMutating', false),
            mcpMaxResultRows: Math.max(1, Math.min(1000, pick<number>('mcpMaxResultRows', 50)))
        };
    }

    private configFromLogin(
        prefs: ReturnType<SqlServerService['readPrefs']>,
        profile: ConnectionProfile
    ): ExtensionConfig {
        return {
            ...prefs,
            connectionId: profile.id,
            connectionName: profile.name,
            engine: profile.engine,
            loginKind: profile.loginKind,
            server: profile.server,
            database: profile.database,
            databases: profile.databases,
            user: profile.user,
            port: profile.port,
            encrypt: profile.encrypt,
            trustServerCertificate: profile.trustServerCertificate
        };
    }

    private readProfiles(): ConnectionProfile[] {
        const inspected = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect('connections');
        return normalizeProfiles(inspected?.globalValue ?? inspected?.defaultValue);
    }

    private readActiveConnectionId(profiles: ConnectionProfile[]): string {
        const workspaceId = this.hasWorkspaceFolder() ? this.inspectActiveConnectionId('workspace') : undefined;
        if (workspaceId && profiles.some((profile) => profile.id === workspaceId)) {
            return workspaceId;
        }
        const globalId = this.inspectActiveConnectionId('global');
        if (globalId && profiles.some((profile) => profile.id === globalId)) {
            return globalId;
        }
        return profiles[0]?.id ?? '';
    }

    private inspectActiveConnectionId(layer: 'global' | 'workspace'): string | undefined {
        const inspected = vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .inspect<string>('activeConnectionId');
        const value =
            layer === 'workspace'
                ? (inspected?.workspaceFolderValue ?? inspected?.workspaceValue)
                : inspected?.globalValue;
        const id = typeof value === 'string' ? value.trim() : '';
        return id || undefined;
    }

    private async writeProfiles(profiles: ConnectionProfile[]): Promise<void> {
        const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await section.update('connections', profiles, vscode.ConfigurationTarget.Global);
        this.invalidateConfigCache();
    }

    private async writeActiveConnectionId(
        id: string,
        target: vscode.ConfigurationTarget
    ): Promise<void> {
        const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await section.update('activeConnectionId', id || undefined, target);
        this.invalidateConfigCache();
    }

    private readInspectedFlat(layer: 'global' | 'workspace' | 'effective'): FlatLogin | undefined {
        const pick = (key: string): unknown => {
            if (layer === 'effective') {
                return this.pickSetting(key, undefined, 'effective');
            }
            return this.inspectLayerValue(key, layer);
        };
        const server = String(pick('server') ?? '').trim();
        if (!server) {
            return undefined;
        }
        const storedEngine = parseEngine(pick('engine'));
        const loginKind = parseLoginKind(pick('loginKind'), storedEngine, server);
        const engine = engineForLoginKind(loginKind);
        return {
            loginKind,
            engine,
            server,
            database: String(pick('database') ?? '').trim(),
            databases: normalizeDatabaseList(pick('databases')),
            user: String(pick('user') ?? '').trim(),
            port: Number(pick('port')) || defaultPortForEngine(engine),
            encrypt: pick('encrypt') !== false,
            trustServerCertificate: Boolean(pick('trustServerCertificate'))
        };
    }

    private inspectLayerValue(key: string, layer: 'global' | 'workspace'): unknown {
        const current = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect(key);
        const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION).inspect(key);
        if (layer === 'global') {
            return current?.globalValue ?? legacy?.globalValue;
        }
        return (
            current?.workspaceFolderValue ??
            current?.workspaceValue ??
            legacy?.workspaceFolderValue ??
            legacy?.workspaceValue
        );
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

    private passwordSecretKey(id: string): string {
        return `bisql.connection.${id}.password`;
    }

    private async storePasswordForId(id: string, password: string): Promise<void> {
        if (!id) {
            return;
        }
        await this.context.secrets.store(this.passwordSecretKey(id), password);
    }

    public async setPassword(password: string, connectionId?: string): Promise<void> {
        const id = connectionId || this.getActiveConnectionId();
        if (id) {
            await this.storePasswordForId(id, password);
            return;
        }
        await this.context.secrets.store(this.secretKeyForScope(this.getSettingsScope()), password);
    }

    public async clearPassword(connectionId?: string): Promise<void> {
        const id = connectionId || this.getActiveConnectionId();
        if (id) {
            await this.context.secrets.delete(this.passwordSecretKey(id));
            return;
        }
        const resolved = this.getSettingsScope();
        await this.context.secrets.delete(this.secretKeyForScope(resolved));
    }

    public async hasStoredPassword(connectionId?: string): Promise<boolean> {
        const value = await this.getPassword(connectionId);
        return value !== undefined && value !== '';
    }

    /** Profile secret first, then the old single-login keys. Never drop those. */
    public async getPassword(connectionId?: string): Promise<string | undefined> {
        const id = connectionId || this.getActiveConnectionId();
        if (id) {
            const stored = await this.context.secrets.get(this.passwordSecretKey(id));
            if (stored !== undefined && stored !== '') {
                return stored;
            }
        }
        return this.readLegacyPassword(this.getSettingsScope());
    }

    private async readLegacyPassword(scope: SettingsScope): Promise<string | undefined> {
        const primary = await this.context.secrets.get(this.secretKeyForScope(scope));
        if (primary !== undefined && primary !== '') {
            return primary;
        }
        if (scope === 'global') {
            const legacy = await this.context.secrets.get(SECRET_KEY_LEGACY);
            if (legacy !== undefined && legacy !== '') {
                return legacy;
            }
        }
        if (scope === 'workspace') {
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

    public async saveConnectionSettings(settings: {
        connectionId?: string;
        name?: string;
        engine: DbEngine;
        loginKind: LoginKind;
        server: string;
        database: string;
        databases?: string[];
        user: string;
        port: number;
        encrypt: boolean;
        trustServerCertificate: boolean;
        enabled: boolean;
        pinToWorkspace?: boolean;
        activate?: boolean;
    }): Promise<string> {
        const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await section.update('enabled', settings.enabled, vscode.ConfigurationTarget.Global);

        const loginKind = parseLoginKind(settings.loginKind, settings.engine, settings.server);
        const engine = engineForLoginKind(loginKind);
        const profile = profileFromFlat(
            {
                loginKind,
                engine,
                server: settings.server,
                database: settings.database,
                databases: settings.databases ?? [],
                user: settings.user,
                port: settings.port,
                encrypt: settings.encrypt,
                trustServerCertificate: settings.trustServerCertificate
            },
            settings.connectionId?.trim() || newConnectionId(),
            settings.name
        );

        const profiles = this.readProfiles();
        const index = profiles.findIndex((item) => item.id === profile.id);
        if (index >= 0) {
            if (!settings.name?.trim()) {
                profile.name = profiles[index].name;
            }
            profiles[index] = profile;
        } else {
            profiles.push(profile);
        }
        await this.writeProfiles(profiles);
        if (settings.activate !== false) {
            await this.setActiveConnectionId(profile.id, settings.pinToWorkspace);
        }
        return profile.id;
    }

    public async addProfile(): Promise<string> {
        const profile = emptyProfile();
        const profiles = [...this.readProfiles(), profile];
        await this.writeProfiles(profiles);
        return profile.id;
    }

    public async renameProfile(id: string, name: string): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        const profiles = this.readProfiles();
        const index = profiles.findIndex((item) => item.id === id);
        if (index < 0) {
            return;
        }
        profiles[index] = { ...profiles[index], name: trimmed };
        await this.writeProfiles(profiles);
    }

    public async deleteProfile(id: string): Promise<void> {
        const profiles = this.readProfiles().filter((item) => item.id !== id);
        await this.writeProfiles(profiles);
        await this.context.secrets.delete(this.passwordSecretKey(id));
        const active = this.getActiveConnectionId();
        if (active === id || !profiles.some((item) => item.id === active)) {
            await this.setActiveConnectionId(profiles[0]?.id ?? '', this.isActivePinnedToWorkspace());
        }
        await this.reconfigure();
    }

    public async setActiveConnectionId(id: string, pinToWorkspace?: boolean): Promise<void> {
        const pin = pinToWorkspace === true && this.hasWorkspaceFolder();
        if (pin) {
            await this.writeActiveConnectionId(id, vscode.ConfigurationTarget.Workspace);
        } else if (this.hasWorkspaceFolder()) {
            await this.writeActiveConnectionId('', vscode.ConfigurationTarget.Workspace);
        }
        await this.writeActiveConnectionId(id, vscode.ConfigurationTarget.Global);
    }

    public async switchActive(id: string, pinToWorkspace?: boolean): Promise<void> {
        await this.setActiveConnectionId(id, pinToWorkspace);
        await this.reconfigure();
    }

    /** Default-database-aware table lookup used by providers. */
    public findTable(reference: string): TableInfo | undefined {
        const config = this.getConfig();
        return this.schemaCache.findTable(
            reference,
            config.database,
            defaultSchemaForEngine(config.engine) ?? 'dbo'
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
        if (config.engine === 'postgres') {
            return this.pgPool !== undefined;
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
            } else if (config.engine === 'postgres') {
                await this.pgPool!.query('SELECT 1');
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

    private buildPostgresPool(config: ExtensionConfig, password: string): pg.Pool {
        const ssl = config.encrypt
            ? { rejectUnauthorized: !config.trustServerCertificate }
            : false;
        const pool = new pg.Pool({
            host: config.server,
            port: config.port,
            user: config.user,
            password,
            database: config.database,
            max: 4,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: config.connectionTimeout,
            application_name: 'BiSql',
            ssl
        });
        pool.on('error', (err: Error) => {
            this.output.appendLine(`[pool] ${err.message}`);
        });
        return pool;
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
                } else if (config.engine === 'postgres') {
                    await this.disposePool();
                    const pool = this.buildPostgresPool(config, password);
                    const client = await pool.connect();
                    client.release();
                    this.pgPool = pool;
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
                if (!this.liveSchemaRequested) {
                    this.liveSchemaRequested = true;
                    this.startRefreshTimer();
                }
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
            if (config.engine === 'postgres') {
                const result = await this.pgPool!.query<{ version: string }>(
                    'SELECT version() AS version'
                );
                const version = result.rows[0]?.version ?? 'PostgreSQL';
                return { ok: true, message: version.split(',')[0].trim() };
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
            if (config.engine === 'postgres') {
                return await this.refreshPostgresSchema(config);
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

    private async refreshPostgresSchema(config: ExtensionConfig): Promise<boolean> {
        const pool = this.pgPool!;
        const databaseName = config.database;

        const [columnResult, keyResult] = await Promise.all([
            pool.query<{
                schema_name: string;
                table_name: string;
                is_view: boolean;
                column_name: string;
                column_id: number;
                type_name: string;
                type_display: string;
                is_nullable: boolean;
                is_identity: boolean;
                is_computed: boolean;
            }>(
                `SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    (c.relkind IN ('v', 'm')) AS is_view,
                    a.attname AS column_name,
                    a.attnum AS column_id,
                    t.typname AS type_name,
                    format_type(a.atttypid, a.atttypmod) AS type_display,
                    NOT a.attnotnull AS is_nullable,
                    (a.attidentity <> '' OR COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '') LIKE 'nextval(%') AS is_identity,
                    (a.attgenerated <> '') AS is_computed
                 FROM pg_catalog.pg_class c
                 INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 INNER JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
                 INNER JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
                 LEFT JOIN pg_catalog.pg_attrdef ad
                        ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                 WHERE c.relkind IN ('r', 'p', 'v', 'm')
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                   AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
                   AND a.attnum > 0
                   AND NOT a.attisdropped
                 ORDER BY n.nspname, c.relname, a.attnum`
            ),
            pool.query<{
                schema_name: string;
                table_name: string;
                column_name: string;
            }>(
                `SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    a.attname AS column_name
                 FROM pg_catalog.pg_index i
                 INNER JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
                 INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 INNER JOIN pg_catalog.pg_attribute a
                         ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
                 WHERE i.indisprimary
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                   AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'`
            )
        ]);

        const primaryKeys = new Set<string>();
        for (const row of keyResult.rows) {
            primaryKeys.add(
                `${row.schema_name.toLowerCase()}.${row.table_name.toLowerCase()}.${row.column_name.toLowerCase()}`
            );
        }

        const tablesByQualified = new Map<string, TableInfo>();
        for (const row of columnResult.rows) {
            const schemaName = String(row.schema_name);
            const tableName = String(row.table_name);
            const fullName = `${schemaName}.${tableName}`;
            const qualifiedName = buildQualifiedName(
                databaseName,
                schemaName,
                tableName,
                'postgres'
            );
            let table = tablesByQualified.get(qualifiedName.toLowerCase());
            if (!table) {
                table = {
                    database: databaseName,
                    schema: schemaName,
                    name: tableName,
                    fullName,
                    qualifiedName,
                    isView: Boolean(row.is_view),
                    columns: [],
                    columnsByLower: new Map<string, ColumnInfo>()
                };
                tablesByQualified.set(qualifiedName.toLowerCase(), table);
            }
            const column: ColumnInfo = {
                name: String(row.column_name),
                ordinal: Number(row.column_id) || 0,
                typeName: String(row.type_name),
                typeDisplay: String(row.type_display || row.type_name),
                isNullable: Boolean(row.is_nullable),
                isIdentity: Boolean(row.is_identity),
                isComputed: Boolean(row.is_computed),
                isPrimaryKey: primaryKeys.has(
                    `${schemaName.toLowerCase()}.${tableName.toLowerCase()}.${String(row.column_name).toLowerCase()}`
                )
            };
            table.columns.push(column);
            table.columnsByLower.set(column.name.toLowerCase(), column);
        }

        const cache = new SchemaCache([...tablesByQualified.values()], Date.now(), false);
        this.schemaCache = cache;
        this.schemaEmitter.fire(cache);
        this.output.appendLine(
            `[schema] loaded ${cache.tables.length} tables and views from ${databaseName} (postgres)`
        );
        void this.saveDiskCache();
        return true;
    }

    /**
     * Lists databases the login can see. Uses the live pool when a default
     * database is set; otherwise opens a short-lived catalog connection
     * (`master` / `information_schema` / `postgres`) so the login page can
     * show names before the user picks a default.
     */
    public async listDatabases(): Promise<{ ok: boolean; databases: string[]; message: string }> {
        const config = this.getConfig();
        if (!config.server.trim()) {
            return {
                ok: false,
                databases: [],
                message: 'Set server first.'
            };
        }

        if (this.isConfigured(config)) {
            const ok = await this.ensureConnected();
            if (ok) {
                try {
                    const databases = await this.queryVisibleDatabaseNames(config.engine, {
                        mysql: this.mysqlPool,
                        postgres: this.pgPool,
                        mssql: this.mssqlPool
                    });
                    return { ok: true, databases, message: `${databases.length} databases` };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { ok: false, databases: [], message };
                }
            }
        }

        return this.listDatabasesViaCatalog(config);
    }

    private async listDatabasesViaCatalog(
        config: ExtensionConfig
    ): Promise<{ ok: boolean; databases: string[]; message: string }> {
        const listing: ExtensionConfig = {
            ...config,
            database: catalogDatabaseForEngine(config.engine)
        };
        const password = await this.resolvePassword(listing);
        this.output.appendLine(
            `[connect] listing databases via ${listing.engine} catalog ${listing.database}`
        );

        let mysqlPool: mysql.Pool | undefined;
        let pgPool: pg.Pool | undefined;
        let mssqlPool: mssql.ConnectionPool | undefined;
        try {
            if (listing.engine === 'mysql') {
                mysqlPool = this.buildMysqlPool(listing, password);
                const conn = await mysqlPool.getConnection();
                conn.release();
            } else if (listing.engine === 'postgres') {
                pgPool = this.buildPostgresPool(listing, password);
                const client = await pgPool.connect();
                client.release();
            } else {
                mssqlPool = new mssql.ConnectionPool(this.buildMssqlConfig(listing, password));
                await mssqlPool.connect();
            }
            const databases = await this.queryVisibleDatabaseNames(listing.engine, {
                mysql: mysqlPool,
                postgres: pgPool,
                mssql: mssqlPool
            });
            return { ok: true, databases, message: `${databases.length} databases` };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                databases: [],
                message: `${message} Type a database name if the catalog is blocked.`
            };
        } finally {
            if (mysqlPool) {
                try {
                    await mysqlPool.end();
                } catch {
                    // Closing a list-only pool is best effort.
                }
            }
            if (pgPool) {
                try {
                    await pgPool.end();
                } catch {
                    // Closing a list-only pool is best effort.
                }
            }
            if (mssqlPool) {
                try {
                    await mssqlPool.close();
                } catch {
                    // Closing a list-only pool is best effort.
                }
            }
        }
    }

    private async queryVisibleDatabaseNames(
        engine: DbEngine,
        pools: {
            mysql?: mysql.Pool;
            postgres?: pg.Pool;
            mssql?: mssql.ConnectionPool;
        }
    ): Promise<string[]> {
        if (engine === 'mysql') {
            const [rows] = await pools.mysql!.query<mysql.RowDataPacket[]>(
                `SELECT SCHEMA_NAME AS name
                 FROM information_schema.SCHEMATA
                 WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
                 ORDER BY SCHEMA_NAME`
            );
            return rows.map((row) => String(row.name));
        }
        if (engine === 'postgres') {
            const result = await pools.postgres!.query<{ name: string }>(
                `SELECT datname AS name
                 FROM pg_database
                 WHERE datallowconn
                   AND NOT datistemplate
                 ORDER BY datname`
            );
            return result.rows.map((row) => row.name);
        }
        const result = await pools.mssql!.request().query<{ name: string }>(
            `SELECT name
             FROM sys.databases
             WHERE state = 0
               AND HAS_DBACCESS(name) = 1
               AND name NOT IN ('master', 'tempdb', 'model', 'msdb')
             ORDER BY name;`
        );
        return result.recordset.map((row) => row.name);
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
     * Prefixes tables that live only in another loaded database.
     * MySQL EXPLAIN and live queries otherwise look in the default database.
     */
    public qualifyCrossDatabaseTables(sql: string): string {
        if (this.schemaCache.isEmpty || sql.trim().length === 0) {
            return sql;
        }
        const config = this.getConfig();
        const tokens = tokenizeSql(sql);
        const { refs } = collectTableRefs(sql, tokens);
        if (refs.length === 0) {
            return sql;
        }
        return qualifyCrossDatabaseSql(
            sql,
            refs,
            (reference) =>
                this.schemaCache.findTable(
                    reference,
                    config.database,
                    defaultSchemaForEngine(config.engine) ?? 'dbo'
                ),
            config.engine,
            config.database,
            collectCteNames(tokens)
        );
    }

    /**
     * Dry-runs a query without changing data.
     * - SQL Server: SET NOEXEC ON
     * - MySQL / PostgreSQL: EXPLAIN on SELECT/DML only (CREATE/DROP/ALTER are skipped)
     */
    public async dryRun(sql: string): Promise<DryRunResult> {
        const config = this.getConfig();
        if (!config.enabled) {
            return { kind: 'unavailable', reason: 'The extension is disabled.' };
        }
        if (sql.trim().length === 0) {
            return { kind: 'ok' };
        }

        const qualified = this.qualifyCrossDatabaseTables(sql);
        if (config.engine === 'mysql') {
            return this.dryRunMysql(qualified);
        }
        if (config.engine === 'postgres') {
            return this.dryRunPostgres(qualified);
        }
        return this.dryRunMssql(qualified);
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
        const plan = statementsForExplainDryRun(sql, 'mysql');
        if (plan.kind === 'empty') {
            return { kind: 'ok' };
        }
        if (plan.kind === 'skipped') {
            return { kind: 'skipped', reason: plan.reason };
        }

        const ok = await this.ensureConnected();
        if (!ok || !this.mysqlPool) {
            return {
                kind: 'unavailable',
                reason: this.lastError ?? 'No database connection is available.'
            };
        }

        try {
            // EXPLAIN plans SELECT/DML without applying side effects.
            // CREATE/DROP/ALTER are filtered out first — wrapping them is invalid.
            const timeout = this.getConfig().connectionTimeout;
            for (const statement of plan.statements) {
                await this.runWithReconnect(() =>
                    this.mysqlPool!.query({ sql: `EXPLAIN ${statement}`, timeout })
                );
            }
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

    private async dryRunPostgres(sql: string): Promise<DryRunResult> {
        const plan = statementsForExplainDryRun(sql, 'postgres');
        if (plan.kind === 'empty') {
            return { kind: 'ok' };
        }
        if (plan.kind === 'skipped') {
            return { kind: 'skipped', reason: plan.reason };
        }

        const ok = await this.ensureConnected();
        if (!ok || !this.pgPool) {
            return {
                kind: 'unavailable',
                reason: this.lastError ?? 'No database connection is available.'
            };
        }

        try {
            for (const statement of plan.statements) {
                await this.runWithReconnect(() => this.pgPool!.query(`EXPLAIN ${statement}`));
            }
            return { kind: 'ok' };
        } catch (error) {
            const message = errorText(error);
            if (isTransientConnectionError(message, errorErrno(error))) {
                this.setState('error', message);
                return { kind: 'unavailable', reason: message };
            }
            return {
                kind: 'errors',
                errors: [
                    {
                        number: errorErrno(error),
                        message,
                        lineNumber: 1
                    }
                ]
            };
        }
    }

    /**
     * Runs SQL for real and returns a display-ready result set.
     * `{name}` placeholders are pasted from params first. `:name` binds are
     * rewritten for the engine; those values are never pasted into SQL.
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
        const includeRaw = page?.raw === true;
        const started = Date.now();
        const fail = (error: string, executedSql = sql): QueryResult => ({
            ok: false,
            sql,
            executedSql,
            params,
            columns: [],
            rows: [],
            rawRows: includeRaw ? [] : undefined,
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
        const signal = page?.signal;
        if (signal?.aborted) {
            return fail('Cancelled.');
        }
        const filledSql = applyPlaceholders(sql, params);
        const executableSql = this.qualifyCrossDatabaseTables(filledSql);
        const run = (text: string) => {
            if (config.engine === 'mysql') {
                return this.executeMysql(text, params, fetchLimit, started, includeRaw, signal);
            }
            if (config.engine === 'postgres') {
                return this.executePostgres(text, params, fetchLimit, started, includeRaw, signal);
            }
            return this.executeMssql(text, params, fetchLimit, started, includeRaw, signal);
        };

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
                rows: hasMore ? result.rows.slice(0, pageSize) : result.rows,
                rawRows:
                    result.rawRows && hasMore
                        ? result.rawRows.slice(0, pageSize)
                        : result.rawRows
            };
        };

        if (!canPageSelect(executableSql)) {
            return stamp(await run(executableSql), false);
        }

        const wrapped = buildPagedSelect(executableSql, config.engine, offset, fetchLimit, sort);
        const pagedResult = await run(wrapped);
        if (pagedResult.ok) {
            return stamp(pagedResult, true);
        }

        // Do not run the unbounded original SELECT. That can pull the whole
        // table into memory and freeze the editor.
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
        started: number,
        includeRaw = false,
        signal?: AbortSignal
    ): Promise<QueryResult> {
        const rewritten = rewriteNamedBinds(sql, 'at');
        const fail = (error: string): QueryResult => ({
            ok: false,
            sql,
            executedSql: rewritten.sql,
            params,
            columns: [],
            rows: [],
            rawRows: includeRaw ? [] : undefined,
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
            if (signal?.aborted) {
                return fail('Cancelled.');
            }
            const fetched = await this.runWithReconnect(() =>
                this.queryMssqlLimited(rewritten.sql, rewritten.namesInOrder, params, maxRows, signal)
            );
            const columns = fetched.columns;
            const rawPackets = fetched.rows;
            const truncated = rawPackets.length > maxRows;
            const sliced = truncated ? rawPackets.slice(0, maxRows) : rawPackets;
            const rows = sliced.map((row) => columns.map((column) => formatQueryCell(row[column])));
            const rawRows = includeRaw
                ? sliced.map((row) => columns.map((column) => jsonQueryCell(row[column])))
                : undefined;
            const rowsAffected = fetched.rowsAffected;
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
                rawRows,
                rowsAffected,
                elapsedMs: Date.now() - started,
                truncated,
                maxRows,
                pageOffset: 0,
                paged: false
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isQueryCancelled(error, signal)) {
                this.output.appendLine('[query] mssql cancelled');
                return fail('Cancelled.');
            }
            this.output.appendLine(`[query] mssql failed: ${message}`);
            return fail(message);
        }
    }

    /**
     * Streams rows and stops after maxRows so a missing LIMIT cannot fill memory.
     */
    private queryMssqlLimited(
        sql: string,
        namesInOrder: string[],
        params: Record<string, string | null>,
        maxRows: number,
        signal?: AbortSignal
    ): Promise<{
        columns: string[];
        rows: Record<string, unknown>[];
        rowsAffected: number | undefined;
    }> {
        if (!this.mssqlPool) {
            return Promise.reject(new Error('No database connection is available.'));
        }
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new Error('Cancelled.'));
                return;
            }
            const request = this.mssqlPool!.request();
            const bound = new Set<string>();
            for (const name of namesInOrder) {
                const key = name.toLowerCase();
                if (bound.has(key)) {
                    continue;
                }
                bound.add(key);
                request.input(name, mssql.NVarChar, lookupParam(params, name));
            }
            request.stream = true;

            const packets: Record<string, unknown>[] = [];
            let columns: string[] = [];
            let stopped = false;
            let settled = false;

            const finish = (fn: () => void): void => {
                if (settled) {
                    return;
                }
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                fn();
            };

            const stop = (): void => {
                if (stopped) {
                    return;
                }
                stopped = true;
                try {
                    request.pause();
                    request.cancel();
                } catch {
                    // Cancel can throw if the request already finished.
                }
            };

            const onAbort = (): void => {
                stop();
                finish(() => reject(new Error('Cancelled.')));
            };
            signal?.addEventListener('abort', onAbort, { once: true });

            request.on('recordset', (cols: Record<string, unknown>) => {
                if (cols && typeof cols === 'object') {
                    columns = Object.keys(cols);
                }
            });
            request.on('row', (row: Record<string, unknown>) => {
                if (stopped || settled) {
                    return;
                }
                packets.push(row);
                if (packets.length >= maxRows) {
                    finish(() =>
                        resolve({
                            columns: columns.length > 0 ? columns : Object.keys(row),
                            rows: packets,
                            rowsAffected: undefined
                        })
                    );
                    stop();
                }
            });
            request.on('error', (err: Error) => {
                if (stopped && isCancelError(err)) {
                    finish(() =>
                        resolve({
                            columns,
                            rows: packets,
                            rowsAffected: undefined
                        })
                    );
                    return;
                }
                finish(() => reject(err));
            });
            request.on('done', (result: { rowsAffected?: number | number[] } | undefined) => {
                const affected = Array.isArray(result?.rowsAffected)
                    ? sumRowsAffected(result.rowsAffected)
                    : result?.rowsAffected;
                finish(() =>
                    resolve({
                        columns:
                            columns.length > 0
                                ? columns
                                : packets[0]
                                  ? Object.keys(packets[0])
                                  : [],
                        rows: packets,
                        rowsAffected: affected
                    })
                );
            });
            void request.query(sql);
        });
    }

    private async executeMysql(
        sql: string,
        params: Record<string, string | null>,
        maxRows: number,
        started: number,
        includeRaw = false,
        signal?: AbortSignal
    ): Promise<QueryResult> {
        const rewritten = rewriteNamedBinds(sql, 'qmark');
        const fail = (error: string): QueryResult => ({
            ok: false,
            sql,
            executedSql: rewritten.sql,
            params,
            columns: [],
            rows: [],
            rawRows: includeRaw ? [] : undefined,
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
            if (signal?.aborted) {
                return fail('Cancelled.');
            }
            const values = rewritten.namesInOrder.map((name) => lookupParam(params, name));
            const timeout = this.getConfig().connectionTimeout;
            const [raw, fields] = await this.runWithReconnect(() =>
                this.mysqlPool!.query({ sql: rewritten.sql, timeout, values })
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
                    rawRows: includeRaw ? [] : undefined,
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
            const rawRows = includeRaw
                ? sliced.map((row) =>
                      columns.map((column) =>
                          jsonQueryCell((row as mysql.RowDataPacket)[column])
                      )
                  )
                : undefined;
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
                rawRows,
                rowsAffected: undefined,
                elapsedMs: Date.now() - started,
                truncated,
                maxRows,
                pageOffset: 0,
                paged: false
            };
        } catch (error) {
            const err = error as { sqlMessage?: string; message?: string };
            if (isQueryCancelled(error, signal)) {
                this.output.appendLine('[query] mysql cancelled');
                return fail('Cancelled.');
            }
            const message = err.sqlMessage || err.message || String(error);
            this.output.appendLine(`[query] mysql failed: ${message}`);
            return fail(message);
        }
    }

    private async executePostgres(
        sql: string,
        params: Record<string, string | null>,
        maxRows: number,
        started: number,
        includeRaw = false,
        signal?: AbortSignal
    ): Promise<QueryResult> {
        const rewritten = rewriteNamedBinds(sql, 'dollar');
        const fail = (error: string): QueryResult => ({
            ok: false,
            sql,
            executedSql: rewritten.sql,
            params,
            columns: [],
            rows: [],
            rawRows: includeRaw ? [] : undefined,
            rowsAffected: undefined,
            elapsedMs: Date.now() - started,
            truncated: false,
            maxRows,
            pageOffset: 0,
            paged: false,
            error
        });
        if (!this.pgPool) {
            return fail(this.lastError ?? 'No database connection is available.');
        }
        try {
            if (signal?.aborted) {
                return fail('Cancelled.');
            }
            const values = rewritten.namesInOrder.map((name) => lookupParam(params, name));
            const result = await this.runWithReconnect(() =>
                this.pgPool!.query(rewritten.sql, values)
            );
            const columns = (result.fields ?? []).map((field) => field.name);
            if (columns.length === 0) {
                this.output.appendLine(
                    `[query] postgres ${result.rowCount ?? 0} row(s) affected in ${Date.now() - started}ms`
                );
                return {
                    ok: true,
                    sql,
                    executedSql: rewritten.sql,
                    params,
                    columns: [],
                    rows: [],
                    rawRows: includeRaw ? [] : undefined,
                    rowsAffected: result.rowCount ?? undefined,
                    elapsedMs: Date.now() - started,
                    truncated: false,
                    maxRows,
                    pageOffset: 0,
                    paged: false
                };
            }
            const truncated = result.rows.length > maxRows;
            const sliced = truncated ? result.rows.slice(0, maxRows) : result.rows;
            const rows = sliced.map((row) =>
                columns.map((column) => formatQueryCell(row[column]))
            );
            const rawRows = includeRaw
                ? sliced.map((row) => columns.map((column) => jsonQueryCell(row[column])))
                : undefined;
            this.output.appendLine(
                `[query] postgres ${rows.length} row(s) in ${Date.now() - started}ms`
            );
            return {
                ok: true,
                sql,
                executedSql: rewritten.sql,
                params,
                columns,
                rows,
                rawRows,
                rowsAffected: result.rowCount ?? undefined,
                elapsedMs: Date.now() - started,
                truncated,
                maxRows,
                pageOffset: 0,
                paged: false
            };
        } catch (error) {
            const message = errorText(error);
            if (isQueryCancelled(error, signal)) {
                this.output.appendLine('[query] postgres cancelled');
                return fail('Cancelled.');
            }
            this.output.appendLine(`[query] postgres failed: ${message}`);
            return fail(message);
        }
    }

    /**
     * Returns a query plan without running the statement.
     * MySQL: EXPLAIN (prefers FORMAT=JSON).
     * PostgreSQL: EXPLAIN (FORMAT JSON).
     * SQL Server: SET SHOWPLAN_ALL on a dedicated 1-connection pool so the
     * SET cannot leak onto a different pooled connection (which would execute
     * the query for real).
     */
    public async explainQuery(
        sql: string,
        params: Record<string, string | null> = {}
    ): Promise<ExplainResult> {
        const config = this.getConfig();
        const started = Date.now();
        const fail = (error: string, executedSql = sql): ExplainResult => ({
            ok: false,
            sql,
            executedSql,
            engine: config.engine,
            columns: [],
            rows: [],
            elapsedMs: Date.now() - started,
            error
        });

        if (!config.enabled) {
            return fail('The extension is disabled.');
        }
        if (sql.trim().length === 0) {
            return fail('No SQL to explain.');
        }

        const filledSql = applyPlaceholders(sql, params);
        const qualified = this.qualifyCrossDatabaseTables(filledSql);
        let explained: ExplainResult;
        if (config.engine === 'mysql') {
            explained = await this.explainMysql(qualified, params, started);
        } else if (config.engine === 'postgres') {
            explained = await this.explainPostgres(qualified, params, started);
        } else {
            explained = await this.explainMssql(qualified, params, started);
        }
        return { ...explained, sql };
    }

    private async explainMysql(
        sql: string,
        params: Record<string, string | null>,
        started: number
    ): Promise<ExplainResult> {
        const config = this.getConfig();
        const ok = await this.ensureConnected();
        if (!ok || !this.mysqlPool) {
            return {
                ok: false,
                sql,
                executedSql: sql,
                engine: 'mysql',
                columns: [],
                rows: [],
                elapsedMs: Date.now() - started,
                error: this.lastError ?? 'No database connection is available.'
            };
        }

        const rewritten = rewriteNamedBinds(sql, 'qmark');
        const values = rewritten.namesInOrder.map((name) => lookupParam(params, name));
        const timeout = config.connectionTimeout;
        const jsonSql = `EXPLAIN FORMAT=JSON ${rewritten.sql}`;
        const textSql = `EXPLAIN ${rewritten.sql}`;

        const runExplain = async (
            statement: string
        ): Promise<{ columns: string[]; rows: unknown[][] }> => {
            const [raw, fields] = await this.runWithReconnect(() =>
                this.mysqlPool!.query({ sql: statement, values, timeout })
            );
            const rowPackets = firstMysqlRowset(raw);
            const columns = mysqlColumns(rowPackets, fields);
            const rows = rowPackets.map((row) =>
                columns.map((column) => {
                    const cell = jsonQueryCell((row as mysql.RowDataPacket)[column]);
                    if (typeof cell === 'string' && cell.trim().startsWith('{')) {
                        try {
                            return JSON.parse(cell) as unknown;
                        } catch {
                            return cell;
                        }
                    }
                    return cell;
                })
            );
            return { columns, rows };
        };

        try {
            const planned = await runExplain(jsonSql);
            this.output.appendLine(
                `[explain] mysql FORMAT=JSON ${planned.rows.length} row(s) in ${Date.now() - started}ms`
            );
            return {
                ok: true,
                sql,
                executedSql: jsonSql,
                engine: 'mysql',
                columns: planned.columns,
                rows: planned.rows,
                elapsedMs: Date.now() - started
            };
        } catch (jsonError) {
            const jsonMessage = errorText(jsonError);
            this.output.appendLine(
                `[explain] mysql FORMAT=JSON failed, falling back: ${jsonMessage}`
            );
            try {
                const planned = await runExplain(textSql);
                this.output.appendLine(
                    `[explain] mysql ${planned.rows.length} row(s) in ${Date.now() - started}ms`
                );
                return {
                    ok: true,
                    sql,
                    executedSql: textSql,
                    engine: 'mysql',
                    columns: planned.columns,
                    rows: planned.rows,
                    elapsedMs: Date.now() - started,
                    note: 'FORMAT=JSON is not supported; returned classic EXPLAIN.'
                };
            } catch (error) {
                const message = errorText(error);
                this.output.appendLine(`[explain] mysql failed: ${message}`);
                return {
                    ok: false,
                    sql,
                    executedSql: textSql,
                    engine: 'mysql',
                    columns: [],
                    rows: [],
                    elapsedMs: Date.now() - started,
                    error: message
                };
            }
        }
    }

    private async explainPostgres(
        sql: string,
        params: Record<string, string | null>,
        started: number
    ): Promise<ExplainResult> {
        const ok = await this.ensureConnected();
        if (!ok || !this.pgPool) {
            return {
                ok: false,
                sql,
                executedSql: sql,
                engine: 'postgres',
                columns: [],
                rows: [],
                elapsedMs: Date.now() - started,
                error: this.lastError ?? 'No database connection is available.'
            };
        }

        const rewritten = rewriteNamedBinds(sql, 'dollar');
        const values = rewritten.namesInOrder.map((name) => lookupParam(params, name));
        const jsonSql = `EXPLAIN (FORMAT JSON) ${rewritten.sql}`;

        try {
            const result = await this.runWithReconnect(() =>
                this.pgPool!.query(jsonSql, values)
            );
            const columns = (result.fields ?? []).map((field) => field.name);
            const rows = result.rows.map((row) =>
                columns.map((column) => {
                    const cell = jsonQueryCell(row[column]);
                    if (typeof cell === 'string' && cell.trim().startsWith('[')) {
                        try {
                            return JSON.parse(cell) as unknown;
                        } catch {
                            return cell;
                        }
                    }
                    return cell;
                })
            );
            this.output.appendLine(
                `[explain] postgres FORMAT JSON ${rows.length} row(s) in ${Date.now() - started}ms`
            );
            return {
                ok: true,
                sql,
                executedSql: jsonSql,
                engine: 'postgres',
                columns,
                rows,
                elapsedMs: Date.now() - started
            };
        } catch (error) {
            const message = errorText(error);
            this.output.appendLine(`[explain] postgres failed: ${message}`);
            return {
                ok: false,
                sql,
                executedSql: jsonSql,
                engine: 'postgres',
                columns: [],
                rows: [],
                elapsedMs: Date.now() - started,
                error: message
            };
        }
    }

    private async explainMssql(
        sql: string,
        params: Record<string, string | null>,
        started: number
    ): Promise<ExplainResult> {
        const config = this.getConfig();
        if (/^[ \t]*GO[ \t]*(--.*)?$/im.test(sql)) {
            return {
                ok: false,
                sql,
                executedSql: sql,
                engine: 'mssql',
                columns: [],
                rows: [],
                elapsedMs: Date.now() - started,
                error: 'The query contains a GO batch separator, which cannot be explained as one batch.'
            };
        }

        const rewritten = rewriteNamedBinds(sql, 'at');
        const password = await this.resolvePassword(config);
        const poolConfig = this.buildMssqlConfig(config, password);
        poolConfig.pool = {
            max: 1,
            min: 0,
            idleTimeoutMillis: 1000
        };

        let pool: mssql.ConnectionPool | undefined;
        try {
            pool = new mssql.ConnectionPool(poolConfig);
            await pool.connect();
            // SET SHOWPLAN_ALL must be the only statement in its batch, and it
            // is connection-scoped. A 1-connection pool keeps the SET and the
            // query on the same session so the query is not executed.
            await pool.request().batch('SET SHOWPLAN_ALL ON');
            const result = await (() => {
                const request = pool!.request();
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
            })();
            const recordset = firstMssqlRecordset(result);
            const columns = mssqlColumns(recordset);
            const packets = recordset ?? [];
            const rows = packets.map((row) =>
                columns.map((column) => jsonQueryCell(row[column]))
            );
            this.output.appendLine(
                `[explain] mssql SHOWPLAN_ALL ${rows.length} row(s) in ${Date.now() - started}ms`
            );
            return {
                ok: true,
                sql,
                executedSql: rewritten.sql,
                engine: 'mssql',
                columns,
                rows,
                elapsedMs: Date.now() - started
            };
        } catch (error) {
            const message = errorText(error);
            this.output.appendLine(`[explain] mssql failed: ${message}`);
            return {
                ok: false,
                sql,
                executedSql: rewritten.sql,
                engine: 'mssql',
                columns: [],
                rows: [],
                elapsedMs: Date.now() - started,
                error: /showplan/i.test(message)
                    ? `${message} The login needs SHOWPLAN permission.`
                    : message
            };
        } finally {
            if (pool) {
                try {
                    await pool.close();
                } catch {
                    // Closing a plan-only pool is best effort.
                }
            }
        }
    }

    private async disposePool(): Promise<void> {
        const mssqlPool = this.mssqlPool;
        const mysqlPool = this.mysqlPool;
        const pgPool = this.pgPool;
        this.mssqlPool = undefined;
        this.mysqlPool = undefined;
        this.pgPool = undefined;
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
        if (pgPool) {
            try {
                await pgPool.end();
            } catch {
                // Closing a broken pool is best effort.
            }
        }
    }

    /**
     * Rebuilds the connection after a settings change and reloads metadata.
     */
    public async reconfigure(): Promise<void> {
        this.cachedConfig = undefined;
        await this.disposePool();
        this.setState('disconnected');
        this.schemaCache = SchemaCache.empty();
        const config = this.getConfig();
        if (!config.enabled) {
            this.liveSchemaRequested = false;
            this.setState('disabled');
            this.stopRefreshTimer();
            this.schemaEmitter.fire(this.schemaCache);
            return;
        }
        await this.loadDiskCache();
        this.schemaEmitter.fire(this.schemaCache);
        this.liveSchemaRequested = true;
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

function jsonQueryCell(value: unknown): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
        return value.length === 0 ? '[binary]' : `[binary ${value.length} bytes]`;
    }
    if (typeof value === 'object') {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return String(value);
        }
    }
    return String(value);
}

const MAX_QUERY_CELL_CHARS = 4000;

function formatQueryCell(value: unknown): string {
    const text = formatQueryCellRaw(value);
    if (text.length <= MAX_QUERY_CELL_CHARS) {
        return text;
    }
    return `${text.slice(0, MAX_QUERY_CELL_CHARS)}…`;
}

function formatQueryCellRaw(value: unknown): string {
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

function isCancelError(error: unknown): boolean {
    const err = error as { code?: string; name?: string; message?: string };
    const code = String(err.code ?? '').toUpperCase();
    if (code === 'ECANCEL' || code === 'ABORT_ERR' || err.name === 'AbortError') {
        return true;
    }
    const message = errorText(error).toLowerCase();
    return (
        message.includes('canceled') ||
        message.includes('cancelled') ||
        message.includes('aborted')
    );
}

function isQueryCancelled(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true || isCancelError(error);
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
                'If you use PostgreSQL, set Engine to PostgreSQL (port 5432). ' +
                'For local SQL Server: enable Trust server certificate, or turn Encrypt off.'
            );
        }
        if (config.engine === 'postgres') {
            return 'PostgreSQL handshake failed. Check host, port 5432, user/password, database name, and TLS settings.';
        }
        return 'MySQL handshake failed. Check host, port 3306, user/password, and TLS settings.';
    }
    if (
        lower.includes('login failed') ||
        lower.includes('access denied') ||
        lower.includes('password authentication failed')
    ) {
        return 'Username or password is wrong, or the login cannot access this database.';
    }
    if (lower.includes('getaddrinfo') || lower.includes('enotfound')) {
        return 'Server host name could not be resolved. Check the Server field.';
    }
    if (lower.includes('etimeout') || lower.includes('timeout')) {
        if (config.loginKind === 'supabase') {
            return 'Timed out. If you used the direct db.… host, paste the Session pooler URL instead.';
        }
        return 'Timed out. Check VPN/firewall, port, and that the database server is running.';
    }
    if (lower.includes('certificate') || lower.includes('self signed')) {
        return 'Enable "Trust server certificate" on the login page for local/self-signed TLS.';
    }
    return 'Open BiSql: Open Connection / Login and verify engine, server, and port.';
}
