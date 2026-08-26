'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-parameters-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const vscodeStub = path.join(outDir, 'vscode.js');
fs.writeFileSync(
    vscodeStub,
    [
        'class Position { constructor(line, character) { this.line = line; this.character = character; } }',
        'class Range { constructor(start, end) { this.start = start; this.end = end; } }',
        'module.exports = { Position, Range };',
        ''
    ].join('\n')
);

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/sql/parameters.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'parameters.js'),
    alias: { vscode: vscodeStub }
});

const {
    uniquePlaceholderNames,
    applyPlaceholders,
    findPlaceholders,
    paramFieldsForSql
} = require(path.join(outDir, 'parameters.js'));

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

assert(
    'unique names keep first spelling',
    uniquePlaceholderNames('SELECT {Hours} FROM t WHERE x = {hours} AND y = {filter_clause}'),
    ['Hours', 'filter_clause']
);

assert(
    'skips ODBC date wrapper',
    uniquePlaceholderNames("SELECT {d '2020-01-01'}, {hours} FROM t"),
    ['hours']
);

assert(
    'skips ODBC {call} and {fn}',
    uniquePlaceholderNames('SELECT {fn GETDATE()}, {call} FROM t'),
    []
);

assert(
    'finds placeholder inside a SQL string',
    uniquePlaceholderNames("SELECT * FROM t WHERE ts > '{last_read_tstamp}' AND code = 'id-{n}'"),
    ['last_read_tstamp', 'n']
);

assert(
    'skips doubled braces',
    uniquePlaceholderNames('SELECT {{hours}} FROM t'),
    []
);

assert(
    'skips empty braces and {0}',
    uniquePlaceholderNames('SELECT {} FROM t WHERE id = {0}'),
    []
);

assert(
    'skips {foo.bar}',
    uniquePlaceholderNames('SELECT {foo.bar} FROM t'),
    []
);

assert(
    'ignores placeholders in comments',
    uniquePlaceholderNames('SELECT 1 -- {hours}\nFROM t /* {filter_clause} */'),
    []
);

const mixed = "SELECT {hours} FROM t WHERE ts > '{last_read_tstamp}' {filter_clause}";
assert(
    'pastes values including inside strings',
    applyPlaceholders(mixed, {
        hours: '24',
        last_read_tstamp: '2020-01-01',
        filter_clause: 'AND x = 1'
    }),
    "SELECT 24 FROM t WHERE ts > '2020-01-01' AND x = 1"
);

assert(
    'missing key stays as {name}',
    applyPlaceholders('SELECT {hours} FROM t', {}),
    'SELECT {hours} FROM t'
);

assert(
    'null pastes nothing',
    applyPlaceholders('SELECT {hours} FROM t {filter_clause}', { hours: null, filter_clause: null }),
    'SELECT  FROM t '
);

assert(
    'empty string pastes nothing',
    applyPlaceholders('SELECT 1 {filter_clause}', { filter_clause: '' }),
    'SELECT 1 '
);

assert(
    'param fields list placeholders before binds',
    paramFieldsForSql('SELECT {hours} FROM t WHERE id = :id'),
    [
        { name: 'hours', kind: 'placeholder' },
        { name: 'id', kind: 'bind' }
    ]
);

assert(
    'shared name is shown once as placeholder',
    paramFieldsForSql('SELECT {id} FROM t WHERE x = :id'),
    [{ name: 'id', kind: 'placeholder' }]
);

assert(
    'findPlaceholders reports spans in order',
    findPlaceholders('SELECT {a}, {b} FROM t').map((item) => item.name),
    ['a', 'b']
);

if (process.exitCode) {
    process.exit(1);
}
console.log('All parameter tests passed.');
