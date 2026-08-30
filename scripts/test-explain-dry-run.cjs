'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-explain-dry-run-${process.pid}`);
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
    entryPoints: [path.join(root, 'src/parser/sqlExtractor.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'sqlExtractor.js'),
    alias: { vscode: vscodeStub }
});

const {
    firstSqlKeyword,
    isExplainableStatement,
    splitSqlStatements,
    statementAtOffset,
    statementsForExplainDryRun
} = require(path.join(outDir, 'sqlExtractor.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : JSON.stringify(actual) === JSON.stringify(check);
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

const sample = [
    'CREATE TABLE t (id int);',
    'INSERT INTO t SELECT 1;',
    '-- ignore me',
    'SELECT * FROM t;'
].join('\n');

const adjacent = [
    'select * from categories;',
    'INSERT INTO',
    '    datalign_pcc.categories (',
    '        SELECT * FROM datalign_dev.categories WHERE id = 14',
    '    );'
].join('\n');

assert('sample first keyword is create', firstSqlKeyword(sample), 'create');
assert('create table is not mysql-explainable', isExplainableStatement(sample, 'mysql'), false);

const slices = splitSqlStatements(sample);
assert('sample splits into 3 statements', slices.length, 3);
assert(
    'first slice is create table',
    firstSqlKeyword(slices[0].text),
    'create'
);
assert(
    'second slice is insert',
    firstSqlKeyword(slices[1].text),
    'insert'
);
assert(
    'third slice is select (comment is ignored)',
    firstSqlKeyword(slices[2].text),
    'select'
);

const plan = statementsForExplainDryRun(sample, 'mysql');
assert('sample dry-run kind is run', plan.kind, 'run');
assert('sample dry-run skips create', plan.kind === 'run' && plan.statements.length, 2);
assert(
    'sample dry-run keeps insert then select',
    plan.kind === 'run' && plan.statements.map(firstSqlKeyword),
    ['insert', 'select']
);

const wrapped = `EXPLAIN ${sample}`;
assert(
    'old dry-run wrapped the whole file at CREATE',
    wrapped.startsWith('EXPLAIN CREATE TABLE'),
    true
);

assert(
    'create table like is skipped',
    statementsForExplainDryRun(
        'CREATE TABLE datalign_ghma.categories LIKE datalign_dev.categories;',
        'mysql'
    ).kind,
    'skipped'
);

assert(
    'select is explained',
    statementsForExplainDryRun('select * from datalign_ghma.categories;', 'mysql').kind,
    'run'
);

assert(
    'insert select is explained',
    statementsForExplainDryRun(
        'INSERT INTO datalign_ghma.categories SELECT * FROM datalign_pcc.categories;',
        'mysql'
    ).kind,
    'run'
);

assert(
    'use is skipped as session',
    statementsForExplainDryRun('USE datalign_ghma;', 'mysql'),
    (actual) =>
        actual.kind === 'skipped' &&
        /session\/transaction/i.test(actual.reason)
);

assert(
    'comment before create is still skipped',
    statementsForExplainDryRun('-- copy schema\nCREATE TABLE t LIKE u;', 'mysql').kind,
    'skipped'
);

assert(
    'cte select is explained',
    statementsForExplainDryRun(
        'WITH x AS (SELECT 1 AS n) SELECT * FROM x;',
        'mysql'
    ).kind,
    'run'
);

assert('empty comments only', statementsForExplainDryRun('-- just a comment\n', 'mysql').kind, 'empty');

const adjacentSlices = splitSqlStatements(adjacent);
assert('adjacent file splits select then insert', adjacentSlices.map((slice) => firstSqlKeyword(slice.text)), [
    'select',
    'insert'
]);

const selectLine = 'select * from categories;';
const selectAt = adjacent.indexOf(selectLine);
assert(
    'caret in the select runs the select',
    firstSqlKeyword(statementAtOffset(adjacent, selectAt + 10).text),
    'select'
);
assert(
    'caret on the semicolon still runs the select',
    firstSqlKeyword(statementAtOffset(adjacent, selectAt + selectLine.length - 1).text),
    'select'
);
assert(
    'end of the select line still runs the select, not the insert',
    firstSqlKeyword(statementAtOffset(adjacent, selectAt + selectLine.length).text),
    'select'
);
assert(
    'caret on INSERT runs the insert',
    firstSqlKeyword(statementAtOffset(adjacent, adjacent.indexOf('INSERT INTO')).text),
    'insert'
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
