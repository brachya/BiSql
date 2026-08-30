'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-complete-${process.pid}`);
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

const connectionStub = path.join(outDir, 'connection.js');
fs.writeFileSync(
    connectionStub,
    [
        "function defaultSchemaForEngine(engine) {",
        "    if (engine === 'mysql') return undefined;",
        "    return engine === 'postgres' ? 'public' : 'dbo';",
        '}',
        'module.exports = { defaultSchemaForEngine };',
        ''
    ].join('\n')
);

async function main() {
    await esbuild.build({
        entryPoints: [path.join(root, 'src/sql/completeSql.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: path.join(outDir, 'completeSql.js'),
        alias: { vscode: vscodeStub },
        plugins: [
            {
                name: 'stub-connection',
                setup(build) {
                    build.onResolve({ filter: /db\/connection/ }, () => ({
                        path: connectionStub
                    }));
                }
            }
        ]
    });

    const { SqlCompleter } = require(path.join(outDir, 'completeSql.js'));
    runChecks(SqlCompleter);
    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

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
    return {
        database: 'app',
        schema: 'app',
        name,
        fullName: `app.${name}`,
        qualifiedName: `app.app.${name}`,
        isView: false,
        columns,
        columnsByLower: new Map(columns.map((column) => [column.name.toLowerCase(), column]))
    };
}

function makeDb(tables, keywordCase = 'upper') {
    const byName = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
    return {
        schema: {
            isEmpty: tables.length === 0,
            tables,
            findTable: (reference) => byName.get(String(reference).toLowerCase())
        },
        getConfig: () => ({
            engine: 'mysql',
            database: 'app',
            formatKeywordCase: keywordCase
        })
    };
}

function labels(completer, sql, offset = sql.length) {
    const result = completer.complete(sql, offset);
    return (result?.items ?? []).map((hit) => hit.item.label);
}

function kinds(completer, sql, offset = sql.length) {
    const result = completer.complete(sql, offset);
    return (result?.items ?? []).map((hit) => hit.item.kind);
}

function runChecks(SqlCompleter) {
    const users = makeTable('users', ['id', 'name']);
    const sellers = makeTable('sellers', ['id']);
    const withSchema = new SqlCompleter(makeDb([users, sellers]));
    const emptySchema = new SqlCompleter(makeDb([]));
    const lowerCase = new SqlCompleter(makeDb([users], 'lower'));

    assert(
        'typing sel suggests SELECT',
        labels(withSchema, 'sel').includes('SELECT'),
        true
    );

    assert(
        'SELECT sits at the top when typing sel',
        labels(withSchema, 'sel')[0],
        'SELECT'
    );

    assert(
        'after SELECT * f suggests FROM',
        labels(withSchema, 'SELECT * f').includes('FROM'),
        true
    );

    assert(
        'empty prefix after a star still offers FROM',
        labels(withSchema, 'SELECT * ').includes('FROM'),
        true
    );

    assert(
        'dot after a table does not offer keywords',
        kinds(withSchema, 'SELECT * FROM users.').includes('keyword'),
        false
    );

    assert(
        'dot after a table still offers columns',
        labels(withSchema, 'SELECT * FROM users.').includes('id'),
        true
    );

    assert(
        'keywords work with no schema cache',
        labels(emptySchema, 'whe').includes('WHERE'),
        true
    );

    const afterFrom = withSchema.complete('SELECT * FROM ', 'SELECT * FROM '.length);
    assert(
        'after FROM space prefers tables, not a keyword dump',
        afterFrom &&
            afterFrom.items.some((hit) => hit.item.kind === 'table') &&
            !afterFrom.items.some((hit) => hit.item.kind === 'keyword'),
        true
    );

    assert(
        'keyword case follows format setting',
        labels(lowerCase, 'sel').includes('select'),
        true
    );

    assert(
        'order expands to ORDER BY',
        labels(withSchema, 'SELECT * FROM users ord').includes('ORDER BY'),
        true
    );

    assert(
        'does not offer a bare ORDER next to ORDER BY',
        labels(withSchema, 'SELECT * FROM users ord').includes('ORDER'),
        false
    );

    assert(
        'after ORDER a space offers BY',
        labels(withSchema, 'SELECT * FROM users order ').join(','),
        'BY'
    );

    assert(
        'left expands to LEFT JOIN',
        labels(withSchema, 'SELECT * FROM users lef').includes('LEFT JOIN'),
        true
    );

    assert(
        'after LEFT a space offers JOIN',
        labels(withSchema, 'SELECT * FROM users left ').includes('JOIN'),
        true
    );

    assert(
        'group expands to GROUP BY in lowercase mode',
        labels(lowerCase, 'SELECT * FROM users gro').includes('group by'),
        true
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
