'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-bq-run-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const bqStub = path.join(outDir, 'bq-stub.js');
fs.writeFileSync(bqStub, 'module.exports = { BigQuery: class BigQuery {} };\n');
const authStub = path.join(outDir, 'auth-stub.js');
fs.writeFileSync(authStub, 'module.exports = { GoogleAuth: class GoogleAuth {} };\n');

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/db/bigquery.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'bigquery.js'),
    alias: {
        '@google-cloud/bigquery': bqStub,
        'google-auth-library': authStub
    }
});

const {
    bigqueryQueryParams,
    shouldConfirmScan,
    formatScanBytes,
    explainRowsFromDryRun,
    parseScanBytes,
    bigqueryStatsFromMetadata,
    finishedJobStats
} = require(path.join(outDir, 'bigquery.js'));

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

const mb = 1024 * 1024;
assert('under threshold does not confirm', shouldConfirmScan(mb, 1024), false);
assert('exact threshold does not confirm', shouldConfirmScan(1024 * mb, 1024), false);
assert('one byte over confirms', shouldConfirmScan(1024 * mb + 1, 1024), true);
assert('zero bytes does not confirm', shouldConfirmScan(0, 1024), false);
assert('missing estimate does not confirm', shouldConfirmScan(undefined, 1024), false);
assert('threshold 0 confirms any scan', shouldConfirmScan(1, 0), true);

const withNull = bigqueryQueryParams({ path: null, name: 'ok' });
assert('null bind is STRING', withNull.types && withNull.types.path, 'STRING');
assert('value bind is STRING', withNull.types && withNull.types.name, 'STRING');
assert('params keep null', withNull.params && withNull.params.path, null);
assert('empty params omit types', Object.keys(bigqueryQueryParams({})).length, 0);

assert('parse empty is missing', parseScanBytes(''), undefined);
assert('parse digits', parseScanBytes('2048'), 2048);
assert('parse number', parseScanBytes(4096), 4096);

const fromJobTotal = bigqueryStatsFromMetadata({
    statistics: { totalBytesProcessed: '1024', query: { statementType: 'SELECT' } }
});
assert('job-level bytes', fromJobTotal.totalBytesProcessed, '1024');
assert('job-level keeps query fields', fromJobTotal.statementType, 'SELECT');

const fromEstimate = bigqueryStatsFromMetadata({
    statistics: { query: { estimatedBytesProcessed: 2048, statementType: 'SELECT' } }
});
assert('estimated bytes fallback', fromEstimate.totalBytesProcessed, '2048');

const rows = explainRowsFromDryRun({
    statementType: 'SELECT',
    totalBytesProcessed: String(2 * 1024 * 1024 * 1024),
    totalBytesProcessedAccuracy: 'PRECISE',
    cacheHit: false,
    referencedTables: [
        { projectId: 'p', datasetId: 'ds', tableId: 'events' }
    ],
    schema: { fields: [{ name: 'id' }, { name: 'name' }] }
});
assert('explain has property column', rows[0][0], 'Statement type');
assert('explain statement', rows[0][1], 'SELECT');
assert('explain bytes', rows[1][1], '2.0 GB');
assert('explain accuracy', rows[2][1], 'PRECISE');
assert('explain cache', rows[3][1], 'false');
assert('explain tables', rows[4][1], 'p.ds.events');
assert('explain columns', rows[5][1], 'id, name');

assert('format bytes', formatScanBytes(500), '500 B');
assert('format kb', formatScanBytes(2048), '2.0 KB');

if (process.exitCode) {
    process.exit(process.exitCode);
}

(async () => {
    let refreshed = 0;
    const fromFirst = await finishedJobStats(
        { statistics: { totalBytesProcessed: '1024' } },
        async () => {
            refreshed += 1;
            return { statistics: { totalBytesProcessed: '9999' } };
        }
    );
    assert('finished job keeps first bytes', fromFirst.totalBytesProcessed, '1024');
    assert('finished job skips refresh when bytes exist', refreshed, 0);

    const fromRefresh = await finishedJobStats({ statistics: { query: { statementType: 'SELECT' } } }, async () => {
        refreshed += 1;
        return { statistics: { totalBytesProcessed: '2048' } };
    });
    assert('finished job refreshes when bytes are missing', fromRefresh.totalBytesProcessed, '2048');
    assert('finished job called refresh once', refreshed, 1);

    const afterFail = await finishedJobStats({ statistics: { query: { statementType: 'SELECT' } } }, async () => {
        throw new Error('metadata unavailable');
    });
    assert('finished job keeps first stats when refresh fails', afterFail.statementType, 'SELECT');
    if (process.exitCode) {
        process.exit(process.exitCode);
    }
    console.log('All BigQuery run helper tests passed.');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
