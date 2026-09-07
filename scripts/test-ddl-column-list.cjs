'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-ddl-column-list-${process.pid}`);
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
    tokenizeSql,
    collectTableRefs,
    isInsideDdlColumnList
} = require(path.join(outDir, 'sqlExtractor.js'));

function assert(name, actual, check) {
    const ok =
        typeof check === 'function'
            ? check(actual)
            : JSON.stringify(actual) === JSON.stringify(check);
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

function identIndexes(tokens, name) {
    return tokens
        .map((tok, i) => (tok.kind === 'ident' && tok.value.toLowerCase() === name.toLowerCase() ? i : -1))
        .filter((i) => i >= 0);
}

const createSql = `
create table reports_drive(
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    s3_key VARCAHR(500) NOT NULL UNIQUE,
    upload_tstamp TIMESTAMP NOT NULL,
    created_tstamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;
const createTokens = tokenizeSql(createSql);

assert(
    'CREATE TABLE does not collect the new table as a FROM ref',
    collectTableRefs(createSql, createTokens).refs.map((ref) => ref.table),
    []
);

assert(
    'INTEGER in CREATE TABLE is a type, not a column reference',
    identIndexes(createTokens, 'INTEGER').every((i) => isInsideDdlColumnList(createTokens, i)),
    true
);

assert(
    'column name id is also inside the definition list',
    identIndexes(createTokens, 'id').every((i) => isInsideDdlColumnList(createTokens, i)),
    true
);

const selectTokens = tokenizeSql('SELECT INTEGER FROM reports_drive');
assert(
    'INTEGER in a SELECT list is not a CREATE TABLE type',
    identIndexes(selectTokens, 'INTEGER').some((i) => isInsideDdlColumnList(selectTokens, i)),
    false
);

const ctas = tokenizeSql('CREATE TABLE t AS SELECT id FROM users');
assert(
    'CREATE TABLE AS SELECT still collects FROM tables',
    collectTableRefs('', ctas).refs.map((ref) => ref.table.toLowerCase()),
    ['users']
);
assert(
    'SELECT column in CTAS is not inside a DDL column list',
    identIndexes(ctas, 'id').some((i) => isInsideDdlColumnList(ctas, i)),
    false
);

const alterTokens = tokenizeSql('ALTER TABLE reports_drive ADD x INT');
assert(
    'ALTER TABLE still collects the existing table',
    collectTableRefs('', alterTokens).refs.map((ref) => ref.table.toLowerCase()),
    ['reports_drive']
);

const alterParen = tokenizeSql('ALTER TABLE reports_drive ADD (x INTEGER)');
assert(
    'INTEGER in ALTER TABLE ( … ) is a type',
    identIndexes(alterParen, 'INTEGER').every((i) => isInsideDdlColumnList(alterParen, i)),
    true
);

if (process.exitCode) {
    process.exit(1);
}
console.log('All DDL column-list tests passed.');
