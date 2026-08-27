import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { startMcpHttpServer } from './httpServer';
import { MCP_SERVER_NAME } from './identity';

const MCP_PORT_STATE = 'bisql.mcpHttpPort';
const MCP_TOKEN_STATE = 'bisql.mcpHttpToken';

export async function startBisqlMcp(
    context: vscode.ExtensionContext,
    db: SqlServerService,
    output: vscode.OutputChannel
): Promise<vscode.Disposable | undefined> {
    if (!db.getConfig().mcpEnabled) {
        output.appendLine('[mcp] disabled (bisql.mcpEnabled).');
        return undefined;
    }

    const cursor = vscode.cursor;
    if (!cursor?.mcp?.registerServer) {
        output.appendLine(
            '[mcp] Cursor MCP API is not available. This feature only works inside Cursor.'
        );
        return undefined;
    }

    // Same URL after reload. Cursor treats ECONNREFUSED as fatal if the port/token change.
    const token = savedToken(context) ?? randomBytes(32).toString('hex');
    const version = String(context.extension.packageJSON.version ?? '0.0.0');
    const http = await startMcpHttpServer(
        db,
        output,
        version,
        token,
        context.extensionPath,
        savedPort(context)
    );
    await context.workspaceState.update(MCP_TOKEN_STATE, http.token);
    await context.workspaceState.update(MCP_PORT_STATE, http.port);
    const url = `http://127.0.0.1:${http.port}/mcp?token=${token}`;
    const iconUri = vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.png')).toString();
    unregisterLegacyNames(cursor);

    try {
        registerBisqlServer(cursor, url, iconUri);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[mcp] registerServer failed: ${message}`);
        await http.close();
        return undefined;
    }

    output.appendLine(`[mcp] listening on 127.0.0.1:${http.port} as ${MCP_SERVER_NAME}`);

    const pluginDir = path.join(context.extensionPath, 'cursor-plugins', 'bisql');
    let pluginRegistered = false;
    try {
        if (cursor.plugins?.registerPath) {
            cursor.plugins.registerPath(pluginDir);
            pluginRegistered = true;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[mcp] plugin path skipped: ${message}`);
    }

    return new vscode.Disposable(() => {
        try {
            cursor.mcp.unregisterServer(MCP_SERVER_NAME);
        } catch {
            // Already gone.
        }
        if (pluginRegistered) {
            try {
                cursor.plugins.unregisterPath(pluginDir);
            } catch {
                // Already gone.
            }
        }
        void http.close();
        output.appendLine(`[mcp] stopped ${MCP_SERVER_NAME}`);
    });
}

function registerBisqlServer(
    cursor: typeof vscode.cursor,
    url: string,
    iconUri: string
): void {
    const withIcon: vscode.cursor.mcp.RemoteServerConfig = {
        name: MCP_SERVER_NAME,
        title: MCP_SERVER_NAME,
        icon: { dark: iconUri, light: iconUri },
        server: { url }
    };
    try {
        cursor.mcp.registerServer(withIcon);
    } catch {
        cursor.mcp.registerServer({
            name: MCP_SERVER_NAME,
            server: { url }
        });
    }
}

function unregisterLegacyNames(cursor: typeof vscode.cursor): void {
    const folder = vscode.workspace.workspaceFolders?.[0]?.name ?? 'workspace';
    const safe = folder.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'workspace';
    for (const name of [`bisql-${safe}`, 'bisql-workspace']) {
        try {
            cursor.mcp.unregisterServer(name);
        } catch {
            // Never registered under the old workspace-suffixed id.
        }
    }
}

function savedToken(context: vscode.ExtensionContext): string | undefined {
    const token = context.workspaceState.get<unknown>(MCP_TOKEN_STATE);
    return typeof token === 'string' && /^[0-9a-f]{32,}$/i.test(token) ? token : undefined;
}

function savedPort(context: vscode.ExtensionContext): number | undefined {
    const port = context.workspaceState.get<unknown>(MCP_PORT_STATE);
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
        ? port
        : undefined;
}

