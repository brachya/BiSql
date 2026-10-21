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

const splitCase = format('\nselect count(*) as c, cast(id as int) from users\n', {
    functionCase: 'lower',
    dataTypeCase: 'preserve'
});
assert('function case can stay lower', splitCase.ok && splitCase.text.includes('count(*)'), true);
assert('keywords stay upper when only functions change', splitCase.ok && splitCase.text.includes('SELECT'), true);
assert('type case can stay as written', splitCase.ok && splitCase.text.includes(' AS int)'), true);

const andAfter = format('\nselect * from users where a = 1 and b = 2\n', {
    logicalOperatorNewline: 'after'
});
assert('AND can stay at the end of the line', andAfter.ok && andAfter.text.includes('1 AND\n'), true);

const dense = format('\nselect * from users where id = 1\n', { denseOperators: true });
assert('dense operators drop spaces', dense.ok && dense.text.includes('id=1'), true);

const ownLine = format('\nselect 1;\n', { newlineBeforeSemicolon: true });
assert('semicolon can sit on its own line', ownLine.ok && /\n\s*;\s*$/.test(ownLine.text), true);

const tight = format('\nselect 1;\nselect 2;\n', { linesBetweenQueries: 0 });
assert('statements can sit with no blank line', tight.ok && tight.text.includes(';\nSELECT'), true);
assert('zero blank lines does not insert a gap', tight.ok && !tight.text.includes(';\n\nSELECT'), true);

const wideList = format('\nselect * from users where id in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)\n');
const narrowList = format('\nselect * from users where id in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)\n', {
    expressionWidth: 1
});
assert('a wide expression stays on one line', wideList.ok && wideList.text.includes('(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)'), true);
assert(
    'a narrow expression width breaks that list',
    narrowList.ok && !narrowList.text.includes('(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)'),
    true
);

const tabsForced = format('\n    select * from users where id = 1\n    ', { useTabs: true });
assert(
    'useTabs indents the SQL body with a tab',
    tabsForced.ok && tabsForced.text.includes('\n    \t*\n'),
    true
);

const escapedDollar = format('SELECT \\${id} FROM t', {
    isTemplate: true,
    isTripleQuoted: false
});
assert('escaped template dollar still formats', escapedDollar.ok, true);
assert(
    'escaped template dollar stays in the SQL',
    escapedDollar.ok && escapedDollar.text.includes('${id}'),
    true
);

const nestedTemplate = format('SELECT ${cond ? `a}b` : `c`} FROM t', {
    isTemplate: true,
    isTripleQuoted: false
});
assert('nested template expression still formats', nestedTemplate.ok, true);
assert(
    'nested template expression stays intact',
    nestedTemplate.ok && nestedTemplate.text.includes('${cond ? `a}b` : `c`}'),
    true
);

const regexInterp = format('SELECT ${/}/.test(id) ? id : 0} FROM users', {
    isTemplate: true,
    isTripleQuoted: false
});
assert('regex inside template expression still formats', regexInterp.ok, true);
assert(
    'regex inside template expression stays intact',
    regexInterp.ok && regexInterp.text.includes('${/}/.test(id) ? id : 0}'),
    true
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All format tests passed.');
