'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-result-page-${process.pid}`);
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
    entryPoints: [path.join(root, 'src/sql/resultPage.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'resultPage.js'),
    alias: { vscode: vscodeStub }
});

const { buildPagedSelect, splitOuterPaging, pageFetchCount } = require(
    path.join(outDir, 'resultPage.js')
);

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

assert('parses LIMIT 10', splitOuterPaging('SELECT * FROM t LIMIT 10').limit, 10);
assert(
    'parses LIMIT 10 OFFSET 5',
    splitOuterPaging('SELECT * FROM t LIMIT 10 OFFSET 5'),
    (value) => value.limit === 10 && value.offset === 5 && value.body === 'SELECT * FROM t'
);
assert(
    'parses MySQL LIMIT offset, count',
    splitOuterPaging('SELECT * FROM t LIMIT 5, 10'),
    (value) => value.offset === 5 && value.limit === 10
);
assert(
    'parses OFFSET FETCH',
    splitOuterPaging('SELECT * FROM t OFFSET 2 ROWS FETCH NEXT 10 ROWS ONLY'),
    (value) => value.offset === 2 && value.limit === 10
);

assert(
    'LIMIT 10 is not replaced by a larger page size',
    buildPagedSelect('SELECT * FROM t LIMIT 10', 'mysql', 0, 51),
    (sql) => /LIMIT 10 OFFSET 0/.test(sql) && !/LIMIT 51/.test(sql)
);
assert(
    'keeps the query OFFSET',
    buildPagedSelect('SELECT * FROM t LIMIT 10 OFFSET 5', 'mysql', 0, 51),
    (sql) => /LIMIT 10 OFFSET 5/.test(sql)
);
assert(
    'page size smaller than SQL LIMIT still caps the page',
    buildPagedSelect('SELECT * FROM t LIMIT 5000', 'mysql', 0, 51),
    (sql) => /LIMIT 51 OFFSET 0/.test(sql)
);
assert(
    'next page past SQL LIMIT asks for zero rows',
    buildPagedSelect('SELECT * FROM t LIMIT 10', 'mysql', 50, 51),
    (sql) => /LIMIT 0 OFFSET 50/.test(sql)
);
assert('pageFetchCount honors SQL LIMIT', pageFetchCount(51, 10, 0), 10);
assert('pageFetchCount is 0 past SQL LIMIT', pageFetchCount(51, 10, 10), 0);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('ok');
