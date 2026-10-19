'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-query-history-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/sql/queryHistory.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'queryHistory.js')
});

const { rememberQuery, normalizeQueryHistory, historyPickLabel } = require(path.join(
    outDir,
    'queryHistory.js'
));

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

const first = { sql: 'select 1', at: 1, connectionId: 'a' };
const second = { sql: 'select 2', at: 2, connectionId: 'a' };

const added = rememberQuery([], first, 100);
assert('stores a query', added.length, 1);
assert('keeps the sql', added[0].sql, 'select 1');

const again = rememberQuery(added, { sql: '  select 1  ', at: 3, connectionId: 'b' }, 100);
assert('same sql moves to the front', again.length, 1);
assert('rerun updates the time', again[0].at, 3);
assert('rerun updates the connection', again[0].connectionId, 'b');

const two = rememberQuery(again, second, 100);
assert('newer query is first', two[0].sql, 'select 2');
assert('older query stays', two[1].sql, 'select 1');

const capped = rememberQuery(two, { sql: 'select 3', at: 4, connectionId: 'a' }, 2);
assert('limit drops the oldest', capped.length, 2);
assert('oldest sql is gone', capped.some((item) => item.sql === 'select 1'), false);

const frozen = rememberQuery(two, { sql: 'select 9', at: 9, connectionId: 'a' }, 0);
assert('limit 0 does not record', frozen, two);

const blank = rememberQuery(two, { sql: '   ', at: 9, connectionId: 'a' }, 100);
assert('blank sql is ignored', blank, two);

const huge = rememberQuery(two, { sql: 'x'.repeat(20_001), at: 9, connectionId: 'a' }, 100);
assert('very long sql is ignored', huge, two);

const dirty = normalizeQueryHistory([
    first,
    { sql: '  select 4  ', at: 'nope', connectionId: 1 },
    { nope: true },
    null,
    { sql: '   ' }
]);
assert('drops bad rows', dirty.length, 2);
assert('trims stored sql', dirty[1].sql, 'select 4');
assert('bad time becomes 0', dirty[1].at, 0);
assert('bad connection becomes empty', dirty[1].connectionId, '');

assert('short label stays', historyPickLabel('select 1'), 'select 1');
assert(
    'long label is cut',
    historyPickLabel('select ' + 'a'.repeat(100)),
    (label) => label.endsWith('…') && label.length === 78
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All query history tests passed.');
