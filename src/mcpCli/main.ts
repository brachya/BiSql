import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SqlServerService } from '../db/connection';
import { registerBisqlDocs, MCP_INSTRUCTIONS } from '../mcp/guide';
import { MCP_SERVER_NAME } from '../mcp/identity';
import { registerBisqlTools, SerialGate } from '../mcp/tools';
import { parseBisqlUrl } from './connectionUrl';
import { buildEnvPorts } from './envPorts';

const PACKAGE_VERSION = '0.1.0';

function envFlag(name: string): boolean {
    const raw = (process.env[name] ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

function envInt(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.floor(value)));
}

async function main(): Promise<void> {
    const url = process.env.BISQL_URL?.trim();
    if (!url) {
        process.stderr.write('BISQL_URL is required (postgres://, mysql://, mssql://, or bigquery://).\n');
        process.exit(1);
    }

    const parsed = parseBisqlUrl(url);
    if (!parsed.ok) {
        process.stderr.write(`${parsed.error}\n`);
        process.exit(1);
    }

    const { ports, primeSecrets } = buildEnvPorts({
        profile: parsed.value.profile,
        password: parsed.value.password,
        allowMutating: envFlag('BISQL_ALLOW_MUTATING'),
        maxResultRows: envInt('BISQL_MAX_ROWS', 50, 1, 1000),
        bigqueryConfirmScanMb: envInt('BISQL_BIGQUERY_CONFIRM_SCAN_MB', 1024, 0, 1_000_000)
    });
    await primeSecrets();

    const db = new SqlServerService(ports);
    const gate = new SerialGate();

    serveStdio(
        () => {
            const server = new McpServer(
                {
                    name: MCP_SERVER_NAME,
                    title: MCP_SERVER_NAME,
                    version: PACKAGE_VERSION
                },
                { instructions: MCP_INSTRUCTIONS }
            );
            registerBisqlTools(server, db, gate, {
                loginHint: 'Check BISQL_URL and that this process can reach the database.'
            });
            registerBisqlDocs(server);
            return server;
        },
        {
            onerror: (error) => {
                ports.log.appendLine(`[mcp] ${error.message}`);
            }
        }
    );
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
