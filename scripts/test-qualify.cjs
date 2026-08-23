'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-qualify-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const tsc = spawnSync(
    path.join(root, 'node_modules', '.bin', 'tsc'),
    [
        '--pretty',
        'false',
        '--module',
        'commonjs',
        '--target',
        'ES2022',
        '--strict',
        '--esModuleInterop',
        '--skipLibCheck',
        '--outDir',
        outDir,
        path.join(root, 'src/sql/qualifyTables.ts'),
        path.join(root, 'src/sql/functions.ts')
    ],
    { encoding: 'utf8' }
);
if (tsc.status !== 0) {
    console.error(tsc.stdout);
    console.error(tsc.stderr);
    process.exit(1);
}

const {
    qualifierForRef,
    qualifyCrossDatabaseSql
} = require(path.join(outDir, 'qualifyTables.js'));

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

const otherUsers = { database: 'auth', schema: 'auth', name: 'users' };
const defaultUsers = { database: 'datalign_dev', schema: 'datalign_dev', name: 'users' };

assert(
    'qualifies bare table in another MySQL database',
    qualifierForRef('users', otherUsers, 'mysql', 'datalign_dev'),
    'auth.users'
);

assert(
    'does not qualify table that lives in the default database',
    qualifierForRef('users', defaultUsers, 'mysql', 'datalign_dev'),
    undefined
);

assert(
    'does not qualify an already-qualified MySQL name',
    qualifierForRef('auth.users', otherUsers, 'mysql', 'datalign_dev'),
    undefined
);

assert(
    'does not qualify a CTE name',
    qualifierForRef('users', otherUsers, 'mysql', 'datalign_dev', new Set(['users'])),
    undefined
);

assert(
    'qualifies schema.table on MSSQL when catalog differs',
    qualifierForRef('dbo.Users', { database: 'OtherDb', schema: 'dbo', name: 'Users' }, 'mssql', 'AppDb'),
    'OtherDb.dbo.Users'
);

const sample = `SELECT users.*
        FROM users
        WHERE users.username = NULL
        AND users.bind_key = NULL`;
const fromMatch = /FROM\s+users\b/.exec(sample);
if (!fromMatch) {
    throw new Error('test setup: FROM users not found');
}
const start = fromMatch.index + fromMatch[0].length - 'users'.length;
const rewritten = qualifyCrossDatabaseSql(
    sample,
    [{ table: 'users', start, end: start + 'users'.length }],
    () => otherUsers,
    'mysql',
    'datalign_dev'
);
assert(
    'rewrites FROM users in the sample query',
    rewritten,
    (sql) => sql.includes('FROM auth.users') && sql.includes('SELECT users.*')
);
assert(
    'does not rewrite column qualifiers in the sample query',
    rewritten,
    (sql) => sql.includes('users.username') && sql.includes('users.bind_key')
);

const unchanged = qualifyCrossDatabaseSql(
    sample,
    [{ table: 'users', start, end: start + 'users'.length }],
    () => defaultUsers,
    'mysql',
    'datalign_dev'
);
assert('leaves default-database tables unchanged', unchanged, sample);

if (process.exitCode) {
    process.exit(1);
}
console.log('All qualify tests passed.');
