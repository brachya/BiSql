'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-synthetic-table-${process.pid}`);
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

const { extractSqlBlocksFromSource, hasSyntheticTablePlaceholder, SqlBlock } = require(
    path.join(outDir, 'sqlExtractor.js')
);

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

function pyQuery(sql, fString = true) {
    const prefix = fString ? 'f' : '';
    return `query = ${prefix}"""\n${sql}\n"""\n`;
}

function fromPython(source) {
    const blocks = extractSqlBlocksFromSource(source);
    if (blocks.length !== 1) {
        throw new Error(`expected 1 SQL block, got ${blocks.length} for:\n${source}`);
    }
    return blocks[0];
}

function tablePlaceholder(source) {
    const block = typeof source === 'string' && source.includes('"""') ? fromPython(source) : null;
    if (block) {
        return hasSyntheticTablePlaceholder(block.getTokens(), (offset) =>
            block.isSyntheticSqlOffset(offset)
        );
    }
    const sqlBlock = SqlBlock.fromText(source);
    return hasSyntheticTablePlaceholder(sqlBlock.getTokens(), (offset) =>
        sqlBlock.isSyntheticSqlOffset(offset)
    );
}

assert(
    'FROM {users_table} is a table placeholder',
    tablePlaceholder(pyQuery('select * from {users_table} limit 10')),
    true
);

assert(
    'WHERE {id} is a value, not a table',
    tablePlaceholder(pyQuery('select * from users where id = {user_id}')),
    false
);

assert(
    'JOIN {t} is a table placeholder',
    tablePlaceholder(pyQuery('select * from users join {roles} on users.role_id = roles.id')),
    true
);

assert(
    'INSERT INTO {t} is a table placeholder',
    tablePlaceholder(pyQuery('insert into {users_table} (id) values (1)')),
    true
);

assert(
    'UPDATE {t} SET is a table placeholder',
    tablePlaceholder(pyQuery('update {users_table} set name = {name}')),
    true
);

assert(
    'INSERT INTO real table with value placeholder is not skipped',
    tablePlaceholder(pyQuery('insert into users (id) values ({user_id})')),
    false
);

assert(
    'qualified schema.{table} is a table placeholder',
    tablePlaceholder(pyQuery('select * from app.{users_table}')),
    true
);

assert(
    'subquery FROM {t} is a table placeholder',
    tablePlaceholder(pyQuery('select * from users where id in (select id from {other})')),
    true
);

assert(
    'SELECT … FOR UPDATE is not a table placeholder',
    tablePlaceholder(pyQuery('select * from users where id = {user_id} for update')),
    false
);

assert(
    'ON DUPLICATE KEY UPDATE value is not a table placeholder',
    tablePlaceholder(
        pyQuery('insert into users (id, name) values (1, {name}) on duplicate key update name = {name}')
    ),
    false
);

assert(
    'plain SQL FROM NULL is not synthetic',
    tablePlaceholder('select * from NULL'),
    false
);

assert(
    'non-f-string FROM NULL in Python is not synthetic',
    tablePlaceholder(pyQuery('select * from NULL', false)),
    false
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All synthetic table placeholder tests passed.');
