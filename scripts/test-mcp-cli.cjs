'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-mcp-cli-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/mcpCli/connectionUrl.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'connectionUrl.js')
});

const { parseBisqlUrl } = require(path.join(outDir, 'connectionUrl.js'));

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

assert('empty url', parseBisqlUrl(''), (r) => !r.ok);
assert('bad scheme', parseBisqlUrl('https://x/y'), (r) => !r.ok);

const pg = parseBisqlUrl('postgresql://u:p@db.example.com:5432/app');
assert('postgres ok', pg, (r) => r.ok && r.value.profile.engine === 'postgres');
assert('postgres host', pg, (r) => r.ok && r.value.profile.server === 'db.example.com');
assert('postgres password', pg, (r) => r.ok && r.value.password === 'p');
assert('postgres require skips cert', pg, (r) => r.ok && r.value.profile.trustServerCertificate === true);

const pgVerify = parseBisqlUrl(
    'postgresql://u:p@db.example.com:5432/app?sslmode=verify-full'
);
assert('postgres verify-full checks cert', pgVerify, (r) => r.ok && r.value.profile.trustServerCertificate === false);

const pgTrust = parseBisqlUrl(
    'postgresql://u:p@db.example.com:5432/app?trustServerCertificate=true'
);
assert('postgres trust opt-in', pgTrust, (r) => r.ok && r.value.profile.trustServerCertificate === true);

const mysql = parseBisqlUrl('mysql://root:secret@127.0.0.1:3306/shop?databases=shop,archive');
assert('mysql ok', mysql, (r) => r.ok && r.value.profile.engine === 'mysql');
assert('mysql databases', mysql, (r) => r.ok && r.value.profile.databases.length === 2);

const mssql = parseBisqlUrl(
    'mssql://sa:Pass@sqlhost:1433/WideWorld?trustServerCertificate=true&databases=WideWorld'
);
assert('mssql ok', mssql, (r) => r.ok && r.value.profile.engine === 'mssql');
assert('mssql trust', mssql, (r) => r.ok && r.value.profile.trustServerCertificate === true);

const mssqlInstance = parseBisqlUrl('mssql://sa:Pass@localhost\\SQLEXPRESS/WideWorld');
assert('mssql instance server', mssqlInstance, (r) => r.ok && r.value.profile.server === 'localhost\\SQLEXPRESS');
assert('mssql instance db', mssqlInstance, (r) => r.ok && r.value.profile.database === 'WideWorld');

const bq = parseBisqlUrl('bigquery://my-proj/analytics?projects=other-proj');
assert('bigquery ok', bq, (r) => r.ok && r.value.profile.engine === 'bigquery');
assert('bigquery project', bq, (r) => r.ok && r.value.profile.server === 'my-proj');
assert('bigquery dataset', bq, (r) => r.ok && r.value.profile.database === 'analytics');

function buildMcpBundle() {
    fs.mkdirSync(path.join(root, 'npm/bisql-mcp/dist'), { recursive: true });
    esbuild.buildSync({
        entryPoints: [path.join(root, 'src/mcpCli/main.ts')],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        outfile: path.join(root, 'npm/bisql-mcp/dist/index.cjs'),
        banner: { js: '#!/usr/bin/env node' },
        alias: {
            '@azure/identity': path.join(root, 'scripts/azure-stubs/identity.js'),
            '@azure/core-auth': path.join(root, 'scripts/azure-stubs/core-auth.js'),
            '@azure/keyvault-keys': path.join(root, 'scripts/azure-stubs/keyvault-keys.js'),
            vscode: path.join(root, 'scripts/vscode-stub.js')
        }
    });
}

class StdioReader {
    constructor(onMessage) {
        this.buf = '';
        this.onMessage = onMessage;
    }

    push(chunk) {
        this.buf += chunk.toString('utf8');
        let index = this.buf.indexOf('\n');
        while (index >= 0) {
            const line = this.buf.slice(0, index).trim();
            this.buf = this.buf.slice(index + 1);
            if (line.length > 0) {
                this.onMessage(JSON.parse(line));
            }
            index = this.buf.indexOf('\n');
        }
    }
}

function writeMessage(proc, message) {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function runStdioChecks() {
    buildMcpBundle();
    return new Promise((resolve, reject) => {
        const cli = path.join(root, 'npm/bisql-mcp/dist/index.cjs');

        const proc = spawn(process.execPath, [cli], {
            env: {
                ...process.env,
                BISQL_URL: 'postgres://u:p@127.0.0.1:1/nodb',
                BISQL_CACHE_DIR: 'off'
            },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const responses = new Map();
        const reader = new StdioReader((msg) => {
            if (msg.id !== undefined) {
                responses.set(msg.id, msg);
            }
        });

        let stdoutNonJson = '';
        proc.stdout.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            if (!text.includes('{')) {
                stdoutNonJson += text;
            }
            reader.push(chunk);
        });

        proc.stderr.on('data', () => {
            // diagnostics only
        });

        proc.on('error', reject);

        writeMessage(proc, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'bisql-test', version: '0' }
            }
        });

        const deadline = Date.now() + 15000;
        const poll = () => {
            if (responses.has(1) && !responses.has(2)) {
                writeMessage(proc, {
                    jsonrpc: '2.0',
                    method: 'notifications/initialized',
                    params: {}
                });
                writeMessage(proc, {
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/list',
                    params: {}
                });
            }
            if (responses.has(2) && !responses.has(3)) {
                writeMessage(proc, {
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'tools/call',
                    params: {
                        name: 'bisql_status',
                        arguments: {}
                    }
                });
            }
            if (responses.has(3) && !responses.has(4)) {
                writeMessage(proc, {
                    jsonrpc: '2.0',
                    id: 4,
                    method: 'tools/call',
                    params: {
                        name: 'bisql_run_sql',
                        arguments: { sql: 'DELETE FROM t' }
                    }
                });
            }
            if (responses.has(4) && !responses.has(5)) {
                writeMessage(proc, {
                    jsonrpc: '2.0',
                    id: 5,
                    method: 'tools/call',
                    params: {
                        name: 'bisql_run_sql',
                        arguments: { sql: 'CALL refresh_stats()' }
                    }
                });
            }
            if (responses.has(5) && !responses.has(6)) {
                writeMessage(proc, {
                    jsonrpc: '2.0',
                    id: 6,
                    method: 'tools/call',
                    params: {
                        name: 'bisql_run_sql',
                        arguments: { sql: "COPY users FROM '/tmp/load.csv'" }
                    }
                });
            }
            if (responses.has(6)) {
                try {
                    const list = responses.get(2);
                    const tools = list.result?.tools ?? [];
                    assert('stdio tools/list count', tools.length, 10);
                    const status = responses.get(3);
                    const statusPayload = JSON.parse(status.result.content[0].text);
                    assert('stdio bisql_status engine', statusPayload.engine, 'postgres');

                    const blocked = (id) => {
                        const run = responses.get(id);
                        const runPayload = JSON.parse(run.result.content[0].text);
                        return runPayload.ok === false && /mutating/i.test(runPayload.error ?? '');
                    };
                    assert('stdio DELETE blocked', blocked(4), true);
                    assert('stdio CALL blocked', blocked(5), true);
                    assert('stdio COPY blocked', blocked(6), true);
                    assert('stdio stdout clean', stdoutNonJson.trim(), '');
                } finally {
                    proc.kill();
                    resolve();
                }
                return;
            }
            if (Date.now() > deadline) {
                proc.kill();
                reject(new Error('Timed out waiting for MCP stdio responses'));
                return;
            }
            setTimeout(poll, 50);
        };
        poll();
    });
}

runStdioChecks()
    .then(() => {
        if (process.exitCode) {
            process.exit(process.exitCode);
        }
    })
    .catch((error) => {
        console.error('FAIL stdio harness', error.message);
        process.exit(1);
    });
