'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-mcp-cache-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const azureAliases = {
    '@azure/identity': path.join(root, 'scripts/azure-stubs/identity.js'),
    '@azure/core-auth': path.join(root, 'scripts/azure-stubs/core-auth.js'),
    '@azure/keyvault-keys': path.join(root, 'scripts/azure-stubs/keyvault-keys.js'),
    vscode: path.join(root, 'scripts/vscode-stub.js')
};

function bundle(entry, outfile) {
    esbuild.buildSync({
        entryPoints: [path.join(root, entry)],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: path.join(outDir, outfile),
        alias: azureAliases
    });
}

bundle('src/mcpCli/cacheDir.ts', 'cacheDir.js');
bundle('src/mcpCli/connectionUrl.ts', 'connectionUrl.js');
bundle('src/mcpCli/envPorts.ts', 'envPorts.js');
bundle('src/db/sqlServerService.ts', 'sqlServerService.js');
bundle('src/db/config.ts', 'config.js');

const { resolveBisqlCacheDir, cacheFiles } = require(path.join(outDir, 'cacheDir.js'));
const { parseBisqlUrl } = require(path.join(outDir, 'connectionUrl.js'));
const { buildEnvPorts } = require(path.join(outDir, 'envPorts.js'));
const { SqlServerService } = require(path.join(outDir, 'sqlServerService.js'));
const { CACHE_VERSION } = require(path.join(outDir, 'config.js'));

function assert(name, actual, check) {
    const ok =
        typeof check === 'function'
            ? check(actual)
            : JSON.stringify(actual) === JSON.stringify(check);
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', JSON.stringify(actual, null, 2));
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

assert('default cache dir', resolveBisqlCacheDir(undefined, '/home/me'), '/home/me/.cache/bisql');
assert('off disables cache', resolveBisqlCacheDir('off', '/home/me'), undefined);
assert('empty disables cache', resolveBisqlCacheDir('  ', '/home/me'), undefined);
assert('false disables cache', resolveBisqlCacheDir('false', '/home/me'), undefined);
assert(
    'custom cache dir',
    resolveBisqlCacheDir('rel/cache', '/home/me'),
    path.resolve('rel/cache')
);

const cacheRoot = path.join(outDir, 'files');
const files = cacheFiles(cacheRoot);

async function main() {
    await files.write('schema-abc.json', Buffer.from('{"ok":true}'));
    const bytes = await files.read('schema-abc.json');
    assert('cache file roundtrip', Buffer.from(bytes).toString('utf8'), '{"ok":true}');
    let rejected = false;
    try {
        await files.read('../outside.json');
    } catch {
        rejected = true;
    }
    assert('cache file rejects parent path', rejected, true);
    await files.delete('schema-abc.json');
    let missing = false;
    try {
        await files.read('schema-abc.json');
    } catch {
        missing = true;
    }
    assert('cache file delete', missing, true);

    const parsed = parseBisqlUrl('postgresql://u:p@db.example.com:5432/app');
    const schemaDir = path.join(outDir, 'schema');
    const { ports, primeSecrets } = buildEnvPorts({
        profile: parsed.value.profile,
        password: parsed.value.password,
        allowMutating: false,
        maxResultRows: 50,
        bigqueryConfirmScanMb: 1024,
        cacheDir: schemaDir
    });
    await primeSecrets();

    const db = new SqlServerService(ports);
    const key = db.connectionKey(db.getConfig());
    const maxAgeMs = 30 * 60 * 1000;
    const snapshot = {
        version: CACHE_VERSION,
        connectionKey: key,
        fetchedAt: Date.now(),
        tables: [
            {
                db: 'app',
                s: 'public',
                n: 'users',
                v: false,
                c: [
                    {
                        n: 'id',
                        o: 1,
                        t: 'int4',
                        d: 'int4',
                        nu: false,
                        id: true,
                        co: false,
                        pk: true
                    }
                ]
            }
        ]
    };
    fs.mkdirSync(schemaDir, { recursive: true });
    const fileName = path.join(schemaDir, `schema-${key}.json`);
    fs.writeFileSync(fileName, JSON.stringify(snapshot));

    const loaded = await db.loadDiskCache(maxAgeMs);
    assert('young snapshot loads', loaded, true);
    assert('young snapshot is fresh', db.schema.stale, false);
    assert('young snapshot table', db.schema.tables.length, 1);

    const again = new SqlServerService(ports);
    snapshot.fetchedAt = Date.now() - maxAgeMs;
    fs.writeFileSync(fileName, JSON.stringify(snapshot));
    const skipped = await again.loadDiskCache(maxAgeMs);
    assert('30 minute snapshot is not reused', skipped, false);
    assert('old snapshot leaves schema empty', again.schema.isEmpty, true);

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main().catch((error) => {
    console.error('FAIL', error);
    process.exit(1);
});
