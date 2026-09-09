import { FormatKeywordCase } from '../sql/formatEmbeddedSql';
import { bigqueryLookupDefaults } from './bigquery';
import { DbEngine, LoginKind, defaultSchemaForEngine } from './engines';

export const CONFIG_SECTION = 'bisql';
export const LEGACY_CONFIG_SECTION = 'sqlPythonValidator';
export const SECRET_KEY_GLOBAL = 'sqlPythonValidator.password.global';
export const SECRET_KEY_LEGACY = 'sqlPythonValidator.password';
export const SCOPE_STATE_KEY = 'bisql.settingsScope';
export const LEGACY_SCOPE_STATE_KEY = 'sqlPythonValidator.settingsScope';
export const CACHE_VERSION = 3;

export const CONNECTION_SETTING_KEYS = [
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

/** Shared across all projects, or only this workspace. */
export type SettingsScope = 'global' | 'workspace';

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
    /**
     * Ask before a BigQuery Run whose dry-run estimate is above this many MB.
     * `LIMIT` does not reduce bytes scanned. 0 asks for every scan.
     */
    bigqueryConfirmScanMb: number;
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

/** Catalog + schema used to break ties when a bare table name matches more than once. */
export function tableLookupDefaults(config: ExtensionConfig): {
    database: string;
    schema: string;
} {
    if (config.engine === 'bigquery') {
        return bigqueryLookupDefaults(config.server, config.database);
    }
    return {
        database: config.database,
        schema: defaultSchemaForEngine(config.engine) ?? ''
    };
}

/** System catalog used only to list database names when the user has not picked a default yet. */
export function catalogDatabaseForEngine(engine: DbEngine): string {
    if (engine === 'mysql') {
        return 'information_schema';
    }
    if (engine === 'postgres') {
        return 'postgres';
    }
    return 'master';
}

export function normalizeDatabaseList(value: unknown): string[] {
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
