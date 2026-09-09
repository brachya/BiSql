import * as pg from 'pg';

/**
 * pg turns DATE/TIMESTAMP into JS Date, then we would print UTC ISO.
 * Keep the wire string so a date stays a date (same idea as mysql2 dateStrings).
 */
const keepPgDateString = (value: string): string => value;
pg.types.setTypeParser(pg.types.builtins.DATE, keepPgDateString);
pg.types.setTypeParser(pg.types.builtins.TIME, keepPgDateString);
pg.types.setTypeParser(pg.types.builtins.TIMETZ, keepPgDateString);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, keepPgDateString);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, keepPgDateString);

export type { DbEngine, LoginKind } from './engines';
export {
    defaultPortForEngine,
    defaultSchemaForEngine,
    engineForLoginKind,
    parseEngine,
    parseLoginKind
} from './engines';
export type { ConnectionProfile } from './connectionProfiles';
export { splitIdentifier, unquoteIdentifier } from '../sql/identifiers';
export { CONFIG_SECTION, selectedDatabases, tableLookupDefaults } from './config';
export type { SettingsScope, ExtensionConfig } from './config';
export type { ColumnInfo, TableInfo } from './schemaTypes';
export { buildQualifiedName, SchemaCache } from './schemaCache';
export type { ConnectionState, DryRunError, DryRunResult, QueryResult, ExplainResult } from './queryCells';
export {
    isMysqlViewExplainPrivilegeError,
    isTransientConnectionError
} from './queryCells';
export { renderType } from './mssqlOps';
export { SqlServerService } from './sqlServerService';
