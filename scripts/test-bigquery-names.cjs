'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-bq-names-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const bqStub = path.join(outDir, 'bq-stub.js');
fs.writeFileSync(bqStub, 'module.exports = { BigQuery: class BigQuery {} };\n');
const authStub = path.join(outDir, 'auth-stub.js');
fs.writeFileSync(authStub, 'module.exports = { GoogleAuth: class GoogleAuth {} };\n');

function bundle(entry, outfile, alias = {}) {
    esbuild.buildSync({
        entryPoints: [path.join(root, entry)],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: path.join(outDir, outfile),
        alias
    });
    return require(path.join(outDir, outfile));
}

const { quoteIdent } = bundle('src/sql/functions.ts', 'functions.js');
const { alreadyHasDatabase, formatQualifiedTable } = bundle(
    'src/sql/qualifyTables.ts',
    'qualifyTables.js'
);
const { dialectForEngine } = bundle('src/sql/formatEmbeddedSql.ts', 'formatEmbeddedSql.js');
const { defaultSchemaForEngine } = bundle('src/db/engines.ts', 'engines.js');
const {
    parseBigqueryDatasetRef,
    formatBigqueryDatasetRef,
    listProjectFromSearch,
    bigqueryLookupDefaults,
    formatBigqueryAuthError,
    retargetBigqueryHome
} = bundle('src/db/bigquery.ts', 'bigquery.js', {
    '@google-cloud/bigquery': bqStub,
    'google-auth-library': authStub
});

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : actual === check;
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', JSON.stringify(actual));
        console.error(
            ' expect:',
            typeof check === 'function' ? check.toString() : JSON.stringify(check)
        );
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

assert('quoteIdent wraps a dashed project id', quoteIdent('my-proj', 'bigquery'), '`my-proj`');
assert(
    'three-part name wraps the whole path',
    quoteIdent('my-proj.ds.tbl', 'bigquery'),
    '`my-proj.ds.tbl`'
);
assert('two-part dataset.table stays unquoted', quoteIdent('ds.tbl', 'bigquery'), 'ds.tbl');
assert('simple table name stays unquoted', quoteIdent('events', 'bigquery'), 'events');
assert('alreadyHasDatabase two-part', alreadyHasDatabase('ds.tbl', 'bigquery'), true);
assert('alreadyHasDatabase bare name', alreadyHasDatabase('events', 'bigquery'), false);
assert(
    'formatQualifiedTable wraps dashed project path',
    formatQualifiedTable(
        { database: 'my-proj', schema: 'ds', name: 'tbl' },
        'bigquery'
    ),
    '`my-proj.ds.tbl`'
);
assert('dialectForEngine', dialectForEngine('bigquery'), 'bigquery');
assert('defaultSchemaForEngine', defaultSchemaForEngine('bigquery'), undefined);
assert('mysql still uses dbo fallback only for mssql', defaultSchemaForEngine('mssql'), 'dbo');
assert(
    'bare dataset uses home project',
    parseBigqueryDatasetRef('analytics', 'home-proj'),
    (ref) => ref && ref.project === 'home-proj' && ref.dataset === 'analytics'
);
assert(
    'project.dataset keeps the other project',
    parseBigqueryDatasetRef('other-proj.raw', 'home-proj'),
    (ref) => ref && ref.project === 'other-proj' && ref.dataset === 'raw'
);
assert(
    'home dataset stores as a bare name',
    formatBigqueryDatasetRef({ project: 'home-proj', dataset: 'analytics' }, 'home-proj'),
    'analytics'
);
assert(
    'extra dataset stores as project.dataset',
    formatBigqueryDatasetRef({ project: 'other-proj', dataset: 'raw' }, 'home-proj'),
    'other-proj.raw'
);
assert(
    'search other-project. lists that project',
    listProjectFromSearch('other-proj.', 'home-proj'),
    'other-proj'
);
assert(
    'empty search lists the home project',
    listProjectFromSearch('', 'home-proj'),
    'home-proj'
);
assert(
    'lookup defaults for extra default dataset',
    bigqueryLookupDefaults('home-proj', 'other-proj.raw'),
    (hit) => hit.database === 'other-proj' && hit.schema === 'raw'
);
assert(
    'resource manager error points at the API',
    formatBigqueryAuthError(new Error('Cloud Resource Manager API has not been used in project x')),
    (text) =>
        typeof text === 'string' &&
        text.includes('Enable the Cloud Resource Manager API')
);
assert(
    'retarget turns old home datasets into extras',
    retargetBigqueryHome(['analytics', 'other-proj.raw'], 'analytics', 'home-proj', 'new-proj'),
    (hit) =>
        hit.database === 'home-proj.analytics' &&
        hit.databases[0] === 'home-proj.analytics' &&
        hit.databases[1] === 'other-proj.raw'
);
assert(
    'retarget makes the new home dataset a bare name',
    retargetBigqueryHome(['analytics', 'new-proj.raw'], 'analytics', 'home-proj', 'new-proj'),
    (hit) => hit.databases.includes('raw') && hit.databases.includes('home-proj.analytics')
);
assert(
    'retarget with no old home keeps bare names',
    retargetBigqueryHome(['analytics'], 'analytics', '', 'new-proj'),
    (hit) => hit.database === 'analytics' && hit.databases[0] === 'analytics'
);

if (process.exitCode) {
    process.exit(1);
}
console.log('All BigQuery name tests passed.');
