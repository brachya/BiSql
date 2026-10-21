import * as crypto from 'crypto';
import { Emitter } from './emitter';
import { ServicePorts, SettingsTarget } from './ports';
import * as mssql from 'mssql';
import * as mysql from 'mysql2/promise';
import * as pg from 'pg';
import {
    collectCteNames,
    collectTableRefs,
    statementsForExplainDryRun,
    tokenizeSql
} from '../parser/sqlExtractor';
import { newlinesBefore, queryLineFromEngineError, shiftEngineLineRefs } from '../sql/errorLines';
import {
    clampExpressionWidth,
    clampLinesBetweenQueries,
    parseCaseChoice,
    parseKeywordCase,
    parseLogicalNewline
} from '../sql/formatEmbeddedSql';
import {
    QUERY_HISTORY_STATE,
    QueryHistoryEntry,
    normalizeQueryHistory,
    rememberQuery
} from '../sql/queryHistory';
import { applyPlaceholders, lookupParam, rewriteNamedBinds } from '../sql/parameters';
import { qualifyCrossDatabaseSql } from '../sql/qualifyTables';
import {
    buildPagedSelect,
    canPageSelect,
    clampOffset,
    clampPageSize,
    QueryPageOptions
} from '../sql/resultPage';
import {
    BIGQUERY_EXPLAIN_NOTE,
    BigqueryHandle,
    createBigqueryHandle,
    dryRunBigquery,
    explainRowsFromDryRun,
    formatBigqueryAuthError,
    listAccessibleProjects,
    listBigqueryDatasets,
    peekCachedAccessibleProjects,
    loadBigquerySchema,
    parseBigqueryDatasetRef,
    parseScanBytes,
    pingBigquery,
    retargetBigqueryHome,
    runBigqueryQuery
} from './bigquery';
import {
    BIGQUERY_DATASET_WARN,
    ProjectCacheMeta,
    datasetCacheKey,
    datasetsForProjects,
    effectiveCachedProjects,
    mergeSchemaTables,
    removeDatasetsForProject
} from './bigqueryCache';
import {
    CACHE_VERSION,
    CONFIG_SECTION,
    CONNECTION_SETTING_KEYS,
    ExtensionConfig,
    LEGACY_CONFIG_SECTION,
    LEGACY_SCOPE_STATE_KEY,
    SCOPE_STATE_KEY,
    SECRET_KEY_GLOBAL,
    SECRET_KEY_LEGACY,
    SettingsScope,
    catalogDatabaseForEngine,
    normalizeDatabaseList,
    selectedDatabases,
    tableLookupDefaults
} from './config';
import {
    ConnectionProfile,
    FlatLogin,
    emptyProfile,
    migrateFromFlat,
    newConnectionId,
    normalizeProfiles,
    profileFromFlat,
    defaultConnectionName
} from './connectionProfiles';
import {
    DbEngine,
    LoginKind,
    defaultPortForEngine,
    engineForLoginKind,
    parseEngine,
    parseLoginKind
} from './engines';
import {
    buildMssqlConfig,
    collectRequestErrors,
    firstMssqlRecordset,
    mssqlColumnQueryForDatabase,
    mssqlColumns,
    mssqlForeignKeyQueryForDatabase,
    mssqlPrimaryKeyQueryForDatabase,
    renderType,
    sumRowsAffected
} from './mssqlOps';
import {
    buildMysqlPool,
    firstMysqlRowset,
    isMysqlResultSetHeader,
    mysqlColumns,
    mysqlForeignKeyQuery,
    mysqlSchemaQuery
} from './mysqlOps';
import {
    POSTGRES_COLUMN_QUERY,
    POSTGRES_FOREIGN_KEY_QUERY,
    POSTGRES_KEY_QUERY,
    buildPostgresPool
} from './postgresOps';
import {
    ConnectionState,
    DryRunError,
    DryRunResult,
    ExplainResult,
    QueryResult,
    errorErrno,
    errorText,
    formatQueryCell,
    hintForConnectError,
    isCancelError,
    isMysqlViewExplainPrivilegeError,
    isQueryCancelled,
    isTransientConnectionError,
    jsonQueryCell,
    namedAtBinds
} from './queryCells';
import {
    CatalogFile,
    ExplorerProfileCache,
    catalogFileName,
    mergeCatalogPatch,
    mergeExplorerCache,
    parseCatalogJson,
    uniqueNames
} from './explorerCatalog';
import {
    RawColumnRow,
    RawForeignKeyRow,
    RawKeyRow,
    SchemaCache,
    SerializedSnapshot,
    buildQualifiedName,
    foreignKeysFromRawRows
} from './schemaCache';
import { ColumnInfo, TableInfo } from './schemaTypes';

export type SchemaRefreshOutcome = { ok: boolean; updated: boolean };

export class SqlServerService {
    private mssqlPool: mssql.ConnectionPool | undefined;
    private mysqlPool: mysql.Pool | undefined;
    private pgPool: pg.Pool | undefined;
    private bigquery: BigqueryHandle | undefined;
    private connecting: Promise<boolean> | undefined;
    private schemaCache = SchemaCache.empty();
    private state: ConnectionState = 'disconnected';
    private lastError: string | undefined;
    private lastHealthyAt = 0;
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshInFlight: Promise<boolean> | undefined;
    /** reconfigure sets this so a second refresh waits instead of running beside the rebuild. */
    private refreshPaused = false;
    /** Set when a refresh writes the cache even if the overall result is false. */
    public lastRefreshUpdatedCache = false;
    /** Later reconfigure() calls wait for the one already running. */
    private reconfigureTail: Promise<void> = Promise.resolve();
    /** In-flight schema snapshot write. reconfigure waits so it does not load a stale file. */
    private schemaWrite: Promise<void> = Promise.resolve();
    private bigqueryProjectMetaKey = '';
    private readonly refreshWaiters: Array<{
        options?: { projects?: string[] };
        resolve: (result: SchemaRefreshOutcome) => void;
    }> = [];
    /** Per-project fetch time for the active login. Catalog on disk can lag one refresh. */
    private bigqueryProjectMeta: Record<string, ProjectCacheMeta> = {};
    private liveSchemaRequested = false;
    /** Bumped on reconfigure so an in-flight refresh cannot overwrite the new login's schema. */
    private schemaEpoch = 0;
    private cachedConfig: ExtensionConfig | undefined;
    private readonly catalogMemo = new Map<string, CatalogFile>();
    private readonly diskSchemaMemo = new Map<string, SchemaCache>();

    private readonly stateEmitter = new Emitter<ConnectionState>();
    private readonly schemaEmitter = new Emitter<SchemaCache>();

    public readonly onDidChangeState = this.stateEmitter.event;
    public readonly onDidChangeSchema = this.schemaEmitter.event;

    constructor(private readonly ports: ServicePorts) {}

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

    public listQueryHistory(): QueryHistoryEntry[] {
        const limit = this.getConfig().queryHistorySize;
        if (limit <= 0) {
            return [];
        }
        return normalizeQueryHistory(this.ports.state.get(QUERY_HISTORY_STATE)).slice(0, limit);
    }

    /** Drop stored queries when history is turned off. */
    public async enforceQueryHistoryLimit(): Promise<void> {
        if (this.getConfig().queryHistorySize > 0) {
            return;
        }
        const current = this.ports.state.get(QUERY_HISTORY_STATE);
        if (!Array.isArray(current) || current.length === 0) {
            return;
        }
        await this.ports.state.update(QUERY_HISTORY_STATE, []);
    }

    public async rememberQuery(sql: string): Promise<void> {
        const config = this.getConfig();
        if (config.queryHistorySize <= 0) {
            await this.enforceQueryHistoryLimit();
            return;
        }
        const current = normalizeQueryHistory(this.ports.state.get(QUERY_HISTORY_STATE));
        const next = rememberQuery(
            current,
            { sql, at: Date.now(), connectionId: config.connectionId },
            config.queryHistorySize
        );
        if (next === current) {
            return;
        }
        await this.ports.state.update(QUERY_HISTORY_STATE, next);
    }

    public async clearQueryHistory(): Promise<void> {
        await this.ports.state.update(QUERY_HISTORY_STATE, []);
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
                cachedProjects: [],
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
            await this.writeActiveConnectionId(result.activeId, 'global');
        }
        this.invalidateConfigCache();

        const written = this.readProfiles();
        if (written.length === 0) {
            this.ports.log.appendLine('[migrate] write failed; keeping the old single login');
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
        this.ports.log.appendLine(
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
        | 'cachedProjects'
        | 'user'
        | 'port'
        | 'encrypt'
        | 'trustServerCertificate'
    > {
        const pick = <T>(key: string, fallback: T): T => this.pickSetting(key, fallback, mode);
        return {
            enabled: pick<boolean>('enabled', true),
            hosts: {
                python: pick<boolean>('hosts.python', true),
                javascript: pick<boolean>('hosts.javascript', true),
                sqlFiles: pick<boolean>('hosts.sqlFiles', true)
            },
            passwordSetting: String(pick<string>('password', '')),
            connectionTimeout: pick<number>('connectionTimeout', 15000),
            schemaRefreshMinutes: pick<number>('schemaRefreshMinutes', 30),
            validateOnType: pick<boolean>('validateOnType', true),
            dryRunOnSave: pick<boolean>('dryRunOnSave', true),
            promptQuickSuggestions: pick<boolean>('promptQuickSuggestions', true),
            cacheSchemaToDisk: pick<boolean>('cacheSchemaToDisk', true),
            queryMaxRows: Math.max(1, pick<number>('queryMaxRows', 1000)),
            formatKeywordCase: parseKeywordCase(pick<string>('formatKeywordCase', 'upper')),
            formatFunctionCase: parseCaseChoice(pick<string>('formatFunctionCase', 'keyword')),
            formatDataTypeCase: parseCaseChoice(pick<string>('formatDataTypeCase', 'keyword')),
            formatTabWidth: Math.max(1, Math.min(8, pick<number>('formatTabWidth', 4))),
            formatUseTabs: pick<boolean>('formatUseTabs', false),
            formatLogicalOperatorNewline: parseLogicalNewline(
                pick<string>('formatLogicalOperatorNewline', 'before')
            ),
            formatExpressionWidth: clampExpressionWidth(pick<number>('formatExpressionWidth', 50)),
            formatLinesBetweenQueries: clampLinesBetweenQueries(
                pick<number>('formatLinesBetweenQueries', 1)
            ),
            formatDenseOperators: pick<boolean>('formatDenseOperators', false),
            formatNewlineBeforeSemicolon: pick<boolean>('formatNewlineBeforeSemicolon', false),
            queryHistorySize: Math.max(0, Math.min(500, pick<number>('queryHistorySize', 100))),
            mcpEnabled: pick<boolean>('mcpEnabled', true),
            mcpAllowMutating: pick<boolean>('mcpAllowMutating', false),
            mcpMaxResultRows: Math.max(1, Math.min(1000, pick<number>('mcpMaxResultRows', 50))),
            bigqueryConfirmScanMb: Math.max(0, pick<number>('bigqueryConfirmScanMb', 1024))
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
            cachedProjects: profile.cachedProjects,
            user: profile.user,
            port: profile.port,
            encrypt: profile.encrypt,
            trustServerCertificate: profile.trustServerCertificate
        };
    }

    private readProfiles(): ConnectionProfile[] {
        const inspected = this.ports.settings.inspect<unknown>(CONFIG_SECTION, 'connections');
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
        const inspected = this.ports.settings.inspect<string>(
            CONFIG_SECTION,
            'activeConnectionId'
        );
        const value =
            layer === 'workspace'
                ? (inspected?.workspaceFolderValue ?? inspected?.workspaceValue)
                : inspected?.globalValue;
        const id = typeof value === 'string' ? value.trim() : '';
        return id || undefined;
    }

    private async writeProfiles(profiles: ConnectionProfile[]): Promise<void> {
        await this.ports.settings.update(CONFIG_SECTION, 'connections', profiles, 'global');
        this.invalidateConfigCache();
    }

    private async writeActiveConnectionId(id: string, target: SettingsTarget): Promise<void> {
        await this.ports.settings.update(
            CONFIG_SECTION,
            'activeConnectionId',
            id || undefined,
            target
        );
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
            cachedProjects: normalizeDatabaseList(pick('cachedProjects')),
            user: String(pick('user') ?? '').trim(),
            port: Number(pick('port')) || defaultPortForEngine(engine),
            encrypt: pick('encrypt') !== false,
            trustServerCertificate: Boolean(pick('trustServerCertificate'))
        };
    }

    private inspectLayerValue(key: string, layer: 'global' | 'workspace'): unknown {
        const current = this.ports.settings.inspect(CONFIG_SECTION, key);
        const legacy = this.ports.settings.inspect(LEGACY_CONFIG_SECTION, key);
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
        const current = this.ports.settings.inspect<T>(CONFIG_SECTION, key);
        const legacy = this.ports.settings.inspect<T>(LEGACY_CONFIG_SECTION, key);
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
        return this.ports.settings.hasWorkspaceFolder();
    }

    /**
     * Which scope this project is using. Defaults to shared (global).
     */
    public getSettingsScope(): SettingsScope {
        const stored =
            this.ports.state.get<SettingsScope>(SCOPE_STATE_KEY) ??
            this.ports.state.get<SettingsScope>(LEGACY_SCOPE_STATE_KEY);
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
        await this.ports.state.update(SCOPE_STATE_KEY, scope);
    }

    private hasWorkspaceConnectionOverrides(): boolean {
        for (const sectionName of [CONFIG_SECTION, LEGACY_CONFIG_SECTION]) {
            for (const key of CONNECTION_SETTING_KEYS) {
                if (key === 'password') {
                    continue;
                }
                const inspected = this.ports.settings.inspect(sectionName, key);
                const value = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
                if (value !== undefined) {
                    return true;
                }
            }
        }
        return false;
    }

    private workspaceSecretKey(): string {
        const folder = this.ports.settings.workspaceFolderUri();
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
        await this.ports.secrets.store(this.passwordSecretKey(id), password);
    }

    public async setPassword(password: string, connectionId?: string): Promise<void> {
        const id = connectionId || this.getActiveConnectionId();
        if (id) {
            await this.storePasswordForId(id, password);
            return;
        }
        await this.ports.secrets.store(this.secretKeyForScope(this.getSettingsScope()), password);
    }

    public async clearPassword(connectionId?: string): Promise<void> {
        const id = connectionId || this.getActiveConnectionId();
        if (id) {
            await this.ports.secrets.delete(this.passwordSecretKey(id));
            return;
        }
        const resolved = this.getSettingsScope();
        await this.ports.secrets.delete(this.secretKeyForScope(resolved));
    }

    public async hasStoredPassword(connectionId?: string): Promise<boolean> {
        const value = await this.getPassword(connectionId);
        return value !== undefined && value !== '';
    }

    /** Profile secret first, then the old single-login keys. Never drop those. */
    public async getPassword(connectionId?: string): Promise<string | undefined> {
        const id = connectionId || this.getActiveConnectionId();
        if (id) {
            const stored = await this.ports.secrets.get(this.passwordSecretKey(id));
            if (stored !== undefined && stored !== '') {
                return stored;
            }
        }
        return this.readLegacyPassword(this.getSettingsScope());
    }

    private async readLegacyPassword(scope: SettingsScope): Promise<string | undefined> {
        const primary = await this.ports.secrets.get(this.secretKeyForScope(scope));
        if (primary !== undefined && primary !== '') {
            return primary;
        }
        if (scope === 'global') {
            const legacy = await this.ports.secrets.get(SECRET_KEY_LEGACY);
            if (legacy !== undefined && legacy !== '') {
                return legacy;
            }
        }
        if (scope === 'workspace') {
            const shared = await this.ports.secrets.get(SECRET_KEY_GLOBAL);
            if (shared !== undefined && shared !== '') {
                return shared;
            }
            const legacy = await this.ports.secrets.get(SECRET_KEY_LEGACY);
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
        cachedProjects?: string[];
        user: string;
        port: number;
        encrypt: boolean;
        trustServerCertificate: boolean;
        enabled: boolean;
        pinToWorkspace?: boolean;
        activate?: boolean;
    }): Promise<string> {
        await this.ports.settings.update(CONFIG_SECTION, 'enabled', settings.enabled, 'global');

        const loginKind = parseLoginKind(settings.loginKind, settings.engine, settings.server);
        const engine = engineForLoginKind(loginKind);
        const profile = profileFromFlat(
            {
                loginKind,
                engine,
                server: settings.server,
                database: settings.database,
                databases: settings.databases ?? [],
                cachedProjects: settings.cachedProjects ?? [],
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
        await this.ports.secrets.delete(this.passwordSecretKey(id));
        const active = this.getActiveConnectionId();
        if (active === id || !profiles.some((item) => item.id === active)) {
            await this.setActiveConnectionId(profiles[0]?.id ?? '', this.isActivePinnedToWorkspace());
        }
        await this.reconfigure();
    }

    public async setActiveConnectionId(id: string, pinToWorkspace?: boolean): Promise<void> {
        const pin = pinToWorkspace === true && this.hasWorkspaceFolder();
        if (pin) {
            await this.writeActiveConnectionId(id, 'workspace');
        } else if (this.hasWorkspaceFolder()) {
            await this.writeActiveConnectionId('', 'workspace');
        }
        await this.writeActiveConnectionId(id, 'global');
    }

    public async switchActive(id: string, pinToWorkspace?: boolean): Promise<void> {
        await this.setActiveConnectionId(id, pinToWorkspace);
        await this.reconfigure();
    }

    /** Default-database-aware table lookup used by providers. */
    public findTable(reference: string): TableInfo | undefined {
        const config = this.getConfig();
        const defaults = tableLookupDefaults(config);
        return this.schemaCache.findTable(reference, defaults.database, defaults.schema);
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

    /**
     * Schema + catalog for the sidebar. Live cache only for the active login.
     */
    public async getExplorerCache(profile: ConnectionProfile): Promise<ExplorerProfileCache> {
        const config = this.configForProfile(profile);
        const key = this.connectionKey(config);
        const catalog = await this.readCatalogFile(key);
        const active = profile.id === this.getActiveConnectionId();
        const peekProjects =
            config.engine === 'bigquery' && active ? peekCachedAccessibleProjects() : undefined;
        const projects = catalog?.projects.length ? catalog.projects : (peekProjects ?? []);
        const catalogWithProjects =
            projects.length > 0
                ? mergeCatalogPatch(catalog, key, {
                      databases: catalog?.databases,
                      projects
                  })
                : catalog;
        const catalogForTree = this.catalogWithLiveProjectMeta(key, active, catalogWithProjects);

        if (active && this.schemaCache.tables.length > 0) {
            return mergeExplorerCache({
                tables: this.schemaCache.tables,
                fetchedAt: this.schemaCache.fetchedAt,
                stale: this.schemaCache.stale,
                catalog: catalogForTree,
                cachedProjects: config.cachedProjects,
                homeProject: config.server
            });
        }

        const disk = await this.readDiskSchema(key, config.engine);
        if (!disk && !catalogForTree) {
            return mergeExplorerCache({
                tables: [],
                fetchedAt: 0,
                stale: false,
                cachedProjects: config.cachedProjects,
                homeProject: config.server
            });
        }
        return mergeExplorerCache({
            tables: disk?.tables ?? [],
            fetchedAt: disk?.fetchedAt ?? catalogForTree?.fetchedAt ?? 0,
            stale: true,
            catalog: catalogForTree,
            cachedProjects: config.cachedProjects,
            homeProject: config.server
        });
    }

    public async writeExplorerCatalog(
        patch: {
            databases?: string[];
            projects?: string[];
            projectMeta?: Record<string, { fetchedAt: number; datasets: string[] }>;
        },
        connectionKey?: string
    ): Promise<void> {
        const config = this.getConfig();
        if (!config.cacheSchemaToDisk) {
            return;
        }
        const key = connectionKey || this.connectionKey(config);
        const existing = await this.readCatalogFile(key);
        const next = mergeCatalogPatch(existing, key, patch);
        this.catalogMemo.set(key, next);
        try {
            await this.ports.files.ensureStorageDir();
            await this.ports.files.write(
                this.catalogFileName(key),
                Buffer.from(JSON.stringify(next), 'utf8')
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.ports.log.appendLine(`[schema] could not write the catalog snapshot: ${message}`);
        }
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
        if (config.engine === 'bigquery') {
            return this.bigquery !== undefined;
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
            } else if (config.engine === 'bigquery') {
                await pingBigquery(this.bigquery!);
            } else {
                await this.mssqlPool!.request().query('SELECT 1');
            }
            this.lastHealthyAt = Date.now();
            return true;
        } catch (error) {
            const message = errorText(error);
            this.ports.log.appendLine(`[connect] pool health check failed: ${message}`);
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
            this.ports.log.appendLine(
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
            if (this.state !== 'connected') {
                this.setState('connected');
            }
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
                    const pool = buildMysqlPool(config, password);
                    // Force a real handshake; createPool is lazy.
                    const conn = await pool.getConnection();
                    conn.release();
                    this.mysqlPool = pool;
                } else if (config.engine === 'postgres') {
                    await this.disposePool();
                    const pool = buildPostgresPool(config, password, this.ports.log);
                    const client = await pool.connect();
                    client.release();
                    this.pgPool = pool;
                } else if (config.engine === 'bigquery') {
                    await this.disposePool();
                    const handle = createBigqueryHandle(config.server);
                    await pingBigquery(handle);
                    this.bigquery = handle;
                } else {
                    await this.disposePool();
                    const poolConfig = buildMssqlConfig(config, password);
                    const pool = new mssql.ConnectionPool(poolConfig);
                    pool.on('error', (err: Error) => {
                        this.ports.log.appendLine(`[pool] ${err.message}`);
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
                this.ports.log.appendLine(
                    config.engine === 'bigquery'
                        ? `[connect] bigquery ${config.server}/${config.database}`
                        : `[connect] ${config.engine} ${config.server}:${config.port}/${config.database} as ${config.user || '(empty user)'}`
                );
                return true;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.ports.log.appendLine(`[connect] failed: ${message}`);
                this.ports.log.appendLine(`[connect] hint: ${hintForConnectError(message, config)}`);
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
                message:
                    config.engine === 'bigquery'
                        ? 'Set project and dataset on the login page first.'
                        : 'Set server and database on the login page first.'
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
            if (config.engine === 'bigquery') {
                return { ok: true, message: await pingBigquery(this.bigquery!) };
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
     * BigQuery: pass `projects` to refresh and merge only those GCP projects.
     * A second call waits and then runs with its own project list.
     */
    public refreshSchema(options?: { projects?: string[] }): Promise<boolean> {
        return this.refreshSchemaOutcome(options).then((result) => result.ok);
    }

    /** Same as refreshSchema, plus whether the cache was written. */
    public refreshSchemaOutcome(options?: { projects?: string[] }): Promise<SchemaRefreshOutcome> {
        if (this.refreshInFlight || this.refreshPaused) {
            return new Promise((resolve) => {
                this.refreshWaiters.push({ options, resolve });
            });
        }
        return this.beginRefresh(options);
    }

    private beginRefresh(options?: { projects?: string[] }): Promise<SchemaRefreshOutcome> {
        const refreshEpoch = this.schemaEpoch;
        // Capture `updated` before finally starts the next refresh, which resets the flag.
        const run = this.doRefreshSchema(options, refreshEpoch).then((ok) => ({
            ok,
            updated: ok || this.lastRefreshUpdatedCache
        }));
        const settled = run.finally(() => {
            this.refreshInFlight = undefined;
            this.pumpRefreshQueue();
        });
        this.refreshInFlight = settled.then((result) => result.ok);
        return settled;
    }

    private pumpRefreshQueue(): void {
        if (this.refreshInFlight || this.refreshPaused) {
            return;
        }
        const next = this.refreshWaiters.shift();
        if (!next) {
            return;
        }
        this.beginRefresh(next.options).then(next.resolve, () =>
            next.resolve({ ok: false, updated: false })
        );
    }

    private async doRefreshSchema(
        options?: { projects?: string[] },
        refreshEpoch: number = this.schemaEpoch
    ): Promise<boolean> {
        this.lastRefreshUpdatedCache = false;
        if (refreshEpoch !== this.schemaEpoch) {
            return false;
        }
        const ok = await this.ensureConnected();
        if (!ok || refreshEpoch !== this.schemaEpoch) {
            return false;
        }
        const config = this.getConfig();
        try {
            if (config.engine === 'mysql') {
                return await this.refreshMysqlSchema(config, refreshEpoch);
            }
            if (config.engine === 'postgres') {
                return await this.refreshPostgresSchema(config, refreshEpoch);
            }
            if (config.engine === 'bigquery') {
                return await this.refreshBigquerySchema(config, options?.projects, refreshEpoch);
            }
            return await this.refreshMssqlSchema(config, refreshEpoch);
        } catch (error) {
            if (refreshEpoch !== this.schemaEpoch) {
                return false;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.ports.log.appendLine(`[schema] refresh failed: ${message}`);
            this.setState('error', message);
            return false;
        }
    }

    private dropSchemaRefreshWaiters(): void {
        while (this.refreshWaiters.length > 0) {
            const next = this.refreshWaiters.shift();
            next?.resolve({ ok: false, updated: false });
        }
    }

    private attachForeignKeys(
        tablesByQualified: Map<string, TableInfo>,
        rows: RawForeignKeyRow[],
        engine: DbEngine
    ): void {
        const byTable = foreignKeysFromRawRows(rows, engine);
        for (const table of tablesByQualified.values()) {
            const key = `${table.database.toLowerCase()}.${table.schema.toLowerCase()}.${table.name.toLowerCase()}`;
            table.foreignKeys = byTable.get(key) ?? [];
        }
    }

    private async refreshMssqlSchema(
        config: ExtensionConfig,
        refreshEpoch: number
    ): Promise<boolean> {
        const pool = this.mssqlPool!;
        const databases = selectedDatabases(config);
        const primaryKeys = new Set<string>();
        const foreignKeyRows: RawForeignKeyRow[] = [];
        let foreignKeysLoaded = true;
        const tablesByQualified = new Map<string, TableInfo>();

        for (const database of databases) {
            try {
                const [columnResult, keyResult] = await Promise.all([
                    pool.request().query<RawColumnRow>(mssqlColumnQueryForDatabase(database)),
                    pool.request().query<RawKeyRow>(mssqlPrimaryKeyQueryForDatabase(database))
                ]);
                try {
                    const fkResult = await pool
                        .request()
                        .query<RawForeignKeyRow>(mssqlForeignKeyQueryForDatabase(database));
                    foreignKeyRows.push(...fkResult.recordset);
                } catch (fkError) {
                    const message = fkError instanceof Error ? fkError.message : String(fkError);
                    foreignKeysLoaded = false;
                    this.ports.log.appendLine(
                        `[schema] skipped foreign keys for ${database}: ${message}`
                    );
                }

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
                            columnsByLower: new Map<string, ColumnInfo>(),
                            foreignKeys: []
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
                this.ports.log.appendLine(
                    `[schema] skipped database ${database}: ${message}`
                );
            }
        }

        this.attachForeignKeys(tablesByQualified, foreignKeyRows, 'mssql');

        if (refreshEpoch !== this.schemaEpoch) {
            return false;
        }
        const cache = new SchemaCache(
            [...tablesByQualified.values()],
            Date.now(),
            false,
            foreignKeysLoaded
        );
        this.schemaCache = cache;
        this.schemaEmitter.fire(cache);
        this.ports.log.appendLine(
            `[schema] loaded ${cache.tables.length} tables and views from ${databases.join(', ')} (mssql)`
        );
        void this.saveDiskCache();
        return true;
    }

    private async refreshMysqlSchema(
        config: ExtensionConfig,
        refreshEpoch: number
    ): Promise<boolean> {
        const pool = this.mysqlPool!;
        const databases = selectedDatabases(config);
        if (databases.length === 0) {
            return false;
        }

        const [columnRows] = await pool.query<mysql.RowDataPacket[]>(
            mysqlSchemaQuery(databases.length),
            databases
        );

        const foreignKeyRows: RawForeignKeyRow[] = [];
        let foreignKeysLoaded = true;
        try {
            const [fkRows] = await pool.query<mysql.RowDataPacket[]>(
                mysqlForeignKeyQuery(databases.length),
                databases
            );
            for (const row of fkRows) {
                foreignKeyRows.push({
                    database_name: String(row.database_name),
                    schema_name: String(row.schema_name),
                    table_name: String(row.table_name),
                    constraint_name: String(row.constraint_name),
                    column_name: String(row.column_name),
                    ref_database_name: String(row.ref_database_name),
                    ref_schema_name: String(row.ref_schema_name),
                    ref_table_name: String(row.ref_table_name),
                    ref_column_name: String(row.ref_column_name),
                    ordinal: Number(row.ordinal) || 0
                });
            }
        } catch (fkError) {
            const message = fkError instanceof Error ? fkError.message : String(fkError);
            foreignKeysLoaded = false;
            this.ports.log.appendLine(`[schema] skipped foreign keys (mysql): ${message}`);
        }

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
                    columnsByLower: new Map<string, ColumnInfo>(),
                    foreignKeys: []
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

        this.attachForeignKeys(tablesByQualified, foreignKeyRows, 'mysql');

        if (refreshEpoch !== this.schemaEpoch) {
            return false;
        }
        const cache = new SchemaCache(
            [...tablesByQualified.values()],
            Date.now(),
            false,
            foreignKeysLoaded
        );
        this.schemaCache = cache;
        this.schemaEmitter.fire(cache);
        this.ports.log.appendLine(
            `[schema] loaded ${cache.tables.length} tables and views from ${databases.join(', ')} (mysql)`
        );
        void this.saveDiskCache();
        return true;
    }

    private async refreshPostgresSchema(
        config: ExtensionConfig,
        refreshEpoch: number
    ): Promise<boolean> {
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
            }>(POSTGRES_COLUMN_QUERY),
            pool.query<{
                schema_name: string;
                table_name: string;
                column_name: string;
            }>(POSTGRES_KEY_QUERY)
        ]);

        const foreignKeyRows: RawForeignKeyRow[] = [];
        let foreignKeysLoaded = true;
        try {
            const fkResult = await pool.query<RawForeignKeyRow>(POSTGRES_FOREIGN_KEY_QUERY);
            foreignKeyRows.push(...fkResult.rows);
        } catch (fkError) {
            const message = fkError instanceof Error ? fkError.message : String(fkError);
            foreignKeysLoaded = false;
            this.ports.log.appendLine(`[schema] skipped foreign keys (postgres): ${message}`);
        }

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
                    columnsByLower: new Map<string, ColumnInfo>(),
                    foreignKeys: []
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

        this.attachForeignKeys(tablesByQualified, foreignKeyRows, 'postgres');

        if (refreshEpoch !== this.schemaEpoch) {
            return false;
        }
        const cache = new SchemaCache(
            [...tablesByQualified.values()],
            Date.now(),
            false,
            foreignKeysLoaded
        );
        this.schemaCache = cache;
        this.schemaEmitter.fire(cache);
        this.ports.log.appendLine(
            `[schema] loaded ${cache.tables.length} tables and views from ${databaseName} (postgres)`
        );
        void this.saveDiskCache();
        return true;
    }

    private async refreshBigquerySchema(
        config: ExtensionConfig,
        projectFilter: string[] | undefined,
        refreshEpoch: number
    ): Promise<boolean> {
        const handle = this.bigquery!;
        const projects =
            projectFilter && projectFilter.length > 0
                ? projectFilter
                : effectiveCachedProjects(config.server, config.cachedProjects);
        if (projects.length === 0) {
            this.lastError = 'No BigQuery project to refresh.';
            return false;
        }
        const datasets = datasetsForProjects(config, projects);
        if (datasets.length === 0) {
            if (refreshEpoch !== this.schemaEpoch) {
                return false;
            }
            await this.commitBigquerySchema(
                config,
                projects,
                [],
                new Set(),
                datasets,
                Date.now(),
                refreshEpoch
            );
            if (refreshEpoch !== this.schemaEpoch) {
                return false;
            }
            this.ports.log.appendLine(
                `[schema] cleared cached tables for ${projects.join(', ')} (no datasets selected)`
            );
            return true;
        }
        const fetchedAt = Date.now();
        const failedDatasetKeys = new Set<string>();
        const tables = await loadBigquerySchema(handle, datasets, (dataset, message) => {
            this.ports.log.appendLine(`[schema] skipped dataset ${dataset}: ${message}`);
            const ref = parseBigqueryDatasetRef(dataset, config.server);
            if (ref) {
                failedDatasetKeys.add(datasetCacheKey(ref.project, ref.dataset));
            }
        });
        if (refreshEpoch !== this.schemaEpoch) {
            return false;
        }
        const cache = await this.commitBigquerySchema(
            config,
            projects,
            tables,
            failedDatasetKeys,
            datasets,
            fetchedAt,
            refreshEpoch
        );
        if (refreshEpoch !== this.schemaEpoch) {
            return false;
        }
        this.ports.log.appendLine(
            `[schema] loaded ${tables.length} tables/views from ${datasets.length} dataset(s) in ${projects.join(', ')} (bigquery); cache total ${cache.tables.length}`
        );
        if (failedDatasetKeys.size > 0) {
            if (refreshEpoch !== this.schemaEpoch) {
                return false;
            }
            this.lastError = `Could not refresh ${failedDatasetKeys.size} dataset(s). Their cached tables were kept.`;
            return false;
        }
        if (this.lastError?.startsWith('Could not refresh ')) {
            this.lastError = undefined;
        }
        return true;
    }

    /** Merge one BigQuery refresh into the cache and write the disk snapshot before returning. */
    private async commitBigquerySchema(
        config: ExtensionConfig,
        projects: string[],
        incoming: TableInfo[],
        failedDatasetKeys: ReadonlySet<string>,
        datasets: string[],
        fetchedAt: number,
        refreshEpoch: number
    ): Promise<SchemaCache> {
        if (refreshEpoch !== this.schemaEpoch) {
            return this.schemaCache;
        }
        const merged = mergeSchemaTables(
            this.schemaCache.tables,
            incoming,
            projects,
            failedDatasetKeys
        );
        const cache = new SchemaCache(merged, fetchedAt, false);
        if (refreshEpoch !== this.schemaEpoch) {
            return this.schemaCache;
        }
        this.schemaCache = cache;
        this.lastRefreshUpdatedCache = true;
        const projectMeta: Record<string, ProjectCacheMeta> = { ...this.bigqueryProjectMeta };
        for (const projectId of projects) {
            const projectDatasets = datasets.filter((raw) => {
                const ref = parseBigqueryDatasetRef(raw, config.server);
                return ref?.project.toLowerCase() === projectId.toLowerCase();
            });
            const projectFailed = projectDatasets.some((raw) => {
                const ref = parseBigqueryDatasetRef(raw, config.server);
                return ref !== undefined && failedDatasetKeys.has(datasetCacheKey(ref.project, ref.dataset));
            });
            if (!projectFailed) {
                projectMeta[projectId.toLowerCase()] = { fetchedAt, datasets: projectDatasets };
            }
        }
        this.bigqueryProjectMetaKey = this.connectionKey(config);
        this.bigqueryProjectMeta = projectMeta;
        await this.writeExplorerCatalog({ projectMeta });
        if (refreshEpoch !== this.schemaEpoch) {
            return this.schemaCache;
        }
        await this.persistSchemaSnapshot(cache);
        this.schemaEmitter.fire(cache);
        return cache;
    }

    /**
     * BigQuery: list datasets in a project, add them to the login, pin the project, refresh schema.
     */
    public async pinBigqueryProjectForCache(
        projectId: string,
        options?: { confirmLarge?: boolean }
    ): Promise<{ ok: boolean; message: string }> {
        const config = this.getConfig();
        if (config.engine !== 'bigquery') {
            return { ok: false, message: 'Project caching is for BigQuery.' };
        }
        const key = projectId.trim();
        if (!key) {
            return { ok: false, message: 'Project is required.' };
        }
        const home = config.server.trim().toLowerCase();
        if (key.toLowerCase() === home) {
            return { ok: false, message: 'Home project is always cached.' };
        }
        const listed = await this.listDatabases(key);
        if (!listed.ok) {
            return { ok: false, message: listed.message };
        }
        if (listed.databases.length === 0) {
            return { ok: false, message: `No datasets found in ${key}.` };
        }
        const datasets = listed.databases;
        if (options?.confirmLarge !== false && datasets.length > BIGQUERY_DATASET_WARN) {
            return {
                ok: false,
                message: `${key} has ${datasets.length} datasets. Pin it from the login page or confirm there.`
            };
        }
        const lower = key.toLowerCase();
        let cachedProjects = config.cachedProjects.filter((project) => project.toLowerCase() !== lower);
        if (cachedProjects.length >= 10) {
            return { ok: false, message: 'At most 10 extra cached projects (home is always included).' };
        }
        cachedProjects = [...cachedProjects, key];
        const merged = uniqueNames([...selectedDatabases(config), ...datasets]);
        const defaultDb = config.database.trim();
        const extras = merged.filter(
            (name) => name.toLowerCase() !== defaultDb.toLowerCase()
        );
        await this.saveConnectionSettings({
            connectionId: config.connectionId,
            name: config.connectionName,
            engine: config.engine,
            loginKind: config.loginKind,
            server: config.server,
            database: config.database,
            databases: extras,
            cachedProjects,
            user: config.user,
            port: config.port,
            encrypt: config.encrypt,
            trustServerCertificate: config.trustServerCertificate,
            enabled: config.enabled,
            activate: true
        });
        this.invalidateConfigCache();
        const refreshed = await this.refreshSchema({ projects: [key] });
        return {
            ok: refreshed,
            message: refreshed
                ? `Cached ${datasets.length} dataset(s) from ${key}.`
                : this.lastErrorMessage ?? `Pinned ${key} but schema refresh failed.`
        };
    }

    /** BigQuery: pin or unpin a project for schema caching. */
    public async setBigqueryProjectCached(
        projectId: string,
        cached: boolean
    ): Promise<{ ok: boolean; message: string }> {
        const config = this.getConfig();
        if (config.engine !== 'bigquery') {
            return { ok: false, message: 'Project caching is for BigQuery.' };
        }
        const home = config.server.trim().toLowerCase();
        const key = projectId.trim();
        if (!key) {
            return { ok: false, message: 'Project is required.' };
        }
        if (key.toLowerCase() === home) {
            return { ok: false, message: 'Home project is always cached.' };
        }
        const lower = key.toLowerCase();
        let next = config.cachedProjects.filter((project) => project.toLowerCase() !== lower);
        if (cached) {
            if (next.length >= 10) {
                return { ok: false, message: 'At most 10 extra cached projects (home is always included).' };
            }
            next = [...next, key];
        }
        await this.saveConnectionSettings({
            connectionId: config.connectionId,
            name: config.connectionName,
            engine: config.engine,
            loginKind: config.loginKind,
            server: config.server,
            database: config.database,
            databases: config.databases,
            cachedProjects: next,
            user: config.user,
            port: config.port,
            encrypt: config.encrypt,
            trustServerCertificate: config.trustServerCertificate,
            enabled: config.enabled,
            activate: true
        });
        if (!cached) {
            const trimmedDbs = removeDatasetsForProject(config.server, key, selectedDatabases(config));
            if (trimmedDbs.length !== selectedDatabases(config).length) {
                await this.saveConnectionSettings({
                    connectionId: config.connectionId,
                    name: config.connectionName,
                    engine: config.engine,
                    loginKind: config.loginKind,
                    server: config.server,
                    database: config.database,
                    databases: trimmedDbs.filter((name) => name.toLowerCase() !== config.database.toLowerCase()),
                    cachedProjects: next,
                    user: config.user,
                    port: config.port,
                    encrypt: config.encrypt,
                    trustServerCertificate: config.trustServerCertificate,
                    enabled: config.enabled,
                    activate: true
                });
            }
            const removedKey = key.toLowerCase();
            const kept = this.schemaCache.tables.filter(
                (table) => table.database.toLowerCase() !== removedKey
            );
            this.schemaCache = new SchemaCache(
                kept,
                this.schemaCache.fetchedAt,
                false,
                this.schemaCache.foreignKeysLoaded
            );
            this.schemaEmitter.fire(this.schemaCache);
            await this.persistSchemaSnapshot(this.schemaCache);
        }
        await this.reconfigure();
        return {
            ok: true,
            message: cached ? `${key} pinned for schema cache.` : `${key} removed from schema cache.`
        };
    }

    public peekAccessibleProjects(): {
        ok: true;
        projects: string[];
        message: string;
    } | undefined {
        const projects = peekCachedAccessibleProjects();
        if (!projects) {
            return undefined;
        }
        return this.accessibleProjectsOk(projects);
    }

    public async listAccessibleProjects(): Promise<{
        ok: boolean;
        projects: string[];
        message: string;
    }> {
        try {
            const listed = this.accessibleProjectsOk(await listAccessibleProjects());
            if (listed.projects.length > 0) {
                void this.writeExplorerCatalog({ projects: listed.projects });
            }
            return listed;
        } catch (error) {
            return { ok: false, projects: [], message: formatBigqueryAuthError(error) };
        }
    }

    private accessibleProjectsOk(projects: string[]): {
        ok: true;
        projects: string[];
        message: string;
    } {
        return {
            ok: true,
            projects,
            message: projects.length
                ? `${projects.length} projects`
                : 'No active projects found for this login.'
        };
    }

    /**
     * Sets BigQuery home to `projectId`. Old home datasets become extras.
     * If the new project has datasets, one of them becomes the default
     * (same dataset name when it exists).
     */
    public async switchBigqueryProject(
        projectId: string
    ): Promise<{ ok: boolean; message: string }> {
        const config = this.getConfig();
        if (config.engine !== 'bigquery') {
            return { ok: false, message: 'Switch Project is for BigQuery.' };
        }
        const nextHome = projectId.trim();
        if (!nextHome) {
            return { ok: false, message: 'Project is required.' };
        }
        const prevHome = config.server.trim();
        const rewritten = retargetBigqueryHome(
            selectedDatabases(config),
            config.database,
            prevHome,
            nextHome
        );
        let database = rewritten.database;
        let databases = rewritten.databases;
        try {
            const listed = await listBigqueryDatasets(createBigqueryHandle(nextHome), nextHome);
            const previous = parseBigqueryDatasetRef(config.database, prevHome)?.dataset ?? '';
            const homeDefault =
                listed.find((name) => name.toLowerCase() === previous.toLowerCase()) ||
                listed[0] ||
                '';
            if (homeDefault) {
                database = homeDefault;
                databases = selectedDatabases({
                    ...config,
                    database: homeDefault,
                    databases
                });
            }
        } catch {
            // Keep rewritten extras if the new project cannot list datasets.
        }
        const autoName = defaultConnectionName({
            loginKind: 'bigquery',
            server: prevHome
        });
        const name =
            !config.connectionName.trim() ||
            !prevHome ||
            config.connectionName === autoName
                ? defaultConnectionName({ loginKind: 'bigquery', server: nextHome })
                : config.connectionName;
        await this.saveConnectionSettings({
            connectionId: config.connectionId,
            name,
            engine: 'bigquery',
            loginKind: 'bigquery',
            server: nextHome,
            database,
            databases,
            user: '',
            port: 0,
            encrypt: true,
            trustServerCertificate: false,
            enabled: config.enabled,
            pinToWorkspace: this.isActivePinnedToWorkspace(),
            activate: true
        });
        await this.reconfigure();
        return { ok: true, message: `BigQuery home is now ${nextHome}.` };
    }

    /**
     * Lists databases the login can see. Uses the live pool when a default
     * database is set; otherwise opens a short-lived catalog connection
     * (`master` / `information_schema` / `postgres`) so the login page can
     * show names before the user picks a default.
     */
    public async listDatabases(
        listProject?: string
    ): Promise<{ ok: boolean; databases: string[]; message: string }> {
        const config = this.getConfig();
        if (!config.server.trim()) {
            return {
                ok: false,
                databases: [],
                message: config.engine === 'bigquery' ? 'Set project first.' : 'Set server first.'
            };
        }

        if (config.engine === 'bigquery') {
            return this.listBigqueryDatasetsForConfig(config, listProject);
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
                    void this.writeExplorerCatalog({ databases });
                    return { ok: true, databases, message: `${databases.length} databases` };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { ok: false, databases: [], message };
                }
            }
        }

        return this.listDatabasesViaCatalog(config);
    }

    private async listBigqueryDatasetsForConfig(
        config: ExtensionConfig,
        listProject?: string
    ): Promise<{ ok: boolean; databases: string[]; message: string }> {
        const home = config.server.trim();
        const project = (listProject || '').trim() || home;
        try {
            const handle = this.bigquery ?? createBigqueryHandle(home);
            if (!this.bigquery) {
                await pingBigquery(handle);
            }
            const databases = await listBigqueryDatasets(handle, project);
            if (!listProject || project.toLowerCase() === home.toLowerCase()) {
                void this.writeExplorerCatalog({ databases });
            }
            const label =
                project.toLowerCase() === home.toLowerCase()
                    ? `${databases.length} datasets`
                    : `${databases.length} datasets in ${project}`;
            return { ok: true, databases, message: label };
        } catch (error) {
            const message = formatBigqueryAuthError(error);
            return { ok: false, databases: [], message };
        }
    }

    private async listDatabasesViaCatalog(
        config: ExtensionConfig
    ): Promise<{ ok: boolean; databases: string[]; message: string }> {
        const listing: ExtensionConfig = {
            ...config,
            database: catalogDatabaseForEngine(config.engine)
        };
        const password = await this.resolvePassword(listing);
        this.ports.log.appendLine(
            `[connect] listing databases via ${listing.engine} catalog ${listing.database}`
        );

        let mysqlPool: mysql.Pool | undefined;
        let pgPool: pg.Pool | undefined;
        let mssqlPool: mssql.ConnectionPool | undefined;
        try {
            if (listing.engine === 'mysql') {
                mysqlPool = buildMysqlPool(listing, password);
                const conn = await mysqlPool.getConnection();
                conn.release();
            } else if (listing.engine === 'postgres') {
                pgPool = buildPostgresPool(listing, password, this.ports.log);
                const client = await pgPool.connect();
                client.release();
            } else {
                mssqlPool = new mssql.ConnectionPool(buildMssqlConfig(listing, password));
                await mssqlPool.connect();
            }
            const databases = await this.queryVisibleDatabaseNames(listing.engine, {
                mysql: mysqlPool,
                postgres: pgPool,
                mssql: mssqlPool
            });
            void this.writeExplorerCatalog({ databases });
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
            const config = this.getConfig();
            if (config.engine === 'bigquery' && config.server.trim()) {
                void this.refreshSchema({ projects: [config.server.trim()] });
            } else {
                void this.refreshSchema();
            }
        }, minutes * 60_000);
    }

    private stopRefreshTimer(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private cacheFileName(config: ExtensionConfig): string {
        return `schema-${this.connectionKey(config)}.json`;
    }

    private catalogFileName(connectionKey: string): string {
        return catalogFileName(connectionKey);
    }

    private async readCatalogFile(connectionKey: string): Promise<CatalogFile | undefined> {
        const memo = this.catalogMemo.get(connectionKey);
        if (memo) {
            return memo;
        }
        try {
            const bytes = await this.ports.files.read(this.catalogFileName(connectionKey));
            const parsed = parseCatalogJson(JSON.parse(Buffer.from(bytes).toString('utf8')));
            if (parsed && parsed.connectionKey === connectionKey) {
                this.catalogMemo.set(connectionKey, parsed);
                return parsed;
            }
        } catch {
            // Missing catalog is normal until the first list/refresh.
        }
        return undefined;
    }

    private async readDiskSchema(
        connectionKey: string,
        engine: DbEngine
    ): Promise<SchemaCache | undefined> {
        const memo = this.diskSchemaMemo.get(connectionKey);
        if (memo) {
            return memo;
        }
        try {
            const bytes = await this.ports.files.read(`schema-${connectionKey}.json`);
            const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8')) as SerializedSnapshot;
            if (snapshot.version !== CACHE_VERSION || snapshot.connectionKey !== connectionKey) {
                return undefined;
            }
            const cache = SchemaCache.deserialize(snapshot, engine);
            if (cache.isEmpty) {
                return undefined;
            }
            this.diskSchemaMemo.set(connectionKey, cache);
            return cache;
        } catch {
            return undefined;
        }
    }

    /**
     * Loads the on-disk snapshot so completions work before the first connection
     * succeeds. With no maxAgeMs the snapshot stays stale until a live fetch.
     * MCP passes maxAgeMs and ignores an older file. A young file is marked fresh
     * so tools can use it without a database round trip.
     */
    public async loadDiskCache(maxAgeMs?: number): Promise<boolean> {
        const config = this.getConfig();
        if (!config.cacheSchemaToDisk || !this.isConfigured(config)) {
            return false;
        }
        try {
            const bytes = await this.ports.files.read(this.cacheFileName(config));
            const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8')) as SerializedSnapshot;
            if (snapshot.version !== CACHE_VERSION) {
                return false;
            }
            if (snapshot.connectionKey !== this.connectionKey(config)) {
                return false;
            }
            let cache = SchemaCache.deserialize(snapshot, config.engine);
            if (cache.isEmpty) {
                return false;
            }
            if (maxAgeMs !== undefined) {
                const age = Date.now() - snapshot.fetchedAt;
                if (!Number.isFinite(age) || age >= maxAgeMs) {
                    return false;
                }
                cache = new SchemaCache(
                    cache.tables,
                    cache.fetchedAt,
                    false,
                    cache.foreignKeysLoaded
                );
            }
            this.schemaCache = cache;
            this.diskSchemaMemo.set(this.connectionKey(config), cache);
            this.schemaEmitter.fire(cache);
            const note = cache.stale ? ' (stale)' : '';
            this.ports.log.appendLine(
                `[schema] restored ${cache.tables.length} tables from the disk snapshot${note}`
            );
            return true;
        } catch {
            // A missing or unreadable snapshot is expected on first run.
            return false;
        }
    }

    private async saveDiskCache(): Promise<void> {
        if (this.schemaCache.isEmpty) {
            return;
        }
        await this.persistSchemaSnapshot(this.schemaCache);
    }

    /**
     * Write this cache to disk. The payload is built before the first await so a
     * later reconfigure cannot swap the in-memory cache underneath the write.
     * An empty cache deletes the snapshot. Otherwise a reload would bring back
     * tables that were just removed.
     */
    private persistSchemaSnapshot(cache: SchemaCache): Promise<void> {
        const config = this.getConfig();
        if (!config.cacheSchemaToDisk) {
            return Promise.resolve();
        }
        const key = this.connectionKey(config);
        const fileName = this.cacheFileName(config);
        const payload = cache.isEmpty ? undefined : JSON.stringify(cache.serialize(key));
        const databases = selectedDatabases(config);
        const run = this.schemaWrite.then(() =>
            this.writeSchemaSnapshot(cache, key, fileName, payload, databases)
        );
        this.schemaWrite = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private async writeSchemaSnapshot(
        cache: SchemaCache,
        key: string,
        fileName: string,
        payload: string | undefined,
        databases: string[]
    ): Promise<void> {
        if (payload === undefined) {
            try {
                await this.ports.files.delete(fileName);
            } catch {
                // No snapshot yet.
            }
            this.diskSchemaMemo.delete(key);
            return;
        }
        try {
            await this.ports.files.ensureStorageDir();
            await this.ports.files.write(fileName, Buffer.from(payload, 'utf8'));
            this.diskSchemaMemo.set(key, cache);
            const existing = await this.readCatalogFile(key);
            if (!existing?.databases.length) {
                void this.writeExplorerCatalog({ databases }, key);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.ports.log.appendLine(`[schema] could not write the disk snapshot: ${message}`);
        }
    }

    public async clearDiskCache(): Promise<void> {
        const config = this.getConfig();
        const key = this.connectionKey(config);
        try {
            await this.ports.files.delete(this.cacheFileName(config));
            this.ports.log.appendLine('[schema] disk snapshot deleted');
        } catch {
            // Nothing cached for this connection.
        }
        try {
            await this.ports.files.delete(this.catalogFileName(key));
        } catch {
            // No catalog file for this connection.
        }
        this.catalogMemo.delete(key);
        this.diskSchemaMemo.delete(key);
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
            (reference) => {
                const defaults = tableLookupDefaults(config);
                return this.schemaCache.findTable(
                    reference,
                    defaults.database,
                    defaults.schema
                );
            },
            config.engine,
            config.database,
            collectCteNames(tokens)
        );
    }

    /**
     * Dry-runs a query without changing data.
     * - SQL Server: SET NOEXEC ON
     * - MySQL / PostgreSQL: EXPLAIN on SELECT/DML only (CREATE/DROP/ALTER are skipped)
     * - BigQuery: jobs.create with dryRun (parse/plan, no bytes billed)
     * Named binds (`:path`) are rewritten like Run; values are NULL (no prompt).
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
        if (config.engine === 'bigquery') {
            return this.dryRunOnBigquery(qualified);
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

        const rewritten = rewriteNamedBinds(sql, 'at');
        const batch = `SET NOEXEC ON;\n${rewritten.sql}\nSET NOEXEC OFF;`;
        try {
            await this.runWithReconnect(() => {
                const request = this.mssqlPool!.request();
                const bound = new Set<string>();
                for (const name of rewritten.namesInOrder) {
                    const key = name.toLowerCase();
                    if (bound.has(key)) {
                        continue;
                    }
                    bound.add(key);
                    request.input(name, mssql.NVarChar, null);
                }
                return request.batch(batch);
            });
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

        const timeout = this.getConfig().connectionTimeout;
        for (const statement of plan.statements) {
            // Run / Explain rewrite `:name` to `?`. Dry-run has no prompt, so every bind is NULL.
            const rewritten = rewriteNamedBinds(statement.text, 'qmark');
            const values = rewritten.namesInOrder.map(() => null);
            const explainSql = `EXPLAIN ${rewritten.sql}`;
            try {
                // EXPLAIN plans SELECT/DML without applying side effects.
                // CREATE/DROP/ALTER are filtered out first — wrapping them is invalid.
                await this.runWithReconnect(() =>
                    this.mysqlPool!.query({ sql: explainSql, timeout, values })
                );
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
                const extra = newlinesBefore(sql, statement.start);
                return {
                    kind: 'errors',
                    errors: [
                        {
                            number: errno,
                            message: shiftEngineLineRefs(message, extra),
                            lineNumber:
                                (queryLineFromEngineError(error, explainSql) ?? 1) + extra
                        }
                    ]
                };
            }
        }
        return { kind: 'ok' };
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

        for (const statement of plan.statements) {
            const rewritten = rewriteNamedBinds(statement.text, 'dollar');
            const values = rewritten.namesInOrder.map(() => null);
            const explainSql = `EXPLAIN ${rewritten.sql}`;
            try {
                await this.runWithReconnect(() => this.pgPool!.query(explainSql, values));
            } catch (error) {
                const message = errorText(error);
                if (isTransientConnectionError(message, errorErrno(error))) {
                    this.setState('error', message);
                    return { kind: 'unavailable', reason: message };
                }
                const extra = newlinesBefore(sql, statement.start);
                return {
                    kind: 'errors',
                    errors: [
                        {
                            number: errorErrno(error),
                            message: shiftEngineLineRefs(message, extra),
                            lineNumber:
                                (queryLineFromEngineError(error, explainSql) ?? 1) + extra
                        }
                    ]
                };
            }
        }
        return { kind: 'ok' };
    }

    private async dryRunOnBigquery(sql: string): Promise<DryRunResult> {
        const ok = await this.ensureConnected();
        if (!ok || !this.bigquery) {
            return {
                kind: 'unavailable',
                reason: this.lastError ?? 'No database connection is available.'
            };
        }
        try {
            const bound = namedAtBinds(sql, {});
            const stats = await dryRunBigquery(
                this.bigquery,
                bound.sql,
                bound.params,
                this.getConfig().database
            );
            return { kind: 'ok', scanBytes: parseScanBytes(stats.totalBytesProcessed) };
        } catch (error) {
            const message = formatBigqueryAuthError(error);
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
                        lineNumber: queryLineFromEngineError(error, sql)
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
            if (config.engine === 'bigquery') {
                return this.executeBigquery(text, params, fetchLimit, started, includeRaw, signal);
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

    /**
     * Dry-run byte estimate for BigQuery Run confirmation. Other engines
     * return undefined. A failed estimate also returns undefined bytes so
     * the UI does not block; the real Run still reports the error.
     */
    public async estimateBigqueryScan(
        sql: string,
        params: Record<string, string | null> = {}
    ): Promise<{ bytes: number | undefined; accuracy: string | undefined } | undefined> {
        const config = this.getConfig();
        if (config.engine !== 'bigquery') {
            return undefined;
        }
        const ok = await this.ensureConnected();
        if (!ok || !this.bigquery) {
            return { bytes: undefined, accuracy: undefined };
        }
        try {
            const filledSql = applyPlaceholders(sql, params);
            const qualified = this.qualifyCrossDatabaseTables(filledSql);
            const bound = namedAtBinds(qualified, params);
            const stats = await dryRunBigquery(
                this.bigquery,
                bound.sql,
                bound.params,
                config.database
            );
            return {
                bytes: parseScanBytes(stats.totalBytesProcessed),
                accuracy: stats.totalBytesProcessedAccuracy
            };
        } catch {
            return { bytes: undefined, accuracy: undefined };
        }
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
        const fail = (error: string, errorLine?: number): QueryResult => ({
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
            error,
            errorLine
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
            this.ports.log.appendLine(
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
                this.ports.log.appendLine('[query] mssql cancelled');
                return fail('Cancelled.');
            }
            this.ports.log.appendLine(`[query] mssql failed: ${message}`);
            return fail(message, queryLineFromEngineError(error));
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
        const fail = (error: string, errorLine?: number): QueryResult => ({
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
            error,
            errorLine
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
                this.ports.log.appendLine(
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
            this.ports.log.appendLine(
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
                this.ports.log.appendLine('[query] mysql cancelled');
                return fail('Cancelled.');
            }
            const message = err.sqlMessage || err.message || String(error);
            this.ports.log.appendLine(`[query] mysql failed: ${message}`);
            return fail(message, queryLineFromEngineError(error, rewritten.sql));
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
        const fail = (error: string, errorLine?: number): QueryResult => ({
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
            error,
            errorLine
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
                this.ports.log.appendLine(
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
            this.ports.log.appendLine(
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
                this.ports.log.appendLine('[query] postgres cancelled');
                return fail('Cancelled.');
            }
            this.ports.log.appendLine(`[query] postgres failed: ${message}`);
            return fail(message, queryLineFromEngineError(error, rewritten.sql));
        }
    }

    private async executeBigquery(
        sql: string,
        params: Record<string, string | null>,
        maxRows: number,
        started: number,
        includeRaw = false,
        signal?: AbortSignal
    ): Promise<QueryResult> {
        const bound = namedAtBinds(sql, params);
        const fail = (error: string, errorLine?: number): QueryResult => ({
            ok: false,
            sql,
            executedSql: bound.sql,
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
            error,
            errorLine
        });
        if (!this.bigquery) {
            return fail(this.lastError ?? 'No database connection is available.');
        }
        try {
            if (signal?.aborted) {
                return fail('Cancelled.');
            }
            const fetched = await runBigqueryQuery(this.bigquery, {
                sql: bound.sql,
                params: bound.params,
                maxRows,
                defaultDataset: this.getConfig().database,
                signal
            });
            if (fetched.columns.length === 0) {
                this.ports.log.appendLine(
                    `[query] bigquery ${fetched.rowsAffected ?? 0} row(s) affected in ${Date.now() - started}ms`
                );
                return {
                    ok: true,
                    sql,
                    executedSql: bound.sql,
                    params,
                    columns: [],
                    rows: [],
                    rawRows: includeRaw ? [] : undefined,
                    rowsAffected: fetched.rowsAffected,
                    elapsedMs: Date.now() - started,
                    truncated: false,
                    maxRows,
                    pageOffset: 0,
                    paged: false,
                    scanBytes: fetched.scanBytes
                };
            }
            const truncated = fetched.rows.length > maxRows;
            const sliced = truncated ? fetched.rows.slice(0, maxRows) : fetched.rows;
            const rows = sliced.map((row) =>
                fetched.columns.map((column) => formatQueryCell(row[column]))
            );
            const rawRows = includeRaw
                ? sliced.map((row) =>
                      fetched.columns.map((column) => jsonQueryCell(row[column]))
                  )
                : undefined;
            this.ports.log.appendLine(
                `[query] bigquery ${rows.length} row(s) in ${Date.now() - started}ms`
            );
            return {
                ok: true,
                sql,
                executedSql: bound.sql,
                params,
                columns: fetched.columns,
                rows,
                rawRows,
                rowsAffected: fetched.rowsAffected,
                elapsedMs: Date.now() - started,
                truncated,
                maxRows,
                pageOffset: 0,
                paged: false,
                scanBytes: fetched.scanBytes
            };
        } catch (error) {
            const message = formatBigqueryAuthError(error);
            if (isQueryCancelled(error, signal)) {
                this.ports.log.appendLine('[query] bigquery cancelled');
                return fail('Cancelled.');
            }
            this.ports.log.appendLine(`[query] bigquery failed: ${message}`);
            return fail(message, queryLineFromEngineError(error, bound.sql));
        }
    }

    /**
     * Returns a query plan without running the statement.
     * MySQL: EXPLAIN (prefers FORMAT=JSON).
     * PostgreSQL: EXPLAIN (FORMAT JSON).
     * SQL Server: SET SHOWPLAN_ALL on a dedicated 1-connection pool so the
     * SET cannot leak onto a different pooled connection (which would execute
     * the query for real).
     * BigQuery: dry-run estimate (bytes, tables, output columns). No stage plan.
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
        } else if (config.engine === 'bigquery') {
            explained = await this.explainBigquery(qualified, params, started);
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
            this.ports.log.appendLine(
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
            this.ports.log.appendLine(
                `[explain] mysql FORMAT=JSON failed, falling back: ${jsonMessage}`
            );
            try {
                const planned = await runExplain(textSql);
                this.ports.log.appendLine(
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
                this.ports.log.appendLine(`[explain] mysql failed: ${message}`);
                return {
                    ok: false,
                    sql,
                    executedSql: textSql,
                    engine: 'mysql',
                    columns: [],
                    rows: [],
                    elapsedMs: Date.now() - started,
                    error: message,
                    errorLine: queryLineFromEngineError(error, textSql)
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
            this.ports.log.appendLine(
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
            this.ports.log.appendLine(`[explain] postgres failed: ${message}`);
            return {
                ok: false,
                sql,
                executedSql: jsonSql,
                engine: 'postgres',
                columns: [],
                rows: [],
                elapsedMs: Date.now() - started,
                error: message,
                errorLine: queryLineFromEngineError(error, jsonSql)
            };
        }
    }

    private async explainBigquery(
        sql: string,
        params: Record<string, string | null>,
        started: number
    ): Promise<ExplainResult> {
        const bound = namedAtBinds(sql, params);
        const ok = await this.ensureConnected();
        if (!ok || !this.bigquery) {
            return {
                ok: false,
                sql,
                executedSql: bound.sql,
                engine: 'bigquery',
                columns: [],
                rows: [],
                elapsedMs: Date.now() - started,
                error: this.lastError ?? 'No database connection is available.'
            };
        }
        try {
            const stats = await dryRunBigquery(
                this.bigquery,
                bound.sql,
                bound.params,
                this.getConfig().database
            );
            const rows = explainRowsFromDryRun(stats);
            this.ports.log.appendLine(
                `[explain] bigquery dry-run ${rows.length} row(s) in ${Date.now() - started}ms`
            );
            return {
                ok: true,
                sql,
                executedSql: bound.sql,
                engine: 'bigquery',
                columns: ['Property', 'Value'],
                rows,
                elapsedMs: Date.now() - started,
                note: BIGQUERY_EXPLAIN_NOTE,
                scanBytes: parseScanBytes(stats.totalBytesProcessed)
            };
        } catch (error) {
            const message = formatBigqueryAuthError(error);
            this.ports.log.appendLine(`[explain] bigquery failed: ${message}`);
            return {
                ok: false,
                sql,
                executedSql: bound.sql,
                engine: 'bigquery',
                columns: [],
                rows: [],
                elapsedMs: Date.now() - started,
                error: message,
                errorLine: queryLineFromEngineError(error, bound.sql)
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
        const poolConfig = buildMssqlConfig(config, password);
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
            this.ports.log.appendLine(
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
            this.ports.log.appendLine(`[explain] mssql failed: ${message}`);
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
                    : message,
                errorLine: queryLineFromEngineError(error)
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
        this.bigquery = undefined;
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

    private catalogWithLiveProjectMeta(
        key: string,
        active: boolean,
        catalog: CatalogFile | undefined
    ): CatalogFile | undefined {
        if (
            !active ||
            this.bigqueryProjectMetaKey !== key ||
            Object.keys(this.bigqueryProjectMeta).length === 0
        ) {
            return catalog;
        }
        return mergeCatalogPatch(catalog, key, { projectMeta: this.bigqueryProjectMeta });
    }

    /**
     * Rebuilds the connection after a settings change and reloads metadata.
     */
    public reconfigure(): Promise<void> {
        const run = this.reconfigureTail.then(() => this.runReconfigure());
        this.reconfigureTail = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private async runReconfigure(): Promise<void> {
        await this.schemaWrite;
        this.schemaEpoch += 1;
        this.dropSchemaRefreshWaiters();
        this.cachedConfig = undefined;
        this.bigqueryProjectMeta = {};
        this.bigqueryProjectMetaKey = '';
        this.refreshPaused = true;
        const refreshEpoch = this.schemaEpoch;
        try {
            // Publish the new login's cached schema before the old refresh finishes.
            this.schemaCache = SchemaCache.empty();
            const config = this.getConfig();
            if (config.enabled) {
                const loaded = await this.loadDiskCache();
                if (!loaded) {
                    this.schemaEmitter.fire(this.schemaCache);
                }
            } else {
                this.schemaEmitter.fire(this.schemaCache);
            }

            if (this.refreshInFlight) {
                await this.refreshInFlight.catch(() => false);
            }
            await this.disposePool();
            this.setState('disconnected');
            if (!config.enabled) {
                this.liveSchemaRequested = false;
                this.setState('disabled');
                this.stopRefreshTimer();
                this.schemaCache = SchemaCache.empty();
                this.schemaEmitter.fire(this.schemaCache);
                return;
            }
            this.liveSchemaRequested = true;
            this.startRefreshTimer();
            await this.doRefreshSchema(undefined, refreshEpoch);
        } finally {
            this.refreshPaused = false;
            this.pumpRefreshQueue();
        }
    }

    public dispose(): void {
        this.stopRefreshTimer();
        void this.disposePool();
        this.stateEmitter.dispose();
        this.schemaEmitter.dispose();
    }
}
