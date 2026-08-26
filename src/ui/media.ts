import * as vscode from 'vscode';

/**
 * A file under /media. The extension is bundled to out/extension.js,
 * so the repo root is one folder up from __dirname — not two.
 */
export function mediaFile(name: string): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'media', name);
}

export function tabIcon(lightFile: string, darkFile: string): { light: vscode.Uri; dark: vscode.Uri } {
    return {
        light: mediaFile(lightFile),
        dark: mediaFile(darkFile)
    };
}
