'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-postgres-url-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/db/postgresUrl.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'postgresUrl.js')
});

const {
    parsePostgresUrl,
    isSupabaseHost,
    isDirectSupabaseHost
} = require(path.join(outDir, 'postgresUrl.js'));

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

assert('empty', parsePostgresUrl('  '), (r) => !r.ok && r.kind === 'empty');
assert('mysql scheme', parsePostgresUrl('mysql://root@localhost/app'), (r) => !r.ok && r.kind === 'mysql');
assert('not postgres', parsePostgresUrl('https://example.com/db'), (r) => !r.ok && r.kind === 'not-postgres');

const session = parsePostgresUrl(
    'postgresql://postgres.abc:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require'
);
assert('session pooler ok', session, (r) => r.ok && r.value.host === 'aws-0-us-east-1.pooler.supabase.com');
assert('session user', session, (r) => r.ok && r.value.user === 'postgres.abc');
assert('encoded password', session, (r) => r.ok && r.value.password === 'p@ss');
assert('session port', session, (r) => r.ok && r.value.port === 5432);
assert('session database', session, (r) => r.ok && r.value.database === 'postgres');
assert('sslmode require', session, (r) => r.ok && r.value.sslMode === 'require');
assert('require skips cert check', session, (r) => r.ok && r.value.trustServerCertificate === true);

const trust = parsePostgresUrl('postgres://u@h/db?trustServerCertificate=true');
assert('trust query true', trust, (r) => r.ok && r.value.trustServerCertificate === true);

const requireVerify = parsePostgresUrl(
    'postgres://u@h/db?sslmode=require&trustServerCertificate=false'
);
assert('require can opt into verify', requireVerify, (r) => r.ok && r.value.trustServerCertificate === false);

const verify = parsePostgresUrl('postgres://u:pw@db.abc.supabase.co:6543/app?sslmode=verify-full');
assert('verify-full', verify, (r) => r.ok && r.value.sslMode === 'verify-full');
assert('verify-full checks cert', verify, (r) => r.ok && r.value.trustServerCertificate === false);
assert('transaction port', verify, (r) => r.ok && r.value.port === 6543);

const disable = parsePostgresUrl('postgres://u@localhost/db?sslmode=disable');
assert('default port', disable, (r) => r.ok && r.value.port === 5432);
assert('ssl disable', disable, (r) => r.ok && r.value.sslMode === 'disable');
assert('empty password', disable, (r) => r.ok && r.value.password === '');

assert('supabase host', isSupabaseHost('aws-0-eu.pooler.supabase.com'), true);
assert('not supabase host', isSupabaseHost('localhost'), false);
assert('direct host', isDirectSupabaseHost('db.abc.supabase.co'), true);
assert('pooler is not direct', isDirectSupabaseHost('aws-0-eu.pooler.supabase.com'), false);

if (process.exitCode) {
    process.exit(1);
}
console.log('All postgres URL tests passed.');
