/** MySQL catalogs that exist on the server but are not loaded into the user-schema cache. */
const MYSQL_SYSTEM_SCHEMAS = new Set([
    'information_schema',
    'performance_schema',
    'mysql',
    'sys'
]);

/** SQL Server schemas that live in every database and are often missing from user-object lists. */
const MSSQL_SYSTEM_SCHEMAS = new Set(['information_schema', 'sys']);

/** PostgreSQL catalogs that exist on the server but are not loaded into the user-schema cache. */
const POSTGRES_SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog']);

const MYSQL_CATALOG_NOTE: Record<string, string> = {
    information_schema: 'Built-in MySQL catalog of databases, tables, columns, and other metadata.',
    performance_schema: 'Built-in MySQL catalog of server runtime metrics.',
    mysql: 'Built-in MySQL database of grants and server settings.',
    sys: 'Built-in MySQL views that make performance_schema easier to query.'
};

const MSSQL_CATALOG_NOTE: Record<string, string> = {
    information_schema:
        'ANSI catalog views in this database (tables, columns, and other metadata).',
    sys: 'SQL Server catalog views for objects in this database.'
};

const POSTGRES_CATALOG_NOTE: Record<string, string> = {
    information_schema:
        'ANSI catalog views in this database (tables, columns, and other metadata).',
    pg_catalog: 'PostgreSQL system catalog of tables, types, roles, and other objects.'
};

interface KnownColumn {
    name: string;
    type: string;
}

interface KnownObject {
    engines: ReadonlySet<string>;
    catalogs: ReadonlySet<string>;
    summary: string;
    kind: 'view' | 'table';
    columns?: readonly KnownColumn[];
}

const MYSQL_TABLES_COLUMNS: readonly KnownColumn[] = [
    { name: 'TABLE_SCHEMA', type: 'varchar' },
    { name: 'TABLE_NAME', type: 'varchar' },
    { name: 'TABLE_TYPE', type: 'varchar' },
    { name: 'ENGINE', type: 'varchar' },
    { name: 'TABLE_ROWS', type: 'bigint' },
    { name: 'CREATE_TIME', type: 'datetime' },
    { name: 'TABLE_COLLATION', type: 'varchar' },
    { name: 'TABLE_COMMENT', type: 'varchar' }
];

const ANSI_TABLES_COLUMNS: readonly KnownColumn[] = [
    { name: 'TABLE_CATALOG', type: 'nvarchar' },
    { name: 'TABLE_SCHEMA', type: 'nvarchar' },
    { name: 'TABLE_NAME', type: 'nvarchar' },
    { name: 'TABLE_TYPE', type: 'nvarchar' }
];

const ANSI_COLUMNS_COLUMNS: readonly KnownColumn[] = [
    { name: 'TABLE_SCHEMA', type: 'varchar' },
    { name: 'TABLE_NAME', type: 'varchar' },
    { name: 'COLUMN_NAME', type: 'varchar' },
    { name: 'ORDINAL_POSITION', type: 'bigint' },
    { name: 'DATA_TYPE', type: 'varchar' },
    { name: 'IS_NULLABLE', type: 'varchar' }
];

const KNOWN_OBJECTS: Record<string, KnownObject> = {
    tables: {
        engines: new Set(['mysql', 'mssql', 'postgres']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists tables and views in each database.',
        kind: 'view',
        columns: MYSQL_TABLES_COLUMNS
    },
    columns: {
        engines: new Set(['mysql', 'mssql', 'postgres']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists columns for tables and views.',
        kind: 'view',
        columns: ANSI_COLUMNS_COLUMNS
    },
    schemata: {
        engines: new Set(['mysql', 'mssql', 'postgres']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists databases (schemas) on the server.',
        kind: 'view'
    },
    statistics: {
        engines: new Set(['mysql']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists indexes and their columns.',
        kind: 'view'
    },
    key_column_usage: {
        engines: new Set(['mysql', 'mssql', 'postgres']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists columns that take part in keys and foreign keys.',
        kind: 'view'
    },
    table_constraints: {
        engines: new Set(['mysql', 'mssql', 'postgres']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists primary, unique, and foreign key constraints.',
        kind: 'view'
    },
    views: {
        engines: new Set(['mysql', 'mssql', 'postgres']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists views.',
        kind: 'view'
    },
    routines: {
        engines: new Set(['mysql', 'mssql', 'postgres']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists stored procedures and functions.',
        kind: 'view'
    },
    triggers: {
        engines: new Set(['mysql', 'mssql', 'postgres']),
        catalogs: new Set(['information_schema']),
        summary: 'Lists triggers.',
        kind: 'view'
    }
};

const MSSQL_SYS_OBJECTS: Record<string, string> = {
    tables: 'Lists user tables in the current database.',
    views: 'Lists views in the current database.',
    columns: 'Lists columns for tables and views.',
    objects: 'Lists all schema-scoped objects.',
    schemas: 'Lists schemas in the current database.',
    databases: 'Lists databases on the server.',
    indexes: 'Lists indexes.',
    foreign_keys: 'Lists foreign key constraints.',
    procedures: 'Lists stored procedures.',
    types: 'Lists system and user data types.'
};

const POSTGRES_CATALOG_OBJECTS: Record<string, string> = {
    pg_class: 'Tables, indexes, sequences, views, materialized views, and similar relations.',
    pg_attribute: 'Table columns.',
    pg_namespace: 'Schemas.',
    pg_index: 'Indexes.',
    pg_constraint: 'Table constraints, including primary keys and foreign keys.',
    pg_type: 'Data types.',
    pg_proc: 'Functions and procedures.',
    pg_database: 'Databases on this server.',
    pg_tables: 'User tables (a friendlier view over pg_class).',
    pg_views: 'Views.',
    pg_indexes: 'Indexes.',
    pg_stat_activity: 'One row per server process, with current query text.'
};

function catalogParts(reference: string): string[] {
    return reference
        .split('.')
        .map((part) =>
            part
                .replace(/^\[|\]$/g, '')
                .replace(/^`|`$/g, '')
                .replace(/^"|"$/g, '')
        )
        .filter((part) => part.length > 0);
}

function systemSchemas(engine: string): Set<string> {
    if (engine === 'mysql') {
        return MYSQL_SYSTEM_SCHEMAS;
    }
    if (engine === 'postgres') {
        return POSTGRES_SYSTEM_SCHEMAS;
    }
    return MSSQL_SYSTEM_SCHEMAS;
}

function catalogNote(engine: string, catalog: string): string {
    const notes =
        engine === 'mysql'
            ? MYSQL_CATALOG_NOTE
            : engine === 'postgres'
              ? POSTGRES_CATALOG_NOTE
              : MSSQL_CATALOG_NOTE;
    return notes[catalog] ?? `Built-in ${engineLabel(engine)} system catalog.`;
}

function engineLabel(engine: string): string {
    if (engine === 'mysql') {
        return 'MySQL';
    }
    if (engine === 'postgres') {
        return 'PostgreSQL';
    }
    return 'SQL Server';
}

/**
 * Catalog + object name for a qualified system reference.
 * `information_schema.TABLES` → { catalog, name }.
 */
export function splitSystemCatalogRef(
    reference: string,
    engine: string
): { catalog: string; name: string } | undefined {
    const parts = catalogParts(reference);
    if (parts.length < 2) {
        return undefined;
    }
    const schemas = systemSchemas(engine);
    if (parts.length === 2) {
        const catalog = parts[0].toLowerCase();
        if (!schemas.has(catalog)) {
            return undefined;
        }
        return { catalog, name: parts[1] };
    }
    const first = parts[0].toLowerCase();
    const second = parts[1].toLowerCase();
    // information_schema.TABLES.COLUMN — extra parts are not a schema.
    if (schemas.has(first) && !schemas.has(second)) {
        return { catalog: first, name: parts[1] };
    }
    const schema = parts[parts.length - 2].toLowerCase();
    const database = parts[parts.length - 3].toLowerCase();
    if (schemas.has(schema)) {
        return { catalog: schema, name: parts[parts.length - 1] };
    }
    if (schemas.has(database)) {
        return { catalog: database, name: parts[parts.length - 2] };
    }
    return undefined;
}

/**
 * True when a qualified name points at an engine catalog (MySQL information_schema,
 * SQL Server sys / INFORMATION_SCHEMA, PostgreSQL pg_catalog). Bare names like TABLES are not assumed.
 */
export function isSystemCatalogTable(reference: string, engine: string): boolean {
    return splitSystemCatalogRef(reference, engine) !== undefined;
}

function knownObject(catalog: string, name: string, engine: string): KnownObject | undefined {
    const key = name.toLowerCase();
    if (engine === 'mssql' && catalog === 'sys') {
        const summary = MSSQL_SYS_OBJECTS[key];
        if (!summary) {
            return undefined;
        }
        return {
            engines: new Set(['mssql']),
            catalogs: new Set(['sys']),
            summary,
            kind: 'view'
        };
    }
    if (engine === 'postgres' && catalog === 'pg_catalog') {
        const summary = POSTGRES_CATALOG_OBJECTS[key];
        if (!summary) {
            return undefined;
        }
        return {
            engines: new Set(['postgres']),
            catalogs: new Set(['pg_catalog']),
            summary,
            kind: 'view'
        };
    }
    const found = KNOWN_OBJECTS[key];
    if (!found || !found.engines.has(engine) || !found.catalogs.has(catalog)) {
        return undefined;
    }
    if (engine === 'mssql' && key === 'tables') {
        return { ...found, columns: ANSI_TABLES_COLUMNS };
    }
    return found;
}

/** Hover text for a system catalog table or view. */
export function systemCatalogHoverMarkdown(reference: string, engine: string): string | undefined {
    const split = splitSystemCatalogRef(reference, engine);
    if (!split) {
        return undefined;
    }
    const known = knownObject(split.catalog, split.name, engine);
    const title = `${split.catalog}.${split.name}`;
    const kind = known?.kind === 'table' ? 'system table' : 'system view';
    const lines = [
        `**${title}** (${engineLabel(engine)} ${kind})`,
        '',
        known?.summary ?? catalogNote(engine, split.catalog)
    ];
    if (known?.columns && known.columns.length > 0) {
        lines.push(
            '',
            '| Column | Type |',
            '| --- | --- |'
        );
        for (const column of known.columns) {
            lines.push(`| \`${column.name}\` | ${column.type} |`);
        }
        lines.push('', '_Common columns. This catalog is not in the BiSql schema cache._');
    } else {
        lines.push('', '_This catalog is not in the BiSql schema cache._');
    }
    return lines.join('\n');
}

/** Hover text for a column on a system catalog object, when we know it. */
export function systemCatalogColumnHoverMarkdown(
    tableReference: string,
    columnName: string,
    engine: string
): string | undefined {
    const split = splitSystemCatalogRef(tableReference, engine);
    if (!split) {
        return undefined;
    }
    const known = knownObject(split.catalog, split.name, engine);
    const column = known?.columns?.find(
        (entry) => entry.name.toLowerCase() === columnName.toLowerCase()
    );
    const title = `${split.catalog}.${split.name}.${columnName}`;
    if (column) {
        return [`**${title}**`, '', `\`${column.type}\``, '', 'System catalog column.'].join('\n');
    }
    if (known?.columns) {
        return undefined;
    }
    if (known || isSystemCatalogTable(tableReference, engine)) {
        return [
            `**${title}**`,
            '',
            `Column on a ${engineLabel(engine)} system view.`,
            '',
            '_This catalog is not in the BiSql schema cache._'
        ].join('\n');
    }
    return undefined;
}
