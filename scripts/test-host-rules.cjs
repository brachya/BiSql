'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-host-rules-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/parser/sqlHostRules.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'sqlHostRules.js')
});

const {
    classifyEmbeddedSqlGroup,
    looksLikeJsSqlAssignName,
    looksLikeSqlAssignName,
    looksLikeSqlTemplateTag
} = require(path.join(outDir, 'sqlHostRules.js'));

function assert(name, ok) {
    if (!ok) {
        console.error(`FAIL ${name}`);
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

assert('query name', looksLikeSqlAssignName('user_query'));
assert('not sqlite', !looksLikeSqlAssignName('sqlite'));
assert('js query name', looksLikeJsSqlAssignName('user_query'));
assert('js exact query', looksLikeJsSqlAssignName('query'));
assert('js not queryKey', !looksLikeJsSqlAssignName('queryKey'));
assert('js not mediaQuery', !looksLikeJsSqlAssignName('mediaQuery'));
assert('prisma tag', looksLikeSqlTemplateTag('prisma.$queryRaw'));
assert('nested generic tag', looksLikeSqlTemplateTag('prisma.$queryRaw<Array<User>>'));
assert('sql tag', looksLikeSqlTemplateTag('sql'));

assert(
    'python assign',
    classifyEmbeddedSqlGroup('python', {
        combinedContent: 'SELECT 1',
        preceding: 'query = '
    })
);
assert(
    'python call',
    classifyEmbeddedSqlGroup('python', {
        combinedContent: 'SELECT 1',
        preceding: 'cur.execute('
    })
);
assert(
    'js assign',
    classifyEmbeddedSqlGroup('javascript', {
        combinedContent: 'SELECT 1',
        preceding: 'const query = '
    })
);
assert(
    'js query call',
    classifyEmbeddedSqlGroup('javascript', {
        combinedContent: 'SELECT 1',
        preceding: 'await pool.query('
    })
);
assert(
    'js tag',
    classifyEmbeddedSqlGroup('javascript', {
        combinedContent: 'SELECT 1',
        preceding: '',
        templateTag: '$queryRaw'
    })
);
assert(
    'js nested generic tag',
    classifyEmbeddedSqlGroup('javascript', {
        combinedContent: 'SELECT 1',
        preceding: '',
        templateTag: 'prisma.$queryRaw<Array<User>>'
    })
);
assert(
    'js queryKey is not sql',
    !classifyEmbeddedSqlGroup('javascript', {
        combinedContent: 'users',
        preceding: 'const queryKey = '
    })
);
assert(
    'js nested generic call',
    classifyEmbeddedSqlGroup('javascript', {
        combinedContent: 'SELECT 1',
        preceding: 'await pool.query<Array<User>>('
    })
);
assert(
    'marker',
    classifyEmbeddedSqlGroup('javascript', {
        combinedContent: '-- sql\nSELECT 1',
        preceding: 'x = '
    })
);
assert(
    'english not sql',
    !classifyEmbeddedSqlGroup('python', {
        combinedContent: 'select the first option',
        preceding: 'description = '
    })
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All host-rules tests passed.');
