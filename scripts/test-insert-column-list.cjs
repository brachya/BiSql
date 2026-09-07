'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-insert-column-list-${process.pid}`);
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
    tokenizeSql,
    normalizeEmbeddedSql,
    insertColumnListAt,
    isInsideInsertColumnList
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

function identIndexes(tokens, name) {
    return tokens
        .map((tok, i) => (tok.kind === 'ident' && tok.value.toLowerCase() === name.toLowerCase() ? i : -1))
        .filter((i) => i >= 0);
}

function targetFor(tokens, name) {
    return identIndexes(tokens, name).map((i) => insertColumnListAt(tokens, i));
}

const placeholderSql = normalizeEmbeddedSql(`INSERT INTO {_PROJECTED_TABLE}
    (admission_uid, client_id, medicare_start_date, uses_wc, is_cca)
    SELECT :admission_uid, patients.client_id, :medicare_start_date, :uses_wc, patients.current_cca
    FROM patients`);
const placeholderTokens = tokenizeSql(placeholderSql);

assert(
    'placeholder INSERT INTO {t} (cols) keeps the column list',
    placeholderSql.includes('(admission_uid, client_id, medicare_start_date, uses_wc, is_cca)'),
    true
);
assert(
    'admission_uid in placeholder INSERT list is inside the list',
    identIndexes(placeholderTokens, 'admission_uid').every((i) => isInsideInsertColumnList(placeholderTokens, i)),
    true
);
assert(
    'placeholder INSERT list has no table to check',
    targetFor(placeholderTokens, 'admission_uid'),
    [{ table: null }]
);
assert(
    'medicare_start_date in placeholder INSERT list is inside the list',
    identIndexes(placeholderTokens, 'medicare_start_date').every((i) =>
        isInsideInsertColumnList(placeholderTokens, i)
    ),
    true
);
assert(
    'SELECT column current_cca is not inside the INSERT list',
    identIndexes(placeholderTokens, 'current_cca').some((i) =>
        isInsideInsertColumnList(placeholderTokens, i)
    ),
    false
);

const knownSql = `
INSERT INTO widgets
    (admission_uid, medicare_start_date)
SELECT id FROM patients
`;
const knownTokens = tokenizeSql(knownSql);
assert(
    'known INSERT target is the table name',
    targetFor(knownTokens, 'admission_uid'),
    [{ table: 'widgets' }]
);
assert(
    'SELECT id is not inside the INSERT list',
    identIndexes(knownTokens, 'id').some((i) => isInsideInsertColumnList(knownTokens, i)),
    false
);

const valuesSql = tokenizeSql('INSERT INTO widgets (admission_uid) VALUES (1)');
assert(
    'INSERT column before VALUES is inside the list',
    targetFor(valuesSql, 'admission_uid'),
    [{ table: 'widgets' }]
);

const noList = tokenizeSql('INSERT INTO widgets SELECT admission_uid FROM patients');
assert(
    'INSERT INTO t SELECT has no column list',
    identIndexes(noList, 'admission_uid').some((i) => isInsideInsertColumnList(noList, i)),
    false
);

const fnSql = tokenizeSql("SELECT INSERT('hello', 2, 3, 'y')");
assert(
    'INSERT() string function is not a column list',
    fnSql.every((_, i) => !isInsideInsertColumnList(fnSql, i)),
    true
);

const replaceSql = tokenizeSql('REPLACE INTO widgets (admission_uid) SELECT id FROM patients');
assert(
    'REPLACE INTO column list uses the target table',
    targetFor(replaceSql, 'admission_uid'),
    [{ table: 'widgets' }]
);

const ignoreSql = tokenizeSql('INSERT IGNORE INTO widgets (admission_uid) SELECT id FROM patients');
assert(
    'INSERT IGNORE INTO still finds the column list',
    targetFor(ignoreSql, 'admission_uid'),
    [{ table: 'widgets' }]
);

const qualified = tokenizeSql('INSERT INTO db.widgets (admission_uid) SELECT id FROM patients');
assert(
    'qualified INSERT target keeps both name parts',
    targetFor(qualified, 'admission_uid'),
    [{ table: 'db.widgets' }]
);

if (process.exitCode) {
    process.exit(1);
}
console.log('All insert column-list tests passed.');
