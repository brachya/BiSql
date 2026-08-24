import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { startMcpHttpServer } from './httpServer';

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

    const token = randomBytes(32).toString('hex');
    const version = String(context.extension.packageJSON.version ?? '0.0.0');
    const http = await startMcpHttpServer(db, output, version, token);
    const serverName = mcpServerName();
    const url = `http://127.0.0.1:${http.port}/mcp?token=${token}`;

    try {
        cursor.mcp.registerServer({
            name: serverName,
            server: { url }
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[mcp] registerServer failed: ${message}`);
        await http.close();
        return undefined;
    }

    output.appendLine(`[mcp] listening on 127.0.0.1:${http.port} as ${serverName}`);

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
            cursor.mcp.unregisterServer(serverName);
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
        output.appendLine(`[mcp] stopped ${serverName}`);
    });
}

function mcpServerName(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.name ?? 'workspace';
    const safe = folder.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'workspace';
    // Stable across reloads so Cursor can keep the tools enabled.
    // Different workspaces still get different names.
    return `bisql-${safe}`;
}
