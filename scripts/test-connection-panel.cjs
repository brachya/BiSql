'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-connection-panel-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/ui/connectionPanelHtml.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'connectionPanelHtml.js')
});

const { panelStatsForSelection, saveResultMessage } = require(path.join(outDir, 'connectionPanelHtml.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : actual === check;
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', actual);
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

const html = fs.readFileSync(path.join(root, 'media/connection.html'), 'utf8');
const requiredIds = [
    'connectionId',
    'connName',
    'connList',
    'addConnBtn',
    'kindMssql',
    'kindMysql',
    'kindPostgres',
    'kindSupabase',
    'kindBigquery',
    'bqProject',
    'bqLoadProjectsBtn',
    'bqProjectList',
    'bqPickerMount',
    'mssqlServer',
    'mssqlPort',
    'mssqlUser',
    'mssqlPassword',
    'mssqlEncrypt',
    'mssqlTrust',
    'mssqlPickerMount',
    'mysqlServer',
    'pgServer',
    'pgDatabase',
    'pgLoadDbsBtn',
    'sbUrl',
    'sbPassword',
    'dbPicker',
    'dbList',
    'loadDbsBtn',
    'selectAllDbsBtn',
    'saveBtn',
    'testBtn',
    'connPanel',
    'typePanel',
    'mssqlServerPanel',
    'optsPanel'
];
for (const id of requiredIds) {
    assert('id ' + id, html.includes('id="' + id + '"'), true);
}
assert('uses details panels', (html.match(/<details class="xp"/g) || []).length >= 6, true);
assert('has placeholders', html.includes('{{csp}}') && html.includes('{{boot}}'), true);

const live = {
    selectedId: 'a',
    activeId: 'a',
    hasServer: true,
    liveState: 'connected',
    lastError: 'old',
    tableCount: 338,
    stale: true
};
assert('active keeps tables', panelStatsForSelection(live).tableCount, 338);
assert('active keeps state', panelStatsForSelection(live).state, 'connected');
assert(
    'new row hides tables',
    panelStatsForSelection({ ...live, selectedId: 'new', activeId: 'a', hasServer: false }).tableCount,
    0
);
assert(
    'new row is unconfigured',
    panelStatsForSelection({ ...live, selectedId: 'new', activeId: 'a', hasServer: false }).state,
    'unconfigured'
);
assert(
    'other filled row is disconnected',
    panelStatsForSelection({ ...live, selectedId: 'b', hasServer: true }).state,
    'disconnected'
);
assert(
    'empty active hides leftover schema',
    panelStatsForSelection({ ...live, hasServer: false }).tableCount,
    0
);

assert(
    'save connected is ok',
    saveResultMessage({
        connected: true,
        connectionState: 'connected',
        tables: 12,
        dbLabel: 'analytics',
        loginKind: 'bigquery'
    }).ok,
    true
);
assert(
    'save disconnected bigquery is ok',
    saveResultMessage({
        connected: false,
        connectionState: 'disconnected',
        tables: 0,
        dbLabel: 'analytics',
        loginKind: 'bigquery'
    }).ok,
    true
);
assert(
    'save disconnected bigquery mentions test',
    saveResultMessage({
        connected: false,
        connectionState: 'disconnected',
        tables: 0,
        dbLabel: 'analytics',
        loginKind: 'bigquery'
    }).message.includes('Test Connection'),
    true
);
assert(
    'save auth error is not ok',
    saveResultMessage({
        connected: false,
        connectionState: 'error',
        lastError: 'Could not refresh access token',
        tables: 0,
        dbLabel: 'analytics',
        loginKind: 'bigquery'
    }).ok,
    false
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
