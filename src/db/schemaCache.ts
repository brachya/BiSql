import { splitIdentifier, unquoteIdentifier } from '../sql/identifiers';
import { CACHE_VERSION } from './config';
import { DbEngine } from './engines';
import { ColumnInfo, ForeignKeyInfo, TableInfo } from './schemaTypes';

export type { ColumnInfo, ForeignKeyInfo, TableInfo } from './schemaTypes';

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

interface SerializedForeignKey {
    n: string;
    c: string[];
    t: string;
    rc: string[];
}

interface SerializedTable {
    db: string;
    s: string;
    n: string;
    v: boolean;
    c: SerializedColumn[];
    fk?: SerializedForeignKey[];
}

export interface SerializedSnapshot {
    version: number;
    connectionKey: string;
    fetchedAt: number;
    tables: SerializedTable[];
}

export interface RawColumnRow {
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

export interface RawKeyRow {
    database_name: string;
    schema_name: string;
    table_name: string;
    column_name: string;
}

export interface RawForeignKeyRow {
    database_name: string;
    schema_name: string;
    table_name: string;
    constraint_name: string;
    column_name: string;
    ref_database_name: string;
    ref_schema_name: string;
    ref_table_name: string;
    ref_column_name: string;
    ordinal: number;
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
    /** False when restored from an older disk snapshot that has no foreign-key data. */
    public readonly foreignKeysLoaded: boolean;

    private readonly byQualifiedLower = new Map<string, TableInfo>();
    private readonly byFullLower = new Map<string, TableInfo[]>();
    private readonly byNameLower = new Map<string, TableInfo[]>();

    constructor(
        tables: TableInfo[],
        fetchedAt: number,
        stale: boolean,
        foreignKeysLoaded = true
    ) {
        this.tables = tables;
        this.fetchedAt = fetchedAt;
        this.stale = stale;
        this.foreignKeysLoaded = foreignKeysLoaded;
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
        return new SchemaCache([], 0, false, false);
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

    /**
     * True when this cache has any table in the catalog/schema the reference
     * names. Bare names use the default catalog we already loaded. A 2- or
     * 3-part name for a dataset we never fetched is not "unknown" — we do
     * not know.
     */
    public hasLoadedNamespace(reference: string): boolean {
        const parts = splitIdentifier(reference).filter((part) => part.length > 0);
        if (parts.length < 2) {
            return true;
        }
        if (parts.length >= 3) {
            const database = parts[parts.length - 3].toLowerCase();
            const schema = parts[parts.length - 2].toLowerCase();
            return this.tables.some(
                (table) =>
                    table.database.toLowerCase() === database &&
                    table.schema.toLowerCase() === schema
            );
        }
        const left = parts[0].toLowerCase();
        return this.tables.some(
            (table) =>
                table.database.toLowerCase() === left || table.schema.toLowerCase() === left
        );
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
                })),
                fk: table.foreignKeys.map((fk) => ({
                    n: fk.name,
                    c: fk.columns,
                    t: fk.refTable,
                    rc: fk.refColumns
                }))
            }))
        };
    }

    public static deserialize(snapshot: SerializedSnapshot, engine: DbEngine = 'mssql'): SchemaCache {
        const foreignKeysLoaded =
            snapshot.tables.length === 0 ||
            snapshot.tables.every((raw) => Array.isArray(raw.fk));
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
            const foreignKeys: ForeignKeyInfo[] = (raw.fk ?? []).map((fk) => ({
                name: fk.n,
                columns: [...fk.c],
                refTable: fk.t,
                refColumns: [...fk.rc]
            }));
            return {
                database,
                schema: raw.s,
                name: raw.n,
                fullName: `${raw.s}.${raw.n}`,
                qualifiedName: buildQualifiedName(database, raw.s, raw.n, engine),
                isView: raw.v,
                columns,
                columnsByLower,
                foreignKeys
            };
        });
        return new SchemaCache(tables, snapshot.fetchedAt, true, foreignKeysLoaded);
    }
}

/** Group catalog foreign-key rows into per-table constraints. */
export function foreignKeysFromRawRows(
    rows: RawForeignKeyRow[],
    engine: DbEngine
): Map<string, ForeignKeyInfo[]> {
    const grouped = new Map<
        string,
        { name: string; columns: { ordinal: number; name: string }[]; refTable: string; refColumns: { ordinal: number; name: string }[] }
    >();
    for (const row of rows) {
        const tableKey = `${row.database_name.toLowerCase()}.${row.schema_name.toLowerCase()}.${row.table_name.toLowerCase()}`;
        const constraintKey = `${tableKey}|${row.constraint_name.toLowerCase()}`;
        let entry = grouped.get(constraintKey);
        if (!entry) {
            entry = {
                name: row.constraint_name,
                columns: [],
                refTable: buildQualifiedName(
                    row.ref_database_name,
                    row.ref_schema_name,
                    row.ref_table_name,
                    engine
                ),
                refColumns: []
            };
            grouped.set(constraintKey, entry);
        }
        entry.columns.push({ ordinal: row.ordinal, name: row.column_name });
        entry.refColumns.push({ ordinal: row.ordinal, name: row.ref_column_name });
    }
    const byTable = new Map<string, ForeignKeyInfo[]>();
    for (const [constraintKey, entry] of grouped) {
        const tableKey = constraintKey.slice(0, constraintKey.lastIndexOf('|'));
        const fk: ForeignKeyInfo = {
            name: entry.name,
            columns: entry.columns.sort((a, b) => a.ordinal - b.ordinal).map((c) => c.name),
            refTable: entry.refTable,
            refColumns: entry.refColumns.sort((a, b) => a.ordinal - b.ordinal).map((c) => c.name)
        };
        const bucket = byTable.get(tableKey);
        if (bucket) {
            bucket.push(fk);
        } else {
            byTable.set(tableKey, [fk]);
        }
    }
    return byTable;
}
