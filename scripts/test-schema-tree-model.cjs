'use strict';

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'scripts', '.tmp-schema-tree-model');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/db/explorerCatalog.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'explorerCatalog.js')
});

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/ui/schemaTreeModel.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'schemaTreeModel.js'),
    external: ['vscode']
});

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/ui/explorerDbFilter.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'explorerDbFilter.js'),
    external: ['vscode']
});

const {
    CATALOG_VERSION,
    emptyExplorerCache,
    mergeCatalogPatch,
    mergeExplorerCache,
    parseCatalogJson,
    uniqueNames
} = require(path.join(outDir, 'explorerCatalog.js'));

const {
    HINT_LABEL,
    addConnectionNode,
    columnChildren,
    connectionChildren,
    connectionNode,
    databaseChildren,
    nodePathToTable,
    objectChildren,
    projectDatasetNodes,
    projectNodes,
    schemaChildren,
    schemaMapGroupFromNode,
    schemaMapGroupKey,
    usesSchemaLevel,
    DB_TREE_GROUP_THRESHOLD,
    databaseTreeNodes,
    splitDatabaseGroupsForTree
} = require(path.join(outDir, 'schemaTreeModel.js'));

const { sidebarDatabaseNames } = require(path.join(outDir, 'explorerDbFilter.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : JSON.stringify(actual) === JSON.stringify(check);
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', JSON.stringify(actual));
        console.error(' expect:', typeof check === 'function' ? check.toString() : JSON.stringify(check));
        process.exitCode = 1;
        return;
    }
    console.log('PASS', name);
}

function table(partial) {
    const columns = partial.columns || [];
    const columnsByLower = new Map();
    for (const column of columns) {
        columnsByLower.set(column.name.toLowerCase(), column);
    }
    return {
        database: partial.database,
        schema: partial.schema,
        name: partial.name,
        fullName: partial.fullName || `${partial.schema}.${partial.name}`,
        qualifiedName: partial.qualifiedName,
        isView: !!partial.isView,
        columns,
        columnsByLower
    };
}

function column(name, extra) {
    return {
        name,
        ordinal: extra?.ordinal ?? 1,
        typeName: extra?.typeName || 'int',
        typeDisplay: extra?.typeDisplay || 'int',
        isNullable: extra?.isNullable === true,
        isIdentity: false,
        isComputed: false,
        isPrimaryKey: extra?.isPrimaryKey === true
    };
}

const mssqlProfile = {
    id: 'prod',
    name: 'Prod',
    loginKind: 'mssql',
    engine: 'mssql',
    server: 'sql.example.com',
    database: 'app',
    databases: ['app'],
    user: 'ro',
    port: 1433,
    encrypt: true,
    trustServerCertificate: false
};

const mysqlProfile = {
    ...mssqlProfile,
    id: 'mysql',
    name: 'MySQL',
    loginKind: 'mysql',
    engine: 'mysql',
    port: 3306
};

const bqProfile = {
    ...mssqlProfile,
    id: 'bq',
    name: 'BigQuery',
    loginKind: 'bigquery',
    engine: 'bigquery',
    server: 'home-proj',
    database: 'analytics',
    databases: ['analytics'],
    port: 443
};

assert('catalog version', CATALOG_VERSION, 2);
assert('unique names', uniqueNames(['App', 'app', ' other ', '']), ['App', 'other']);
assert('parse rejects bad version', parseCatalogJson({ version: 9, connectionKey: 'x' }), undefined);

const parsed = parseCatalogJson({
    version: 2,
    connectionKey: 'abc',
    fetchedAt: 10,
    databases: ['app', 'app'],
    projects: ['p1'],
    projectMeta: { 'p1': { fetchedAt: 10, datasets: ['ds1'] } }
});
assert('parse catalog', parsed, {
    version: 2,
    connectionKey: 'abc',
    fetchedAt: 10,
    databases: ['app'],
    projects: ['p1'],
    projectMeta: { p1: { fetchedAt: 10, datasets: ['ds1'] } }
});

const patched = mergeCatalogPatch(parsed, 'abc', { projects: ['p2'] }, 20);
assert('patch keeps databases', patched.databases, ['app']);
assert('patch replaces projects', patched.projects, ['p2']);

const users = table({
    database: 'app',
    schema: 'dbo',
    name: 'Users',
    qualifiedName: 'app.dbo.Users',
    columns: [column('Id', { isPrimaryKey: true }), column('Name', { typeDisplay: 'varchar(50)', isNullable: true, ordinal: 2 })]
});
const vActive = table({
    database: 'app',
    schema: 'dbo',
    name: 'v_active',
    qualifiedName: 'app.dbo.v_active',
    isView: true
});
const other = table({
    database: 'staging',
    schema: 'dbo',
    name: 'Jobs',
    qualifiedName: 'staging.dbo.Jobs'
});

const mssqlCache = mergeExplorerCache({
    tables: [users, vActive, other],
    fetchedAt: 1,
    stale: true
});

assert('mssql uses schema level', usesSchemaLevel('mssql'), true);
assert('mysql skips schema level', usesSchemaLevel('mysql'), false);

const mssqlRoot = connectionChildren(mssqlProfile, true, mssqlCache, { connectionState: 'connected' });
assert(
    'mssql children kinds',
    mssqlRoot.map((n) => n.kind),
    ['status', 'database', 'database']
);
assert('mssql db names', mssqlRoot.filter((n) => n.kind === 'database').map((n) => n.label), ['app', 'staging']);

const mssqlDbId = 'c:prod:d:app';
const schemas = databaseChildren(mssqlProfile, 'app', mssqlCache, true, mssqlDbId);
assert('mssql schema folder', schemas.map((n) => n.kind), ['schema']);
assert('mssql schema name', schemas[0].label, 'dbo');

const folders = schemaChildren(mssqlProfile, 'app', 'dbo', mssqlCache, true, schemas[0].id);
assert('mssql table/view folders', folders.map((n) => n.kind), ['tablesFolder', 'viewsFolder']);

const tablesFolderId = folders.find((n) => n.kind === 'tablesFolder').id;
const tables = objectChildren(mssqlProfile, 'app', 'dbo', false, mssqlCache, true, tablesFolderId);
assert('mssql tables', tables.map((n) => n.label), ['Users']);
assert('mssql table collapsible', tables[0].collapsible, true);

const cols = columnChildren(mssqlProfile, users, true, tables[0].id);
assert('column labels', cols.map((n) => n.label), ['Id', 'Name']);
assert('pk context', cols[0].contextValue, 'columnPK');

const mysqlUsers = table({
    database: 'shop',
    schema: 'shop',
    name: 'orders',
    fullName: 'shop.orders',
    qualifiedName: 'shop.orders'
});
const mysqlCache = mergeExplorerCache({ tables: [mysqlUsers], fetchedAt: 1, stale: false });
const mysqlKids = connectionChildren(mysqlProfile, true, mysqlCache, { connectionState: 'connected' });
assert('mysql one database', mysqlKids.filter((n) => n.kind === 'database').map((n) => n.label), ['shop']);
const mysqlFolders = databaseChildren(mysqlProfile, 'shop', mysqlCache, true, 'c:mysql:d:shop');
assert('mysql skips schema', mysqlFolders.map((n) => n.kind), ['tablesFolder']);

const bqTable = table({
    database: 'home-proj',
    schema: 'analytics',
    name: 'events',
    qualifiedName: 'home-proj.analytics.events'
});
const otherTable = table({
    database: 'other',
    schema: 'analytics',
    name: 'jobs',
    qualifiedName: 'other.analytics.jobs'
});
const bqCache = mergeExplorerCache({
    tables: [bqTable, otherTable],
    fetchedAt: 1,
    stale: false,
    catalog: {
        version: 2,
        connectionKey: 'k',
        fetchedAt: 1,
        databases: [],
        projects: ['home-proj', 'other'],
        projectMeta: {
            'home-proj': { fetchedAt: 200, datasets: ['analytics'] },
            other: { fetchedAt: 100, datasets: ['other.analytics'] }
        }
    },
    cachedProjects: ['other'],
    homeProject: 'home-proj'
});
const bqKids = connectionChildren(bqProfile, true, bqCache, { connectionState: 'connected' });
assert(
    'bq has projects',
    bqKids.some((n) => n.kind === 'projects'),
    true
);
assert(
    'bq dataset label is schema',
    bqKids.filter((n) => n.kind === 'database').map((n) => n.label),
    ['analytics']
);
const bqProjectNodes = projectNodes(bqProfile, bqCache, true);
assert('bq project home', bqProjectNodes.find((n) => n.label === 'home-proj').description, 'Home');
assert('bq home is not a second dataset list', bqProjectNodes.find((n) => n.label === 'home-proj').collapsible, false);
assert('bq cached project collapsible', bqProjectNodes.find((n) => n.label === 'other').collapsible, true);
assert('bq other project is stale after a later home refresh', bqProjectNodes.find((n) => n.label === 'other').description, 'Cached · stale');
assert('bq home datasets are not repeated under the project', projectDatasetNodes(bqProfile, 'home-proj', bqCache, true), []);
assert(
    'bq other project lists its dataset',
    projectDatasetNodes(bqProfile, 'other', bqCache, true).map((n) => n.label),
    ['other.analytics']
);
assert(
    'reveal path for a home table stays on the connection',
    nodePathToTable(bqProfile, true, bqCache, bqTable.qualifiedName).map((n) => n.kind),
    ['connection', 'database', 'tablesFolder', 'table']
);
assert(
    'reveal path for another project goes through Projects',
    nodePathToTable(bqProfile, true, bqCache, otherTable.qualifiedName).map((n) => n.kind),
    ['connection', 'projects', 'project', 'database', 'tablesFolder', 'table']
);

const inactiveCached = connectionNode(mssqlProfile, false, mssqlCache);
assert('inactive with snapshot is cached', inactiveCached.description, 'Cached');
const inactiveKids = connectionChildren(mssqlProfile, false, mssqlCache);
assert(
    'inactive snapshot still has databases',
    inactiveKids.filter((n) => n.kind === 'database').length > 0,
    true
);
assert('inactive snapshot has no status', inactiveKids.some((n) => n.kind === 'status'), false);

const empty = emptyExplorerCache();
const emptyKids = connectionChildren(mssqlProfile, false, empty);
assert('inactive without snapshot is hint only', emptyKids.map((n) => n.kind), ['hint']);
assert('hint label', emptyKids[0].label, HINT_LABEL);

assert('add connection id', addConnectionNode().id, 'add');
assert('add context', addConnectionNode().contextValue, 'connectionAdd');

assert('group threshold', DB_TREE_GROUP_THRESHOLD, 50);
const shortGroups = splitDatabaseGroupsForTree(['a', 'b']);
assert('short list one group', shortGroups.length, 1);
const manyDbNames = [];
for (let i = 0; i < 55; i++) {
    manyDbNames.push('db_' + String(i).padStart(3, '0'));
}
const letterGroups = splitDatabaseGroupsForTree(manyDbNames);
assert('many dbs split into groups', letterGroups.length > 1, true);
const bigCache = mergeExplorerCache({
    tables: [users],
    fetchedAt: 1,
    stale: false,
    catalog: {
        version: CATALOG_VERSION,
        connectionKey: 'k',
        fetchedAt: 1,
        databases: manyDbNames,
        projects: [],
        projectMeta: {}
    }
});
const groupedKids = connectionChildren(mssqlProfile, true, bigCache, { connectionState: 'connected' });
assert(
    'large connection uses databaseGroup',
    groupedKids.some((n) => n.kind === 'databaseGroup'),
    true
);
const filteredKids = connectionChildren(mssqlProfile, true, mssqlCache, {
    connectionState: 'connected',
    sidebarDatabases: ['app']
});
assert(
    'sidebar filter limits databases',
    filteredKids.filter((n) => n.kind === 'database').map((n) => n.label),
    ['app']
);
assert(
    'sidebar filter keeps default',
    sidebarDatabaseNames('p1', 'app', ['app', 'staging', 'other'], { p1: ['staging'] }).sort(),
    ['app', 'staging'].sort()
);
const deepCache = mergeExplorerCache({
    tables: [
        table({
            database: 'db_050',
            schema: 'dbo',
            name: 'T',
            qualifiedName: 'db_050.dbo.T'
        })
    ],
    fetchedAt: 1,
    stale: false,
    catalog: {
        version: CATALOG_VERSION,
        connectionKey: 'k2',
        fetchedAt: 1,
        databases: manyDbNames,
        projects: [],
        projectMeta: {}
    }
});
const groupedPath = nodePathToTable(mssqlProfile, true, deepCache, 'db_050.dbo.T');
assert(
    'reveal path includes databaseGroup when list is large',
    groupedPath.some((n) => n.kind === 'databaseGroup'),
    true
);

assert(
    'bigquery map group is project.dataset',
    schemaMapGroupKey({ database: 'proj', schema: 'analytics' }, 'bigquery'),
    'proj.analytics'
);
assert(
    'postgres map group is the schema',
    schemaMapGroupKey({ database: 'app', schema: 'public' }, 'postgres'),
    'public'
);
assert(
    'home dataset node maps to project.dataset',
    schemaMapGroupFromNode(
        { database: 'analytics' },
        'bigquery',
        [{ database: 'proj', schema: 'analytics', qualifiedName: 'proj.analytics.users' }],
        'proj'
    ),
    'proj.analytics'
);
assert(
    'other project dataset node stays project.dataset',
    schemaMapGroupFromNode(
        { database: 'other.analytics' },
        'bigquery',
        [{ database: 'other', schema: 'analytics', qualifiedName: 'other.analytics.users' }],
        'proj'
    ),
    'other.analytics'
);

if (process.exitCode) {
    fs.rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
}
fs.rmSync(outDir, { recursive: true, force: true });
console.log('All explorer cache and tree model tests passed.');
