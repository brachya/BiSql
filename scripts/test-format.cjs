'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-format-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/sql/formatEmbeddedSql.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'formatEmbeddedSql.js')
});

const { formatEmbeddedSql, anchorIndentFromLinePrefix } = require(path.join(
    outDir,
    'formatEmbeddedSql.js'
));

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

function format(content, extra = {}) {
    return formatEmbeddedSql(content, {
        dialect: 'mysql',
        keywordCase: 'upper',
        tabWidth: 4,
        isFString: false,
        isTripleQuoted: true,
        ...extra
    });
}

const sample = format('\nselect * from {users_table}\n', { isFString: true });
assert('sample formats', sample.ok, true);
assert('select becomes SELECT', sample.ok && sample.text.includes('SELECT'), true);
assert('from becomes FROM', sample.ok && /\bFROM\b/.test(sample.text), true);
assert('keeps f-string table placeholder', sample.ok && sample.text.includes('{users_table}'), true);
assert('does not uppercase the placeholder name', sample.ok && !sample.text.includes('{USERS_TABLE}'), true);

const mixed = format(
    '\nselect count(*) as c, cast(id as int)\nfrom users\nwhere id in (1, 2)\n'
);
assert('mixed formats', mixed.ok, true);
assert('COUNT is upper', mixed.ok && mixed.text.includes('COUNT(*)'), true);
assert('CAST and INT are upper', mixed.ok && mixed.text.includes('CAST(id AS INT)'), true);
assert('table name stays lowercase', mixed.ok && mixed.text.includes('users'), true);
assert('table name is not USERS', mixed.ok && !/\bUSERS\b/.test(mixed.text), true);

const lower = format('\nSELECT * FROM users\n', { keywordCase: 'lower' });
assert('lower setting downcases SELECT', lower.ok && lower.text.includes('select'), true);
assert('lower setting downcases FROM', lower.ok && /\bfrom\b/.test(lower.text), true);

const spaced = format('\n    select * from users where id = 1\n    ');
assert('keeps 4-space indent', spaced.ok && spaced.text.startsWith('\n    SELECT'), true);
assert(
    'nested indent stays inside the base indent',
    spaced.ok && spaced.text.includes('\n        *\n'),
    true
);

const tabbed = format('\n\tselect * from users where id = 1\n\t');
assert('keeps tab indent', tabbed.ok && tabbed.text.startsWith('\n\tSELECT'), true);
assert(
    'nested indent uses tabs when the SQL is tab-indented',
    tabbed.ok && tabbed.text.includes('\n\t\t*\n'),
    true
);
assert(
    'tab indent does not mix in spaces for nested lines',
    tabbed.ok && !tabbed.text.includes('\t    '),
    true
);

const flush = format('\nselect * from users\n');
assert('stays at column 0 when it started there', flush.ok && flush.text.startsWith('\nSELECT'), true);

const afterQuotes = format('select * from users where id = 1', {
    anchorIndent: '             '
});
assert('same-line SQL keeps first token unpadded', afterQuotes.ok && afterQuotes.text.startsWith('SELECT'), true);
assert(
    'same-line SQL does not put later lines at column 0',
    afterQuotes.ok &&
        afterQuotes.text
            .split('\n')
            .slice(1)
            .every((line) => line.startsWith('             ')),
    true
);
assert(
    'same-line SQL pads FROM to the original column',
    afterQuotes.ok && afterQuotes.text.includes('\n             FROM\n'),
    true
);

const sqlFile = format('    select * from users where id = 1');
assert(
    'indented SQL file keeps first-line indent',
    sqlFile.ok && sqlFile.text.startsWith('    SELECT'),
    true
);

assert(
    'whitespace-only prefix is kept as tabs',
    anchorIndentFromLinePrefix('\t\t', 4),
    '\t\t'
);
assert(
    'code-before-SQL prefix pads to that visual column',
    anchorIndentFromLinePrefix('    sql = """', 4),
    '             '
);
assert('empty prefix stays column 0', anchorIndentFromLinePrefix('', 4), '');

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All format tests passed.');
