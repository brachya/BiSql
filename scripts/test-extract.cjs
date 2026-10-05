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

const {
    collectSelectAliases,
    collectTableRefs,
    primaryResultTable,
    extractSqlBlocksFromSource,
    hasDroppedLeadingInterpolation,
    isSqlStatementStart
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
    'docstring Update a set is not SQL',
    blocks(
        'def symmetric_difference_update() -> None:\n' +
            '    """Update a set with the symmetric difference of itself and another."""\n' +
            '    pass\n'
    ),
    (value) => value.length === 0
);
assert(
    'unmarked SELECT is not SQL',
    blocks('x = "SELECT * FROM users"\n'),
    (value) => value.length === 0
);
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
    blocks('query = "SELECT * FROM users"\n'),
    ['SELECT * FROM users']
);
assert(
    'SELECT col FROM is SQL',
    blocks('query = "SELECT u.id FROM users u"\n'),
    ['SELECT u.id FROM users u']
);
assert(
    'SELECT 1 is SQL',
    blocks('query = "SELECT 1"\n'),
    ['SELECT 1']
);
assert(
    'WITH cte AS ( is SQL',
    blocks('query = "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte"\n'),
    ['WITH cte AS (SELECT 1 AS n) SELECT * FROM cte']
);
assert(
    'INSERT INTO is SQL',
    blocks('query = "INSERT INTO t VALUES (1)"\n'),
    ['INSERT INTO t VALUES (1)']
);
assert(
    'UPDATE SET is SQL',
    blocks('query = "UPDATE t SET x = 1"\n'),
    ['UPDATE t SET x = 1']
);
assert(
    'DELETE FROM is SQL',
    blocks('query = "DELETE FROM t"\n'),
    ['DELETE FROM t']
);
assert(
    'CREATE TABLE is SQL',
    blocks('query = "CREATE TABLE t (id INT)"\n'),
    ['CREATE TABLE t (id INT)']
);
assert(
    'TRUNCATE TABLE is SQL',
    blocks('query = "TRUNCATE TABLE t"\n'),
    ['TRUNCATE TABLE t']
);
assert(
    'EXEC proc is SQL',
    blocks('query = "EXEC dbo.usp_help"\n'),
    ['EXEC dbo.usp_help']
);

assert(
    'implicit concat keeps FROM piece',
    blocks('query = (\n    "SELECT * "\n    "FROM users"\n)\n'),
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

const cteHelper = `def _version_widgets_cte():
    return """-- sql
    version_widgets AS (
        SELECT stable_widgets.* FROM stable_widgets
    )"""
`;
assert('CTE helper with -- sql is still extracted', blocks(cteHelper).length, 1);
assert(
    'CTE helper is not a full statement',
    isSqlStatementStart(extractSqlBlocksFromSource(cteHelper)[0].text),
    false
);
assert(
    'SELECT after -- sql is a full statement',
    isSqlStatementStart('-- sql\n    SELECT id FROM widgets\n'),
    true
);
assert(
    'WITH name AS is a full statement',
    isSqlStatementStart('WITH stable_widgets AS (SELECT 1) SELECT * FROM stable_widgets'),
    true
);

assert(
    'table.col alias is the alias, not the column',
    [...collectSelectAliases('SELECT p.cred credentials, p.npi FROM physicians p')],
    (names) => names.includes('credentials') && !names.includes('cred')
);

const derivedJoin = `
    SELECT IFNULL(r.roles, '[]') roles
    FROM users u
    LEFT JOIN (
        SELECT JSON_ARRAYAGG(ru.role_id) AS roles, ru.user_id
        FROM users_roles ru
        INNER JOIN roles r ON r.id = ru.role_id
        GROUP BY ru.user_id
    ) r ON r.user_id = u.id
`;
const derived = collectTableRefs(derivedJoin);
assert('derived join marks a subquery', derived.hasDerived, true);
assert(
    'inner JOIN roles r does not leak to outer r',
    derived.aliasToTable.get('r'),
    (table) => table !== 'roles'
);
assert(
    'outer users alias is still mapped',
    derived.aliasToTable.get('u'),
    'users'
);
const cteAliases = collectTableRefs(
    'WITH x AS (SELECT u.id FROM users u) SELECT x.id FROM x'
);
assert('CTE body alias u still maps to users', cteAliases.aliasToTable.get('u'), 'users');
assert('CTE name x still maps', cteAliases.aliasToTable.get('x'), 'x');
assert(
    'FROM NULL is an unresolved table name',
    collectTableRefs('SELECT id FROM NULL qmr JOIN facilities USING(facility_id)').hasUnresolvedFrom,
    true
);
assert(
    'hyphenated BigQuery project is one table name',
    collectTableRefs(
        'select * from datalign-sandbox.meir.clustered_falls where client_id = 12885369'
    ).refs.map((ref) => ref.table),
    ['datalign-sandbox.meir.clustered_falls']
);
assert(
    'backtick-quoted BigQuery path stays one table name',
    collectTableRefs(
        'select * from `datalign-sandbox.meir.clustered_falls` where client_id = 1'
    ).refs.map((ref) => ref.table),
    ['datalign-sandbox.meir.clustered_falls']
);
assert(
    'SELECT a-b is not a table name',
    collectTableRefs('SELECT a-b FROM users').refs.map((ref) => ref.table),
    ['users']
);
assert(
    'project id with digits stays one part',
    collectTableRefs('SELECT 1 FROM my-proj-123.ds.tbl').refs.map((ref) => ref.table),
    ['my-proj-123.ds.tbl']
);
assert('results title uses the bare table name', primaryResultTable('SELECT * FROM orders'), 'orders');
assert(
    'results title drops the schema',
    primaryResultTable('SELECT * FROM dbo.Users u'),
    'Users'
);
assert(
    'results title uses the BigQuery table, not the project',
    primaryResultTable('select * from datalign-sandbox.meir.clustered_falls'),
    'clustered_falls'
);
assert(
    'results title uses the first table in a join',
    primaryResultTable('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id'),
    'orders'
);
assert('results title is empty when there is no table', primaryResultTable('SELECT 1'), undefined);

const helperSource = `query = f"""-- sql
        {_base_query(payload, params)}
        SELECT tasks.task_id FROM tasks
    """
`;
const helperBlocks = extractSqlBlocksFromSource(helperSource);
assert('helper+SELECT is still one SQL block', helperBlocks.length, 1);
assert(
    'leading {helper()} is a dropped interpolation',
    hasDroppedLeadingInterpolation(helperBlocks[0].originalText),
    true
);
assert(
    'dropped helper still leaves a SELECT statement',
    isSqlStatementStart(helperBlocks[0].text),
    true
);
assert(
    '{cols} FROM t is a value, not a dropped preamble',
    hasDroppedLeadingInterpolation('{cols} FROM missing_table'),
    false
);
assert(
    '{hint} then SELECT is a dropped preamble',
    hasDroppedLeadingInterpolation('{hint}\nSELECT * FROM missing_table'),
    true
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All extract tests passed.');
