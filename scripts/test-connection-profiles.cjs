'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-connection-profiles-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/db/connectionProfiles.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'connectionProfiles.js')
});

const {
    defaultConnectionName,
    sameLogin,
    migrateFromFlat,
    profileFromFlat,
    normalizeProfiles
} = require(path.join(outDir, 'connectionProfiles.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : JSON.stringify(actual) === JSON.stringify(check);
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', JSON.stringify(actual));
        console.error(' expect:', typeof check === 'function' ? check.toString() : JSON.stringify(check));
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

const mysqlFlat = {
    loginKind: 'mysql',
    engine: 'mysql',
    server: 'db.example.com',
    database: 'app',
    databases: ['app'],
    user: 'readonly',
    port: 3306,
    encrypt: true,
    trustServerCertificate: false
};

const pgFlat = {
    loginKind: 'postgres',
    engine: 'postgres',
    server: 'localhost',
    database: 'postgres',
    databases: ['postgres'],
    user: 'postgres',
    port: 5432,
    encrypt: false,
    trustServerCertificate: true
};

assert('default mysql name', defaultConnectionName(mysqlFlat), 'MySQL · db.example.com');
assert('default supabase name', defaultConnectionName({ loginKind: 'supabase', server: 'aws-0.pooler.supabase.com' }), 'Supabase · aws-0.pooler.supabase.com');
assert('same login', sameLogin(mysqlFlat, { ...mysqlFlat }), true);
assert('different host', sameLogin(mysqlFlat, { ...mysqlFlat, server: 'other' }), false);

let n = 0;
const ids = () => 'id' + ++n;

const skip = migrateFromFlat(
    {
        existingProfiles: [profileFromFlat(mysqlFlat, 'keep')],
        existingActiveId: 'keep',
        effective: mysqlFlat
    },
    ids
);
assert('skip when list exists', skip.ran, false);
assert('skip keeps id', skip.profiles[0].id, 'keep');

n = 0;
const globalOnly = migrateFromFlat(
    { existingProfiles: [], global: mysqlFlat, effective: mysqlFlat },
    ids
);
assert('global only ran', globalOnly.ran, true);
assert('global only one profile', globalOnly.profiles.length, 1);
assert('global only active', globalOnly.activeId, 'id1');
assert('global only password slot', globalOnly.globalId, 'id1');

n = 0;
const both = migrateFromFlat(
    { existingProfiles: [], global: mysqlFlat, workspace: pgFlat, effective: pgFlat },
    ids
);
assert('two logins', both.profiles.length, 2);
assert('workspace is active', both.activeId, both.workspaceId);
assert('global id kept', both.globalId, 'id1');

n = 0;
const same = migrateFromFlat(
    { existingProfiles: [], global: mysqlFlat, workspace: mysqlFlat, effective: mysqlFlat },
    ids
);
assert('same login is one profile', same.profiles.length, 1);
assert('no extra workspace id', same.workspaceId, undefined);

n = 0;
const empty = migrateFromFlat(
    {
        existingProfiles: [],
        effective: { ...mysqlFlat, server: '', database: '' }
    },
    ids
);
assert('empty does not run', empty.ran, false);

assert(
    'normalize drops bad rows',
    normalizeProfiles([{ id: 'ok', ...mysqlFlat }, { server: 'x' }, null]).map((p) => p.id),
    ['ok']
);

if (process.exitCode) {
    process.exit(1);
}
console.log('All connection profile tests passed.');
