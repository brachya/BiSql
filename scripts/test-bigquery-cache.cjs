'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-bq-cache-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const bqStub = path.join(outDir, 'bq-stub.js');
fs.writeFileSync(bqStub, 'module.exports = { BigQuery: class BigQuery {} };\n');

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/db/bigqueryCache.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'bigqueryCache.js'),
    alias: { '@google-cloud/bigquery': bqStub }
});

const {
    datasetCacheKey,
    datasetsForProjects,
    effectiveCachedProjects,
    mergeSchemaTables,
    tableBelongsToProject
} = require(path.join(outDir, 'bigqueryCache.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : JSON.stringify(actual) === JSON.stringify(check);
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', JSON.stringify(actual));
        process.exitCode = 1;
        return;
    }
    console.log('PASS', name);
}

const config = {
    server: 'home-proj',
    database: 'main_ds',
    databases: ['extra_ds', 'other-proj.analytics']
};

assert('effectiveCachedProjects includes home', effectiveCachedProjects('home-proj', ['other-proj']), [
    'home-proj',
    'other-proj'
]);

assert(
    'datasetsForProjects filters by project',
    datasetsForProjects(config, ['home-proj']),
    ['extra_ds', 'main_ds']
);

const existing = [
    {
        database: 'other-proj',
        schema: 'analytics',
        name: 'events',
        fullName: 'analytics.events',
        qualifiedName: 'other-proj.analytics.events',
        isView: false,
        columns: [],
        columnsByLower: new Map()
    }
];
const incoming = [
    {
        database: 'home-proj',
        schema: 'main_ds',
        name: 'users',
        fullName: 'main_ds.users',
        qualifiedName: 'home-proj.main_ds.users',
        isView: false,
        columns: [],
        columnsByLower: new Map()
    }
];

const merged = mergeSchemaTables(existing, incoming, ['home-proj']);
assert('merge keeps other project tables', merged.length, 2);
assert(
    'merge replaces same project only',
    merged.some((table) => table.qualifiedName === 'home-proj.main_ds.users'),
    true
);
assert(
    'tableBelongsToProject',
    tableBelongsToProject(existing[0], 'other-proj'),
    true
);

function bareTable(database, schema, name) {
    return {
        database,
        schema,
        name,
        fullName: schema + '.' + name,
        qualifiedName: database + '.' + schema + '.' + name,
        isView: false,
        columns: [],
        columnsByLower: new Map()
    };
}

const failed = new Set([datasetCacheKey('home-proj', 'main_ds')]);
const partial = mergeSchemaTables(
    [bareTable('home-proj', 'main_ds', 'users'), bareTable('home-proj', 'extra_ds', 'old')],
    [bareTable('home-proj', 'extra_ds', 'fresh')],
    ['home-proj'],
    failed
);
assert('failed dataset keeps old tables', partial.map((table) => table.name).sort(), ['fresh', 'users']);
assert(
    'successful dataset replaces old tables',
    partial.some((table) => table.name === 'old'),
    false
);

const cleared = mergeSchemaTables(
    [bareTable('home-proj', 'main_ds', 'users'), bareTable('other-proj', 'analytics', 'events')],
    [],
    ['other-proj']
);
assert(
    'refresh with no incoming tables drops that project',
    cleared.map((table) => table.qualifiedName),
    ['home-proj.main_ds.users']
);
