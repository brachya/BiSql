import * as vscode from 'vscode';
import { BisqlHostSettings, ExtensionConfig } from './config';

const JAVASCRIPT_LANGUAGE_IDS = new Set([
    'javascript',
    'typescript',
    'javascriptreact',
    'typescriptreact'
]);

export function defaultHostSettings(): BisqlHostSettings {
    return { python: true, javascript: true, sqlFiles: true };
}

/** Maps a project-scan file kind to a VS Code language id for host toggles. */
export function languageIdForSourceKind(kind: 'sql' | 'python' | 'javascript'): string {
    if (kind === 'sql') {
        return 'sql';
    }
    if (kind === 'python') {
        return 'python';
    }
    return 'typescript';
}

export function hostBucketForLanguage(languageId: string): keyof BisqlHostSettings | null {
    if (languageId === 'python') {
        return 'python';
    }
    if (languageId === 'sql') {
        return 'sqlFiles';
    }
    if (JAVASCRIPT_LANGUAGE_IDS.has(languageId)) {
        return 'javascript';
    }
    return null;
}

/** Editor SQL features for this document language (requires global `enabled` too). */
export function hostEnabled(config: ExtensionConfig, languageId: string): boolean {
    if (!config.enabled) {
        return false;
    }
    const bucket = hostBucketForLanguage(languageId);
    if (!bucket) {
        return false;
    }
    return config.hosts[bucket];
}

/** Why SQL features are off for a file that is already a supported host. */
export function hostBlockReason(config: ExtensionConfig, languageId: string): string | null {
    if (!config.enabled) {
        return 'BiSql is disabled.';
    }
    if (!hostEnabled(config, languageId)) {
        return 'SQL support for this file type is turned off in BiSql settings.';
    }
    return null;
}

export function projectScanGlob(config: ExtensionConfig): string | null {
    const parts: string[] = [];
    if (config.hosts.python) {
        parts.push('py');
    }
    if (config.hosts.sqlFiles) {
        parts.push('sql');
    }
    if (config.hosts.javascript) {
        parts.push('js', 'jsx', 'ts', 'tsx');
    }
    if (parts.length === 0) {
        return null;
    }
    return `**/*.{${parts.join(',')}}`;
}

export function updateHostContextKeys(config: ExtensionConfig): void {
    const hosts = config.hosts;
    void vscode.commands.executeCommand('setContext', 'bisql.pythonOn', config.enabled && hosts.python);
    void vscode.commands.executeCommand(
        'setContext',
        'bisql.javascriptOn',
        config.enabled && hosts.javascript
    );
    void vscode.commands.executeCommand(
        'setContext',
        'bisql.sqlFilesOn',
        config.enabled && hosts.sqlFiles
    );
}
