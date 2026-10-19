'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-cell-document-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/sql/cellDocument.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'cellDocument.js')
});

const { cellEditorText, cellFileName, cellPanelId, rowMatchingKeys } = require(path.join(outDir, 'cellDocument.js'));

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

function sameText(expected) {
    return (actual) => actual.language === expected.language && actual.text === expected.text;
}

assert('plain text', cellEditorText('hello'), sameText({ language: 'plaintext', text: 'hello' }));
assert('null display', cellEditorText('NULL'), sameText({ language: 'plaintext', text: 'NULL' }));
assert('number stays text', cellEditorText('42'), sameText({ language: 'plaintext', text: '42' }));

const pretty = cellEditorText(' {"a":1} ');
assert('object language', pretty.language, 'json');
assert('object text', pretty.text, '{\n  "a": 1\n}');

const list = cellEditorText('[1,2]');
assert('array language', list.language, 'json');
assert('array text', list.text, '[\n  1,\n  2\n]');

assert('broken json', cellEditorText('{nope}'), sameText({ language: 'plaintext', text: '{nope}' }));
assert(
    'create view opens as sql',
    cellEditorText('CREATE VIEW v AS select 1'),
    sameText({ language: 'sql', text: 'CREATE VIEW v AS select 1' })
);
assert(
    'a sentence that starts with select stays text',
    cellEditorText('select the best option'),
    sameText({ language: 'plaintext', text: 'select the best option' })
);

const big = cellEditorText('{"id":9007199254740993}');
assert('big integer language', big.language, 'json');
assert(
    'big integer is not rounded',
    big.text.includes('9007199254740993') && !big.text.includes('9007199254740992'),
    true
);
assert(
    'one decimal stays one decimal',
    cellEditorText('{"n":1.0}').text.includes('1.0'),
    true
);

assert('json name', cellFileName('payload', 12, 'json'), 'payload (row 12).json');
assert('text name', cellFileName('note', 3, 'plaintext'), 'note (row 3).txt');
assert('sql name', cellFileName('Create View', 1, 'sql'), 'Create View (row 1).sql');
assert('slash in name', cellFileName('a/b', 1, 'plaintext'), 'a_b (row 1).txt');
assert('blank name', cellFileName('  ', 1, 'plaintext'), 'cell (row 1).txt');
assert('panel id from cell path', cellPanelId('/3/payload (row 1).json'), 3);
assert('panel id missing', cellPanelId('/payload.json'), undefined);

const rows = [
    ['1', 'alpha', '{"a":1}'],
    ['2', 'beta', '{"b":2}']
];
const sourceColumns = ['id', 'name', 'payload'];
assert(
    'row match uses the key column, not its position guess',
    rowMatchingKeys(rows, sourceColumns, [{ sourceColumn: 'id', value: '2' }]),
    1
);
assert(
    'row match fails when the key column is gone',
    rowMatchingKeys(rows, ['name', 'payload'], [{ sourceColumn: 'id', value: '2' }]),
    -1
);
assert(
    'row match fails when that row is not on the page',
    rowMatchingKeys(rows, sourceColumns, [{ sourceColumn: 'id', value: '9' }]),
    -1
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
