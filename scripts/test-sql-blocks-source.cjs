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

const {
    sqlBlocksInSource,
    sqlBlocksInDocument,
    findSqlAtPosition,
    findSqlBlockAtDocOffset,
    sqlStatementBlockAtDocOffset,
    splitSqlStatements,
    statementAtOffset,
    firstSqlKeyword,
    clearDocumentCache
} = require(path.join(outDir, 'sqlExtractor.js'));

const vscode = require(path.join(outDir, 'vscode.js'));

function fakeSqlDocument(uri, version, text, languageId = 'sql') {
    const lines = () => text.split('\n');
    return {
        uri: { toString: () => uri },
        version,
        languageId,
        getText: () => text,
        offsetAt(position) {
            let offset = 0;
            const ls = lines();
            for (let line = 0; line < position.line; line += 1) {
                offset += ls[line].length + 1;
            }
            return offset + position.character;
        },
        positionAt(offset) {
            const ls = lines();
            let line = 0;
            let remaining = offset;
            while (line < ls.length - 1 && remaining > ls[line].length) {
                remaining -= ls[line].length + 1;
                line += 1;
            }
            return new vscode.Position(line, remaining);
        }
    };
}

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

const cacheUri = 'file:///tmp/bisql-cache-test.sql';
const cacheText = 'SELECT 1 FROM a;\nSELECT 2 FROM b;\n';
clearDocumentCache({ toString: () => cacheUri });
const docV1 = fakeSqlDocument(cacheUri, 1, cacheText);
const blocksA = sqlBlocksInDocument(docV1);
const blocksB = sqlBlocksInDocument(docV1);
assert('sql document cache same version returns same blocks', blocksA, blocksB);
assert('sql document cache splits two statements', blocksA.length, 2);

const docV2 = fakeSqlDocument(cacheUri, 2, cacheText + '-- edit\n');
const blocksV2 = sqlBlocksInDocument(docV2);
assert('sql document cache new version is not same reference', blocksV2 === blocksA, false);

const caretDoc = fakeSqlDocument('file:///tmp/bisql-caret.sql', 1, cacheText);
const secondFrom = cacheText.indexOf('FROM b') + 5;
const hit = findSqlAtPosition(caretDoc, caretDoc.positionAt(secondFrom));
assert('caret in second statement uses that block', hit.block.text.trim(), 'SELECT 2 FROM b;');
assert(
    'caret offset is relative to statement',
    hit.block.text.slice(hit.sqlOffset, hit.sqlOffset + 1),
    'b'
);

const emptyDoc = fakeSqlDocument('file:///tmp/bisql-empty.sql', 1, '-- only comments\n');
const emptyBlocks = sqlBlocksInDocument(emptyDoc);
assert('empty sql file still has one block', emptyBlocks.length, 1);
assert(
    'empty sql block spans file',
    emptyBlocks[0].text,
    '-- only comments\n'
);
assert(
    'comment-only file has no runnable statement block',
    sqlStatementBlockAtDocOffset(emptyDoc, 0),
    undefined
);
assert('comment-only file has no statement slices for code lens', splitSqlStatements('-- only comments\n').length, 0);
assert('comment-only file has no keyword for dry-run', firstSqlKeyword('-- only comments\n'), null);
assert('a select has a keyword for dry-run', firstSqlKeyword('SELECT 1 FROM a'), 'select');
assert(
    'comment-only file still allows hover/complete via fallback block',
    findSqlAtPosition(emptyDoc, emptyDoc.positionAt(2))?.block.text,
    '-- only comments\n'
);

const gapText = 'SELECT 1 FROM a;\n\nSELECT 2 FROM b;\n';
const gapDoc = fakeSqlDocument('file:///tmp/bisql-gap.sql', 1, gapText);
const gapOffset = gapText.indexOf('\n\n') + 1;
const gapHit = findSqlAtPosition(gapDoc, gapDoc.positionAt(gapOffset));
assert('caret in gap uses previous statement block', gapHit.block.text.trim(), 'SELECT 1 FROM a;');
assert(
    'caret in gap maps to tail of previous statement sql',
    gapHit.sqlOffset >= gapHit.block.text.indexOf(';'),
    true
);

for (const offset of [0, gapText.indexOf('2'), gapText.length - 1, gapText.length]) {
    const slice = statementAtOffset(gapText, offset);
    const block = findSqlBlockAtDocOffset(sqlBlocksInDocument(gapDoc), gapText, offset);
    assert(
        `findSqlBlockAtDocOffset matches statementAtOffset at ${offset}`,
        Boolean(slice) === Boolean(block) &&
            (!slice || (block.docStart === slice.start && block.docEnd === slice.end)),
        true
    );
}

clearDocumentCache({ toString: () => 'file:///tmp/bisql-lang.sql' });
const langUri = 'file:///tmp/bisql-lang.sql';
const langText = "query = 'SELECT 1'\n";
const langPyDoc = fakeSqlDocument(langUri, 1, langText, 'python');
const langPyBlocks = sqlBlocksInDocument(langPyDoc);
const sqlDocSameVersion = fakeSqlDocument(langUri, 1, langText, 'sql');
const sqlBlocksAfterLangSwitch = sqlBlocksInDocument(sqlDocSameVersion);
assert(
    'cache miss when languageId changes at same version',
    sqlBlocksAfterLangSwitch === langPyBlocks,
    false
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All sqlBlocksInSource tests passed.');
