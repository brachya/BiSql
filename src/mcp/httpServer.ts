import { createServer, IncomingMessage, Server as NodeHttpServer, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
    localhostHostValidation,
    localhostOriginValidation,
    toNodeHandler
} from '@modelcontextprotocol/node';
import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { MCP_INSTRUCTIONS, registerBisqlDocs } from './guide';
import { MCP_SERVER_NAME } from './identity';
import {
    isPublicIconPath,
    loadExtensionPngIcon,
    loadExtensionSvgIcon,
    pngIconFromBytes,
    pngIconFromUrl,
    svgIconFromText
} from './icon';
import { ResultsPanel } from '../ui/resultsPanel';
import { registerBisqlTools, SerialGate } from './tools';

export interface McpHttpHandle {
    readonly port: number;
    readonly token: string;
    close(): Promise<void>;
}

export async function startMcpHttpServer(
    db: SqlServerService,
    output: vscode.OutputChannel,
    version: string,
    token: string,
    extensionRoot: string,
    preferredPort?: number
): Promise<McpHttpHandle> {
    const gate = new SerialGate();
    const iconPng = loadExtensionPngIcon(extensionRoot);
    const iconSvg = loadExtensionSvgIcon(extensionRoot);
    if (!iconPng && !iconSvg) {
        output.appendLine('[mcp] extension icon missing; MCP will have no icon.');
    }

    let nodeHandler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    const httpServer = createServer((req, res) => {
        if (!validateHost(req, res)) {
            return;
        }
        if (req.method === 'GET' && tryServePublicIcon(req, res, iconPng)) {
            return;
        }
        if (!validateOrigin(req, res)) {
            return;
        }
        if (!tokenMatches(req, token)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden');
            return;
        }
        if (!nodeHandler) {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Starting');
            return;
        }
        void nodeHandler(req, res);
    });
    httpServer.on('error', (error) => {
        output.appendLine(`[mcp] http server error: ${error.message}`);
    });

    await listenPreferred(httpServer, preferredPort);
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
        httpServer.close();
        throw new Error('MCP HTTP server did not bind a TCP port.');
    }

    const icons = [
        ...(iconPng ? [pngIconFromBytes(iconPng)] : []),
        ...(iconSvg ? [svgIconFromText(iconSvg)] : []),
        ...(iconPng ? [pngIconFromUrl(`http://127.0.0.1:${address.port}/icon.png`)] : [])
    ];
    const handler = createMcpHandler(
        () => {
            const server = new McpServer(
                {
                    name: MCP_SERVER_NAME,
                    title: MCP_SERVER_NAME,
                    version,
                    ...(icons.length > 0 ? { icons } : {})
                },
                { instructions: MCP_INSTRUCTIONS }
            );
            registerBisqlTools(server, db, gate, {
                loginHint: 'Run BiSql: Open Connection / Login.',
                showResult: (result) => ResultsPanel.show(result, db, { preserveFocus: true })
            });
            registerBisqlDocs(server);
            return server;
        },
        {
            responseMode: 'json',
            onerror: (error) => {
                output.appendLine(`[mcp] ${error.message}`);
            }
        }
    );
    nodeHandler = toNodeHandler(handler, {
        onerror: (error) => {
            output.appendLine(`[mcp] adapter: ${error.message}`);
        }
    });

    return {
        port: address.port,
        token,
        async close() {
            await handler.close().catch(() => undefined);
            await closeHttp(httpServer);
        }
    };
}

function tryServePublicIcon(
    req: IncomingMessage,
    res: ServerResponse,
    iconPng: Buffer | undefined
): boolean {
    let pathname = '';
    try {
        pathname = new URL(req.url ?? '', 'http://127.0.0.1').pathname;
    } catch {
        return false;
    }
    if (!isPublicIconPath(pathname)) {
        return false;
    }
    if (!iconPng) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return true;
    }
    res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': iconPng.length
    });
    res.end(iconPng);
    return true;
}

function tokenMatches(req: IncomingMessage, expected: string): boolean {
    const url = req.url ?? '';
    let provided: string | null = null;
    try {
        provided = new URL(url, 'http://127.0.0.1').searchParams.get('token');
    } catch {
        provided = null;
    }
    if (!provided) {
        return false;
    }
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

async function listenPreferred(server: NodeHttpServer, preferredPort?: number): Promise<void> {
    if (preferredPort && preferredPort > 0 && preferredPort <= 65535) {
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                await listenLoopback(server, preferredPort);
                return;
            } catch (error) {
                if (!isAddrInUse(error)) {
                    throw error;
                }
                await delay(50 * (attempt + 1));
            }
        }
    }
    await listenLoopback(server, 0);
}

function listenLoopback(server: NodeHttpServer, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
    });
}

function isAddrInUse(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeHttp(server: NodeHttpServer): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}
