'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-query-cells-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const vscodeStub = path.join(outDir, 'vscode.js');
fs.writeFileSync(
    vscodeStub,
    'class Position { constructor(line, character) { this.line = line; this.character = character; } }\n' +
        'class Range { constructor(start, end) { this.start = start; this.end = end; } }\n' +
        'module.exports = { Position, Range };\n'
);

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/db/queryCells.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'queryCells.js'),
    alias: { vscode: vscodeStub }
});

const {
    formatQueryCell,
    gridCellPreview,
    longCellWarning,
    MAX_STORED_CELL_CHARS
} = require(path.join(outDir, 'queryCells.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : actual === check;
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', JSON.stringify(actual).slice(0, 200));
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

const view = 'CREATE VIEW v AS select 1 ' + 'x'.repeat(5000);
assert('long create view is kept whole', formatQueryCell(view), view);

const note = 'n'.repeat(5000);
assert('long text that is not SQL is kept whole', formatQueryCell(note), note);
assert('short grid cell stays', gridCellPreview('abc'), 'abc');
const preview = gridCellPreview('x'.repeat(4001));
assert('long grid cell is cut for the webview', preview.length, 4001);
assert('long grid cell keeps the start', preview.startsWith('x'.repeat(4000)), true);

assert('short cells have no warning', longCellWarning([10, 4000]), undefined);
const warning = longCellWarning([10, 4001, 9000]);
assert(
    'long cells warn and say how to get the full value',
    typeof warning === 'string' &&
        warning.includes('2 cells are longer than 4000') &&
        warning.includes('9000') &&
        warning.includes('full value'),
    true
);

const huge = 'h'.repeat(MAX_STORED_CELL_CHARS + 25);
const stored = formatQueryCell(huge);
assert('huge cell is cut', stored.length, MAX_STORED_CELL_CHARS);
assert('huge cell keeps the start', stored.startsWith('h'.repeat(100)), true);
const cutWarning = longCellWarning([stored.length]);
assert(
    'cut cells do not promise the full value',
    typeof cutWarning === 'string' && cutWarning.includes('not loaded'),
    true
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All query cell tests passed.');
