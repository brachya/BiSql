'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-extract-${process.pid}`);
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

const { extractSqlBlocksFromSource } = require(path.join(outDir, 'sqlExtractor.js'));

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

function blocks(source) {
    return extractSqlBlocksFromSource(source).map((block) => block.originalText);
}

const samplePy = `metadata = {
    "description": (
        "When true (default), return only residents whose next physician "
        "visit is due today or overdue. When false, also include residents "
        "with an upcoming visit scheduled."
    ),
    "example": True,
},
`;

assert('sample.py description is not SQL', blocks(samplePy), (value) => value.length === 0);
assert(
    'standalone English WITH is not SQL',
    blocks('text = "with an upcoming visit scheduled."\n'),
    (value) => value.length === 0
);
assert(
    'English SELECT FROM sentence is not SQL',
    blocks('msg = "Select the first option from the list."\n'),
    (value) => value.length === 0
);
assert(
    'English CREATE is not SQL',
    blocks('msg = "Create a new user when ready."\n'),
    (value) => value.length === 0
);
assert(
    'English UPDATE is not SQL',
    blocks('msg = "Update the status later."\n'),
    (value) => value.length === 0
);
assert(
    'English DELETE is not SQL',
    blocks('msg = "Delete this file after export."\n'),
    (value) => value.length === 0
);
assert(
    'English DROP is not SQL',
    blocks('msg = "Drop the connection if idle."\n'),
    (value) => value.length === 0
);
assert(
    'English INSERT is not SQL',
    blocks('msg = "Insert the key and turn it."\n'),
    (value) => value.length === 0
);
assert(
    'English EXECUTE is not SQL',
    blocks('msg = "Execute the plan tomorrow."\n'),
    (value) => value.length === 0
);
assert(
    'English MERGE is not SQL',
    blocks('msg = "Merge the two lists together."\n'),
    (value) => value.length === 0
);
assert(
    'English TRUNCATE is not SQL',
    blocks('msg = "Truncate extra spaces here."\n'),
    (value) => value.length === 0
);

assert(
    'SELECT * FROM is SQL',
    blocks('x = "SELECT * FROM users"\n'),
    ['SELECT * FROM users']
);
assert(
    'SELECT col FROM is SQL',
    blocks('x = "SELECT u.id FROM users u"\n'),
    ['SELECT u.id FROM users u']
);
assert(
    'SELECT 1 is SQL',
    blocks('x = "SELECT 1"\n'),
    ['SELECT 1']
);
assert(
    'WITH cte AS ( is SQL',
    blocks('x = "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte"\n'),
    ['WITH cte AS (SELECT 1 AS n) SELECT * FROM cte']
);
assert(
    'INSERT INTO is SQL',
    blocks('x = "INSERT INTO t VALUES (1)"\n'),
    ['INSERT INTO t VALUES (1)']
);
assert(
    'UPDATE SET is SQL',
    blocks('x = "UPDATE t SET x = 1"\n'),
    ['UPDATE t SET x = 1']
);
assert(
    'DELETE FROM is SQL',
    blocks('x = "DELETE FROM t"\n'),
    ['DELETE FROM t']
);
assert(
    'CREATE TABLE is SQL',
    blocks('x = "CREATE TABLE t (id INT)"\n'),
    ['CREATE TABLE t (id INT)']
);
assert(
    'TRUNCATE TABLE is SQL',
    blocks('x = "TRUNCATE TABLE t"\n'),
    ['TRUNCATE TABLE t']
);
assert(
    'EXEC proc is SQL',
    blocks('x = "EXEC dbo.usp_help"\n'),
    ['EXEC dbo.usp_help']
);

assert(
    'implicit concat keeps FROM piece',
    blocks('x = (\n    "SELECT * "\n    "FROM users"\n)\n'),
    ['SELECT * FROM users']
);
assert(
    'plus concat after WHERE stays one block',
    blocks('query = "SELECT * FROM t WHERE " + "id = 1"\n'),
    ['SELECT * FROM t WHERE id = 1']
);
assert(
    'query = ( still detects by assignment',
    blocks('query = (\n    "-- not a keyword start\\nfoo"\n)\n'),
    ['-- not a keyword start\\nfoo']
);
assert(
    '--sql marker still detects',
    blocks('note = "-- sql\\nnot a verb start"\n'),
    ['-- sql\\nnot a verb start']
);
assert(
    'execute() still detects',
    blocks('cur.execute("SELECT 1")\n'),
    ['SELECT 1']
);

const sampleFile = fs.readFileSync(path.join(root, 'examples/sample.py'), 'utf8');
const sampleSql = extractSqlBlocksFromSource(sampleFile).map((block) => block.text);
assert(
    'sample.py optional cols do not become NULL SUM',
    sampleSql,
    (value) => value.length === 1 && !/NULL\s+SUM\s*\(/.test(value[0]) && /SUM\s*\(\s*NULL\s*\)/.test(value[0])
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All extract tests passed.');
