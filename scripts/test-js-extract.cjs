'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-js-extract-${process.pid}`);
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

const { extractJsSqlBlocksFromSource } = require(path.join(outDir, 'sqlExtractor.js'));

function assert(name, check) {
    const ok = typeof check === 'function' ? check() : check;
    if (!ok) {
        console.error(`FAIL ${name}`);
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

function blocks(source, isJsx = false) {
    return extractJsSqlBlocksFromSource(source, isJsx).map((b) => ({
        text: b.text,
        original: b.originalText
    }));
}

assert('const query template', () => blocks('const query = `SELECT id FROM u WHERE id = $1`;').length === 1);
assert('$1 preserved', () => blocks('const query = `SELECT $1`;')[0].text.includes('$1'));
assert('${id} -> NULL', () => {
    const b = blocks('const query = `SELECT ${id}`;')[0];
    return b.original.includes('${id}') && b.text.includes('NULL');
});
assert('pool.query', () => blocks('await pool.query(`SELECT 1`);').length === 1);
assert('english not sql', () => blocks('const description = "select the first option";').length === 0);
assert('regex before query', () => {
    const src = 'const re = /["\']/;\nconst query = `SELECT 1`;';
    return blocks(src).length === 1;
});
assert('division before query', () => {
    const src = 'const x = a / b;\nconst query = `SELECT 1`;';
    return blocks(src).length === 1;
});
assert('comment not sql', () => blocks('// const query = `SELECT 1`').length === 0);
assert('jsx attribute not sql', () => {
    const src = 'export function App() { return <div query="SELECT 1" />; }';
    return blocks(src, true).length === 0;
});
assert('tagged prisma', () => {
    const src = 'await prisma.$queryRaw`SELECT ${id}`;';
    return blocks(src).length === 1;
});
assert('generic type arg', () => {
    const src = 'await prisma.$queryRaw<User>`SELECT 1`;';
    return blocks(src).length === 1;
});
assert('nested generic type arg', () => {
    const src = 'await prisma.$queryRaw<Array<User>>`SELECT id FROM users`;';
    return blocks(src).length === 1;
});
assert('queryKey is not sql', () => blocks('const queryKey = `SELECT 1`;').length === 0);
assert('mediaQuery is not sql', () => blocks('const mediaQuery = "(min-width: 800px)";').length === 0);
assert('user_query is sql', () => blocks('const user_query = `SELECT 1`;').length === 1);
assert('escaped dollar stays literal', () => {
    const b = blocks('const query = `SELECT \\${id} FROM t`;')[0];
    return b.text.includes('${id}') && !b.text.includes('NULL');
});
assert('division after ++ still finds sql', () => {
    const src = 'let n = 1;\nn++ / 2;\nconst query = `SELECT id FROM users`;\n';
    return blocks(src).length === 1 && blocks(src)[0].text.includes('SELECT');
});
assert('nested template expression stays one placeholder', () => {
    const b = blocks('const query = `SELECT ${cond ? `a}b` : `c`} FROM t`;')[0];
    return b.text.includes('NULL') && b.text.includes('FROM') && !b.text.includes('NULLb');
});
assert('jsx text apostrophe does not hide later sql', () => {
    const src = "export function App() {\n  return <p>Don't</p>;\n}\nconst query = `SELECT id FROM users`;\n";
    return blocks(src, true).length === 1 && blocks(src, true)[0].text.includes('SELECT');
});
assert('sql inside jsx expression is found', () => {
    const src = 'return <div>{(() => { const query = `SELECT 1`; return null; })()}</div>;\n';
    return blocks(src, true).length === 1;
});
assert('regex after if paren', () => {
    const src = 'if (ok) /\\d+/.test(name);\nconst query = `SELECT id FROM users`;\n';
    return blocks(src).length === 1 && blocks(src)[0].text.includes('users');
});
assert('else regex', () => {
    const src = "if (ok) {\n} else /[']/.test(name);\nconst query = `SELECT 1`;\n";
    return blocks(src).length === 1;
});
assert('regex after function block', () => {
    const src = 'function f() { return 1; }\n/["\']/.test(s);\nconst query = `SELECT 1`;\n';
    return blocks(src).length === 1;
});
assert('division after paren still finds sql', () => {
    const src = 'const n = (a + b) / 2;\nconst query = `SELECT id FROM users`;\n';
    return blocks(src).length === 1;
});
assert('object division still finds sql', () => {
    const src = 'const n = { a: 1 } / 2;\nconst query = `SELECT 1`;\n';
    return blocks(src).length === 1;
});
assert('typed query assign', () => blocks('const query: string = `SELECT 1`;').length === 1);
assert('function expression division still finds sql', () => {
    const src = 'const n = function () { return 1 } / 2;\nconst query = `SELECT 1`;\n';
    return blocks(src).length === 1;
});
assert('generic arrow does not hide sql', () => {
    const src = 'const C = <T,>(x: T) => {\n  const query = `SELECT 1`;\n  return x;\n};\n';
    return blocks(src, true).length === 1;
});
assert('regex interpolation stays one placeholder', () => {
    const b = blocks('const query = `SELECT ${/}/.test(id) ? id : 0} FROM users`;')[0];
    return b.text.includes('NULL') && b.text.includes('FROM') && !b.text.includes('.test');
});

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('All js-extract tests passed.');
