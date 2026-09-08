'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-error-lines-${process.pid}`);
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
    entryPoints: [path.join(root, 'src/sql/errorLines.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'errorLines.js'),
    alias: { vscode: vscodeStub }
});

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/parser/sqlExtractor.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'sqlExtractor.js'),
    alias: { vscode: vscodeStub }
});

const {
    annotateSqlError,
    fileLineForQueryLine,
    newlinesBefore,
    parseQueryLineFromMessage,
    queryLineFromCharPosition,
    queryLineFromEngineError,
    queryLineInFullSql,
    shiftEngineLineRefs
} = require(path.join(outDir, 'errorLines.js'));
const { SqlBlock, extractSqlBlocksFromSource } = require(path.join(outDir, 'sqlExtractor.js'));

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

assert('mysql at line', parseQueryLineFromMessage("near 'FROM' at line 4"), 4);
assert('postgres LINE', parseQueryLineFromMessage('syntax error\nLINE 3: SELECT'), 3);
assert(
    'bigquery at [line:col]',
    parseQueryLineFromMessage('Syntax error: Unexpected identifier at [3:15]'),
    3
);
assert('ignores query line label', parseQueryLineFromMessage('at query line 3, file line 12'), undefined);
assert(
    'char position on second line',
    queryLineFromCharPosition('SELECT 1\nFROM nope', 11),
    2
);
assert(
    'engine error prefers postgres position',
    queryLineFromEngineError({ position: '11', message: 'syntax error' }, 'SELECT 1\nFROM nope'),
    2
);

const sqlFile = ['SELECT 1;', 'SELECT a', 'FROM missing;', ''].join('\n');
const second = SqlBlock.fromDocumentSlice(sqlFile, 'SELECT 1;\n'.length, sqlFile.length);
assert('sql file query line 1 is file line 2', fileLineForQueryLine(second, 1), 2);
assert('sql file query line 2 is file line 3', fileLineForQueryLine(second, 2), 3);
assert(
    'sql file rewrites at line',
    annotateSqlError("You have an error near 'FROM' at line 2", second),
    "You have an error near 'FROM' at query line 2, file line 3"
);
assert(
    'sql file appends when mssql has no line in the text',
    annotateSqlError("Incorrect syntax near 'FROM'.", second, 2),
    "Incorrect syntax near 'FROM'. (query line 2, file line 3)"
);
assert(
    'annotate is stable',
    annotateSqlError(annotateSqlError("near 'FROM' at line 2", second), second),
    "near 'FROM' at query line 2, file line 3"
);

const pySource = ['# skip', 'sql = """SELECT 1', 'FROM nope', '"""', ''].join('\n');
const pyBlocks = extractSqlBlocksFromSource(pySource);
assert('python sample has one SQL block', pyBlocks.length, 1);
assert('python query line 1 is file line 2', fileLineForQueryLine(pyBlocks[0], 1), 2);
assert('python query line 2 is file line 3', fileLineForQueryLine(pyBlocks[0], 2), 3);
assert(
    'python error shows both lines',
    annotateSqlError("syntax error at or near \"nope\"\nLINE 2: FROM nope", pyBlocks[0]),
    'syntax error at or near "nope"\nquery line 2, file line 3: FROM nope'
);

const batch = ['SELECT 1;', '', 'SELECT a', 'FROM missing'].join('\n');
const secondStart = 'SELECT 1;\n\n'.length;
assert('no extra lines at offset 0', newlinesBefore(batch, 0), 0);
assert('newlines before second statement', newlinesBefore(batch, secondStart), 2);
assert('second statement line 1 is batch line 3', queryLineInFullSql(batch, secondStart, 1), 3);
assert('second statement line 2 is batch line 4', queryLineInFullSql(batch, secondStart, 2), 4);
assert('shift at line', shiftEngineLineRefs("near 'FROM' at line 2", 2), "near 'FROM' at line 4");
assert('shift LINE keeps prefix', shiftEngineLineRefs('syntax error\nLINE 2: FROM', 2), 'syntax error\nLINE 4: FROM');
assert('shift zero leaves text', shiftEngineLineRefs('at line 2', 0), 'at line 2');
assert(
    'shift bigquery at [line:col]',
    shiftEngineLineRefs('Syntax error: Unexpected identifier at [3:15]', 2),
    'Syntax error: Unexpected identifier at [5:15]'
);

const twoStmt = SqlBlock.fromText(batch);
assert(
    'shifted engine line maps to the second statement',
    fileLineForQueryLine(twoStmt, queryLineInFullSql(batch, secondStart, 2)),
    4
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All error line tests passed.');
