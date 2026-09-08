'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-switch-connection-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/commands/switchConnectionPicks.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'switchConnection.js')
});

const {
    EDIT_CONNECTIONS_ID,
    connectionSwitchDetail,
    connectionSwitchPicks
} = require(path.join(outDir, 'switchConnection.js'));

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

const home = {
    id: 'a',
    name: 'Prod',
    loginKind: 'bigquery',
    server: 'my-gcp-project',
    database: 'analytics'
};
const empty = {
    id: 'b',
    name: 'Draft',
    loginKind: 'mssql',
    server: '',
    database: ''
};

assert(
    'filled BigQuery detail',
    connectionSwitchDetail(home),
    'BigQuery · my-gcp-project / analytics'
);
assert('empty login detail', connectionSwitchDetail(empty), 'SQL Server · not filled in');
assert(
    'host only',
    connectionSwitchDetail({ ...home, database: '' }),
    'BigQuery · my-gcp-project'
);

const picks = connectionSwitchPicks([home, empty], 'a');
assert('edit row is last', picks[picks.length - 1].id, EDIT_CONNECTIONS_ID);
assert('marks the active login', picks[0].picked, true);
assert('does not mark the other login', picks[1].picked, false);
assert('active label is the connection name', picks[0].label, 'Prod');

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All switch-connection tests passed.');
