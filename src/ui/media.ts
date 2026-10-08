import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * A file under /media. The extension is bundled to out/extension.js,
 * so the repo root is one folder up from __dirname — not two.
 */
export function mediaRoot(): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'media');
}

export function mediaFile(name: string): vscode.Uri {
    return vscode.Uri.joinPath(mediaRoot(), name);
}

export function tabIcon(lightFile: string, darkFile: string): { light: vscode.Uri; dark: vscode.Uri } {
    return {
        light: mediaFile(lightFile),
        dark: mediaFile(darkFile)
    };
}

export function embedJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i++) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}

const shellCache = new Map<string, string>();

/** Load media/<name>.html and fill CSP, nonce, asset URLs, and bootstrap JSON. */
export function fillWebviewPage(
    name: 'results' | 'connection' | 'schema' | 'dbFilter',
    webview: vscode.Webview,
    boot: unknown
): string {
    const nonce = getNonce();
    let shell = shellCache.get(name);
    if (!shell) {
        shell = fs.readFileSync(mediaFile(`${name}.html`).fsPath, 'utf8');
        shellCache.set(name, shell);
    }
    const vars: Record<string, string> = {
        csp: webview.cspSource,
        nonce,
        css: webview.asWebviewUri(mediaFile(`${name}.css`)).toString(),
        cssTheme: webview.asWebviewUri(mediaFile('theme.css')).toString(),
        cssConnection: webview.asWebviewUri(mediaFile('connection.css')).toString(),
        js: webview.asWebviewUri(mediaFile(`${name}.js`)).toString(),
        jsCommon: webview.asWebviewUri(mediaFile('webview-common.js')).toString(),
        jsDate: webview.asWebviewUri(mediaFile('date-cells.js')).toString(),
        boot: embedJson(boot)
    };
    return shell.replace(
        /\{\{(csp|nonce|css|cssTheme|cssConnection|js|jsCommon|jsDate|boot)\}\}/g,
        (_, key: string) => vars[key] ?? ''
    );
}
