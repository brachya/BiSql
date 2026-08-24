import { createServer, IncomingMessage, Server as NodeHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
    localhostHostValidation,
    localhostOriginValidation,
    toNodeHandler
} from '@modelcontextprotocol/node';
import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
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
    token: string
): Promise<McpHttpHandle> {
    const gate = new SerialGate();
    const handler = createMcpHandler(
        () => {
            const server = new McpServer({ name: 'bisql', version });
            registerBisqlTools(server, db, gate);
            return server;
        },
        {
            responseMode: 'json',
            onerror: (error) => {
                output.appendLine(`[mcp] ${error.message}`);
            }
        }
    );

    const nodeHandler = toNodeHandler(handler, {
        onerror: (error) => {
            output.appendLine(`[mcp] adapter: ${error.message}`);
        }
    });
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    const httpServer = createServer((req, res) => {
        if (!validateHost(req, res) || !validateOrigin(req, res)) {
            return;
        }
        if (!tokenMatches(req, token)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden');
            return;
        }
        void nodeHandler(req, res);
    });

    await listenLoopback(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
        httpServer.close();
        throw new Error('MCP HTTP server did not bind a TCP port.');
    }

    return {
        port: address.port,
        token,
        async close() {
            await handler.close().catch(() => undefined);
            await closeHttp(httpServer);
        }
    };
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

function listenLoopback(server: NodeHttpServer): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('error', onError);
            reject(error);
        };
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });
}

function closeHttp(server: NodeHttpServer): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}
