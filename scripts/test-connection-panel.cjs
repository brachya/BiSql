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

const { expansionPanel, connectionPanelHtml, panelStatsForSelection } = require(path.join(
    outDir,
    'connectionPanelHtml.js'
));

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

const open = expansionPanel('serverPanel', 'Server', 'Host and port', '<input id="host" />', true);
assert('open details', open.includes('<details class="xp" id="serverPanel" open>'), true);
assert('hint id', open.includes('id="serverPanelHint">Host and port<'), true);
assert('body inside', open.includes('<div class="xp-body"><input id="host" /></div>'), true);
assert('summary title', open.includes('<span class="xp-title">Server</span>'), true);

const closed = expansionPanel('secPanel', 'Security', 'TLS', '<label>TLS</label>', false);
assert('closed has no open', closed.includes('id="secPanel"') && !closed.includes('id="secPanel" open'), true);

const html = connectionPanelHtml('testnonce');
const requiredIds = [
    'connectionId',
    'connName',
    'connList',
    'addConnBtn',
    'kindMssql',
    'kindMysql',
    'kindPostgres',
    'kindSupabase',
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

if (process.exitCode) {
    process.exit(process.exitCode);
}
