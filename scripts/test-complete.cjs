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

    const { SqlCompleter, completionFit, currentIdentPath } = require(path.join(outDir, 'completeSql.js'));
    runChecks(SqlCompleter, completionFit, currentIdentPath);
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

function makeTable(name, colNames, database = 'app', schema = database) {
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
        database,
        schema,
        name,
        fullName: `${schema}.${name}`,
        qualifiedName: `${database}.${schema}.${name}`,
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

function runChecks(SqlCompleter, completionFit, currentIdentPath) {
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

    const sel = withSchema.complete('sel', 3);
    const selectHit = sel?.items.find((hit) => hit.item.label === 'SELECT');
    assert(
        'SELECT insert is leftover only',
        selectHit && applyFit(completionFit, currentIdentPath, 'sel', selectHit.item.insertText),
        'SELECT '
    );

    const fromPartial = 'SELECT * f';
    const from = withSchema.complete(fromPartial, fromPartial.length);
    const fromHit = from?.items.find((hit) => hit.item.label === 'FROM');
    assert(
        'FROM insert is leftover only',
        fromHit && applyFit(completionFit, currentIdentPath, fromPartial, fromHit.item.insertText),
        'SELECT * FROM '
    );

    const usePartial = 'SELECT * FROM use';
    const use = withSchema.complete(usePartial, usePartial.length);
    const usersHit = use?.items.find((hit) => hit.item.kind === 'table' && hit.item.insertText === 'users');
    assert(
        'table insert is leftover only',
        usersHit &&
            applyFit(completionFit, currentIdentPath, usePartial, usersHit.item.insertText) ===
                'SELECT * FROM users',
        true
    );

    const dotted = 'SELECT * FROM datalign_ghma.roles_pol';
    assert(
        'path after a qualifier keeps the dotted name',
        currentIdentPath(dotted),
        'datalign_ghma.roles_pol'
    );
    assert(
        'after db.table prefix only the leftover letters are added',
        applyFit(completionFit, currentIdentPath, dotted, 'datalign_ghma.roles_policy_groups'),
        'SELECT * FROM datalign_ghma.roles_policy_groups'
    );
    assert(
        'after db. only the table name is added, not db.table again',
        applyFit(
            completionFit,
            currentIdentPath,
            'SELECT * FROM datalign_ghma.',
            'datalign_ghma.roles_policy_groups'
        ),
        'SELECT * FROM datalign_ghma.roles_policy_groups'
    );

    const roles = makeTable('roles_policy_groups', ['id'], 'datalign_ghma', 'datalign_ghma');
    const reasons = makeTable('reasons_mapping', ['id'], 'datalign_ghma', 'datalign_ghma');
    const extra = Array.from({ length: 90 }, (_, i) =>
        makeTable(`extra_table_${i}`, ['id'], 'datalign_ghma', 'datalign_ghma')
    );
    const other = makeTable('users', ['id'], 'other_db', 'other_schema');
    const multi = new SqlCompleter(makeDb([roles, reasons, other, ...extra]));
    const fromBlank = multi.complete('SELECT * FROM ', 'SELECT * FROM '.length);
    assert(
        'list still shows the database name',
        labels(multi, 'SELECT * FROM ').some((name) =>
            String(name).includes('datalign_ghma')
        ),
        true
    );
    const afterDbSql = 'SELECT * FROM datalign_ghma.';
    const afterDb = multi.complete(afterDbSql, afterDbSql.length);
    const afterDbNames = (afterDb?.items ?? [])
        .filter((hit) => hit.item.kind === 'table')
        .map((hit) => hit.item.insertText);
    assert(
        'after schema. lists every table in that schema',
        afterDbNames.includes('roles_policy_groups') &&
            afterDbNames.includes('reasons_mapping') &&
            afterDbNames.includes('extra_table_89') &&
            afterDbNames.length >= 92,
        true
    );
    assert(
        'after schema. does not list tables from other schemas',
        afterDbNames.includes('users'),
        false
    );
    const rolesHit = afterDb?.items.find((hit) => hit.item.insertText === 'roles_policy_groups');
    assert(
        'after schema. Enter adds only the table name',
        rolesHit &&
            applyFit(completionFit, currentIdentPath, afterDbSql, rolesHit.item.insertText) ===
                'SELECT * FROM datalign_ghma.roles_policy_groups',
        true
    );
    assert(
        'after FROM with no qualifier, insert still has the qualifier',
        fromBlank?.items.some(
            (hit) =>
                hit.item.kind === 'table' &&
                hit.item.insertText.includes('roles_policy_groups')
        ),
        true
    );

    const schemaOnly = new SqlCompleter(
        makeDb([
            makeTable('roles_policy_groups', ['id'], 'prod', 'datalign_ghma'),
            makeTable('users', ['id'], 'prod', 'other')
        ])
    );
    const afterSchema = labels(schemaOnly, 'SELECT * FROM datalign_ghma.');
    assert(
        'schema. lists tables even when the catalog name is different',
        afterSchema.some((name) => String(name).includes('roles_policy_groups')) &&
            !afterSchema.some((name) => String(name).endsWith('.users') || name === 'users'),
        true
    );

    const typedDb = 'SELECT * FROM datalign_ghma';
    const whileTypingDb = multi.complete(typedDb, typedDb.length);
    const dbInserts = (whileTypingDb?.items ?? [])
        .filter((hit) => hit.item.kind === 'table')
        .map((hit) => hit.item.insertText);
    assert(
        'while typing the db name, insert text still starts with those letters',
        dbInserts.length > 80 &&
            dbInserts.every((text) => text.toLowerCase().startsWith('datalign_ghma')),
        true
    );
    const typedTable = 'SELECT * FROM datalign_ghma.rol';
    const whileTypingTable = multi.complete(typedTable, typedTable.length);
    const tableInserts = (whileTypingTable?.items ?? [])
        .filter((hit) => hit.item.kind === 'table')
        .map((hit) => hit.item.insertText);
    assert(
        'while typing after db. insert text is the table name, starting with the prefix',
        tableInserts.includes('roles_policy_groups') &&
            tableInserts.every((text) => text.toLowerCase().startsWith('rol')),
        true
    );
}

function applyFit(completionFit, currentIdentPath, sql, suggestion) {
    const path = currentIdentPath(sql);
    const fit = completionFit(path, suggestion);
    if (fit.recase && sql.toLowerCase().endsWith(path.toLowerCase())) {
        return sql.slice(0, sql.length - path.length) + fit.recase + fit.addition;
    }
    if (fit.replaceToken) {
        const last = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path;
        return sql.slice(0, sql.length - last.length) + fit.addition;
    }
    return sql + fit.addition;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
