'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-cte-${process.pid}`);
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
    entryPoints: [path.join(root, 'src/sql/cteSchema.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'cteSchema.js'),
    alias: { vscode: vscodeStub }
});

const {
    resolveCteTables,
    findRelation,
    isCteTable,
    tokenizeSql,
    collectTableRefs,
    collectCteNames,
    parseSelectItems,
    rewriteSyntheticSelectLists
} = require(path.join(outDir, 'cteSchema.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : actual === check;
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', actual instanceof Set ? [...actual] : JSON.stringify(actual));
        console.error(
            ' expect:',
            typeof check === 'function' ? check.toString() : JSON.stringify(check)
        );
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

function makeTable(name, colNames) {
    const columns = colNames.map((col, index) => ({
        name: col,
        ordinal: index,
        typeName: 'int',
        typeDisplay: 'int',
        isNullable: true,
        isIdentity: false,
        isComputed: false,
        isPrimaryKey: false
    }));
    const columnsByLower = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
    return {
        database: 'db',
        schema: 'dbo',
        name,
        fullName: `dbo.${name}`,
        qualifiedName: `db.dbo.${name}`,
        isView: false,
        columns,
        columnsByLower
    };
}

function tables(...list) {
    const map = new Map(list.map((table) => [table.name.toLowerCase(), table]));
    return (reference) => map.get(reference.split('.').pop().toLowerCase());
}

const facilities = makeTable('facilities', [
    'building_id',
    'building_name',
    'division_id',
    'division_name',
    'region_id',
    'region_name'
]);

assert(
    'WITH (NOLOCK) is not a CTE',
    [...collectCteNames(tokenizeSql('SELECT * FROM facilities WITH (NOLOCK)'))],
    (names) => names.length === 0
);

const sample = `
        WITH facilities_rows AS (
            SELECT
                NULL
            FROM facilities
        )
        SELECT
            (
                SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
                    'division_id', division_id,
                    'division_name', division_name
                )), JSON_ARRAY())
                FROM (
                    SELECT
                        NULL
                    FROM facilities_rows
                    GROUP BY facilities_rows.division_id
                ) divisions
            ) AS divisions
`;

const sampleTokens = tokenizeSql(sample);
assert(
    'collects facilities_rows as a CTE',
    collectCteNames(sampleTokens),
    (names) => names.has('facilities_rows')
);

const { refs, cteNames } = collectTableRefs(sample, sampleTokens);
assert(
    'FROM facilities_rows is a table ref',
    refs.some((ref) => ref.table.toLowerCase() === 'facilities_rows'),
    true
);

const ctes = resolveCteTables(sampleTokens, tables(facilities));
const cte = ctes.get('facilities_rows');
assert('resolves facilities_rows as a CTE table', Boolean(cte && isCteTable(cte)), true);
assert(
    'inherits facilities columns when SELECT is a placeholder',
    cte && cte.columns.map((column) => column.name),
    (names) =>
        Array.isArray(names) &&
        names.includes('building_id') &&
        names.includes('division_id')
);

const unknown = refs.filter((ref) => {
    const key = ref.table.toLowerCase();
    if (cteNames.has(key) || ctes.has(key)) {
        return false;
    }
    return !tables(facilities)(ref.table);
});
assert(
    'does not flag facilities_rows as an unknown table',
    unknown.map((ref) => ref.table),
    (names) => names.length === 0
);

assert(
    'findRelation prefers the CTE over a missing schema table',
    findRelation('facilities_rows', () => undefined, ctes)?.name,
    'facilities_rows'
);

assert(
    'SELECT list columns from explicit names',
    parseSelectItems(tokenizeSql('SELECT id, name FROM users')),
    (items) =>
        items.length === 2 &&
        items[0].kind === 'column' &&
        items[0].name === 'id' &&
        items[1].kind === 'column' &&
        items[1].name === 'name'
);

const users = makeTable('users', ['id', 'name', 'email']);
const named = resolveCteTables(
    tokenizeSql('WITH cte AS (SELECT id, name FROM users) SELECT * FROM cte'),
    tables(users)
).get('cte');
assert(
    'named SELECT list becomes CTE columns',
    named && named.columns.map((column) => column.name),
    (names) => JSON.stringify(names) === JSON.stringify(['id', 'name'])
);

const starred = resolveCteTables(
    tokenizeSql('WITH cte AS (SELECT * FROM users) SELECT * FROM cte'),
    tables(users)
).get('cte');
assert(
    'SELECT * copies source table columns',
    starred && starred.columns.map((column) => column.name),
    (names) => JSON.stringify(names) === JSON.stringify(['id', 'name', 'email'])
);

const chained = resolveCteTables(
    tokenizeSql(
        'WITH a AS (SELECT id FROM users), b AS (SELECT id FROM a) SELECT * FROM b'
    ),
    tables(users)
);
assert('later CTE can read an earlier CTE', chained.get('b')?.columns[0]?.name, 'id');

const placeholderSql = `WITH facilities_rows AS (
            SELECT
                NULL
            FROM facilities
        )
        SELECT NULL
        FROM facilities_rows
        GROUP BY facilities_rows.division_id`;
const placeholderTokens = tokenizeSql(placeholderSql);
const allNullSynthetic = (offset) =>
    placeholderSql.slice(offset, offset + 4).toUpperCase() === 'NULL';
const rewritten = rewriteSyntheticSelectLists(
    placeholderSql,
    placeholderTokens,
    allNullSynthetic
);
assert(
    'rewrites placeholder SELECT NULL to SELECT * for dry-run',
    rewritten,
    (sql) =>
        (sql.match(/SELECT\s+\*\s+FROM facilities\b/gi) || []).length === 1 &&
        (sql.match(/SELECT\s+\*\s+FROM facilities_rows\b/gi) || []).length === 1
);

const realNull = 'SELECT NULL FROM facilities';
assert(
    'keeps a real SELECT NULL written by the user',
    rewriteSyntheticSelectLists(realNull, tokenizeSql(realNull), () => false),
    realNull
);

if (process.exitCode) {
    process.exit(1);
}
console.log('All CTE tests passed.');
