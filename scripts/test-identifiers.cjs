'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-identifiers-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/sql/identifiers.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'identifiers.js')
});

const { unquoteIdentifier, splitIdentifier } = require(path.join(outDir, 'identifiers.js'));

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

assert('bare name', unquoteIdentifier('Users'), 'Users');
assert('brackets', unquoteIdentifier('[Users]'), 'Users');
assert('escaped bracket', unquoteIdentifier('[User]]s]'), 'User]s');
assert('double quotes', unquoteIdentifier('"Users"'), 'Users');
assert('escaped quotes', unquoteIdentifier('"User""s"'), 'User"s');
assert('backticks', unquoteIdentifier('`Users`'), 'Users');
assert('escaped backticks', unquoteIdentifier('`User``s`'), 'User`s');
assert('split dotted', splitIdentifier('dbo.Users'), ['dbo', 'Users']);
assert('split bracketed', splitIdentifier('[dbo].[Users]'), ['dbo', 'Users']);
assert('split backticks', splitIdentifier('`db`.`users`'), ['db', 'users']);
assert('split three-part', splitIdentifier('db.dbo.Users'), ['db', 'dbo', 'Users']);

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/parser/selectList.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'selectList.js')
});
esbuild.buildSync({
    entryPoints: [path.join(root, 'src/parser/sqlTokens.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'sqlTokens.js')
});

const { parseSelectItems, collectEditSelectItems } = require(path.join(outDir, 'selectList.js'));
const { tokenizeSql } = require(path.join(outDir, 'sqlTokens.js'));

assert(
    'select list columns',
    parseSelectItems(tokenizeSql('SELECT id, name FROM users')),
    [
        { kind: 'column', name: 'id' },
        { kind: 'column', name: 'name' }
    ]
);
assert(
    'edit select list strips alias on expression',
    collectEditSelectItems('SELECT id + 1 AS x FROM users'),
    [{ kind: 'expression' }]
);
assert(
    'edit select list maps dotted column',
    collectEditSelectItems('SELECT u.id FROM users u'),
    [{ kind: 'column', column: 'id', qualifier: 'u' }]
);
assert(
    'trailing decimal stays a number',
    tokenizeSql('SELECT 1. FROM t').map((tok) => `${tok.kind}:${tok.text}`),
    ['keyword:SELECT', 'number:1.', 'keyword:FROM', 'ident:t']
);
assert(
    'dot before a name is a qualifier, not a decimal',
    tokenizeSql('123.ds').map((tok) => `${tok.kind}:${tok.text}`),
    ['number:123', 'punct:.', 'ident:ds']
);

