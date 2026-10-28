'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-result-edit-${process.pid}`);
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
    entryPoints: [path.join(root, 'src/sql/resultEdit.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'resultEdit.js'),
    alias: { vscode: vscodeStub }
});

const { buildInsertSql, NULL_DISPLAY } = require(path.join(outDir, 'resultEdit.js'));

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

function column(name, extra) {
    return {
        displayName: name,
        sourceColumn: name,
        canEdit: true,
        canSetNull: false,
        canRename: true,
        isPrimaryKey: false,
        isIdentity: false,
        isComputed: false,
        isNullable: false,
        typeName: 'varchar',
        typeDisplay: 'varchar(64)',
        ...extra
    };
}

const plan = {
    editable: true,
    reason: '',
    tableDisplay: 'app.users',
    table: {
        database: 'app',
        schema: 'app',
        name: 'users',
        fullName: 'app.users',
        qualifiedName: 'app.users',
        isView: false,
        columns: [],
        columnsByLower: new Map(),
        foreignKeys: []
    },
    engine: 'mysql',
    columns: [
        column('id', { isPrimaryKey: true, isIdentity: true, canEdit: false, typeName: 'int', typeDisplay: 'int' }),
        column('user_username'),
        column('note', { isNullable: true, canSetNull: true, typeDisplay: 'varchar(255)' })
    ],
    pkIndexes: [0]
};

const copied = buildInsertSql(plan, ['7', 'cbstepen-dev2', NULL_DISPLAY]);
assert(
    'duplicate insert keeps the edited username and skips the auto id',
    copied,
    (sql) =>
        sql.sql === 'INSERT INTO app.users (user_username, note) VALUES (:i0, :i1)' &&
        sql.params.i0 === 'cbstepen-dev2' &&
        sql.params.i1 === null &&
        !sql.sql.includes('id')
);
assert(
    'a missing required value is rejected before insert',
    buildInsertSql(plan, ['7', NULL_DISPLAY, 'x']),
    (result) => result.error === "Column 'user_username' is required."
);
assert(
    'an explicit empty string is inserted',
    buildInsertSql(plan, ['7', 'name', '']),
    (sql) =>
        sql.sql === 'INSERT INTO app.users (user_username, note) VALUES (:i0, :i1)' &&
        sql.params.i0 === 'name' &&
        sql.params.i1 === ''
);
assert(
    'a blank column is left out so the default can run',
    buildInsertSql(plan, ['7', 'name', ''], [2]),
    (sql) =>
        sql.sql === 'INSERT INTO app.users (user_username) VALUES (:i0)' &&
        sql.params.i0 === 'name' &&
        sql.params.i1 === undefined
);
assert(
    'a blank required column is left out instead of blocking the insert',
    buildInsertSql(plan, ['7', '', 'x'], [1]),
    (sql) => sql.sql === 'INSERT INTO app.users (note) VALUES (:i0)' && sql.params.i0 === 'x'
);
assert(
    'all blank values insert database defaults on mysql',
    buildInsertSql(plan, ['7', '', ''], [1, 2]),
    (sql) => sql.sql === 'INSERT INTO app.users () VALUES ()' && Object.keys(sql.params).length === 0
);
assert(
    'all blank values use DEFAULT VALUES on postgres',
    buildInsertSql({ ...plan, engine: 'postgres' }, ['7', '', ''], [1, 2]),
    (sql) => sql.sql === 'INSERT INTO app.users DEFAULT VALUES'
);
assert(
    'bigquery refuses a row of only defaults',
    buildInsertSql({ ...plan, engine: 'bigquery' }, ['7', '', ''], [1, 2]),
    (result) => typeof result.error === 'string' && result.error.indexOf('BigQuery') >= 0
);
assert(
    'a row with no insertable columns is rejected',
    buildInsertSql({ ...plan, columns: [plan.columns[0]] }, ['7']),
    (result) => result.error === 'No columns can be inserted for this row.'
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('ok');
