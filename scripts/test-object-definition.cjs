'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-object-definition-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/sql/objectDefinition.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'objectDefinition.js'),
    external: ['mssql', 'mysql2', 'pg', '@google-cloud/bigquery']
});

const { buildObjectDefinitionQuery, extractDefinitionText, buildTableDefinitionFromCache } = require(path.join(
    outDir,
    'objectDefinition.js'
));

const table = {
    database: 'app',
    schema: 'public',
    name: 'users',
    fullName: 'public.users',
    qualifiedName: 'public.users',
    isView: false,
    columns: [],
    columnsByLower: new Map()
};

const view = { ...table, name: 'active_users', isView: true, qualifiedName: 'public.active_users' };

assert.match(buildObjectDefinitionQuery(table, 'mysql'), /^SHOW CREATE TABLE/);
assert.match(buildObjectDefinitionQuery(view, 'mysql'), /^SHOW CREATE VIEW/);
assert.match(buildObjectDefinitionQuery(view, 'postgres'), /pg_get_viewdef/);
assert.match(buildObjectDefinitionQuery(view, 'postgres'), /format\('%I\.%I'/);
assert.match(buildObjectDefinitionQuery(table, 'postgres'), /PRIMARY KEY/);

const mysqlResult = {
    ok: true,
    columns: ['Table', 'Create Table'],
    rows: [['users', 'CREATE TABLE `users` (\n  id int\n)']]
};
assert.strictEqual(extractDefinitionText(mysqlResult), 'CREATE TABLE `users` (\n  id int\n)');

const nullCell = {
    ok: true,
    columns: ['definition'],
    rows: [['NULL']],
    rawRows: [[null]]
};
assert.strictEqual(extractDefinitionText(nullCell), undefined);
assert.strictEqual(
    extractDefinitionText({ ok: true, columns: ['definition'], rows: [['NULL']] }),
    undefined
);

const mssqlTable = {
    database: 'app',
    schema: 'dbo',
    name: 'users',
    fullName: 'dbo.users',
    qualifiedName: 'app.dbo.users',
    isView: false,
    columns: [
        {
            name: 'id',
            ordinal: 1,
            typeName: 'int',
            typeDisplay: 'int',
            isNullable: false,
            isIdentity: true,
            isComputed: false,
            isPrimaryKey: true
        }
    ],
    columnsByLower: new Map(),
    foreignKeys: []
};
const mssqlDdl = buildTableDefinitionFromCache(mssqlTable, 'mssql');
assert.ok(mssqlDdl.includes('[id] int NOT NULL'));
assert.ok(!mssqlDdl.includes('IDENTITY'));

console.log('test-object-definition: ok');
