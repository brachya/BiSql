'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-sql-blocks-source-${process.pid}`);
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

const { sqlBlocksInSource } = require(path.join(outDir, 'sqlExtractor.js'));

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

const sqlSource = 'SELECT 1 FROM a;\nSELECT 2 FROM b;\n';
const sqlBlocks = sqlBlocksInSource(sqlSource, true);
assert('sql file splits statements', sqlBlocks.length, 2);
assert(
    'sql first statement text',
    sqlBlocks[0].text.trim(),
    'SELECT 1 FROM a;'
);
assert(
    'sql second statement text',
    sqlBlocks[1].text.trim(),
    'SELECT 2 FROM b;'
);

const pythonSource = [
    'def load():',
    '    query = f"""',
    '        SELECT id',
    '        FROM missing_table',
    '    """',
    '    return query',
    ''
].join('\n');

const pyBlocks = sqlBlocksInSource(pythonSource, false);
assert('python f-string finds one block', pyBlocks.length, 1);
assert(
    'python block keeps FROM table',
    pyBlocks[0].originalText.includes('missing_table'),
    true
);

const table = 'missing_table';
const sqlOffset = pyBlocks[0].text.indexOf(table);
assert('missing_table is in analysis SQL', sqlOffset >= 0, true);
const range = pyBlocks[0].toDocRange(sqlOffset, sqlOffset + table.length);
const line = pythonSource.split('\n')[range.start.line];
assert('missing_table maps to the FROM line', range.start.line, 3);
assert(
    'missing_table range is the table name',
    line.slice(range.start.character, range.end.character),
    table
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All sqlBlocksInSource tests passed.');
