import * as vscode from 'vscode';
import {
    ConfigInspect,
    FilePort,
    LogPort,
    SecretPort,
    ServicePorts,
    SettingsPort,
    SettingsTarget,
    StatePort
} from './ports';

function mapInspect<T>(
    inspected: ReturnType<vscode.WorkspaceConfiguration['inspect']> | undefined
): ConfigInspect<T> | undefined {
    if (!inspected) {
        return undefined;
    }
    const row = inspected as ConfigInspect<T> & { key: string };
    return {
        key: row.key,
        defaultValue: row.defaultValue,
        globalValue: row.globalValue,
        workspaceValue: row.workspaceValue,
        workspaceFolderValue: row.workspaceFolderValue
    };
}

function settingsTargetToVscode(target: SettingsTarget): vscode.ConfigurationTarget {
    return target === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}

export function vscodePorts(context: vscode.ExtensionContext, output: vscode.OutputChannel): ServicePorts {
    const log: LogPort = output;

    const secrets: SecretPort = {
        get: (key) => Promise.resolve(context.secrets.get(key)),
        store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
        delete: (key) => Promise.resolve(context.secrets.delete(key))
    };

    const state: StatePort = {
        get: (key) => context.workspaceState.get(key),
        update: (key, value) => Promise.resolve(context.workspaceState.update(key, value))
    };

    const settings: SettingsPort = {
        inspect<T>(section: string, key: string): ConfigInspect<T> | undefined {
            return mapInspect(vscode.workspace.getConfiguration(section).inspect<T>(key));
        },
        get<T>(section: string, key: string): T | undefined {
            return vscode.workspace.getConfiguration(section).get<T>(key);
        },
        update(section: string, key: string, value: unknown, target: SettingsTarget): Promise<void> {
            return Promise.resolve(
                vscode.workspace
                    .getConfiguration(section)
                    .update(key, value, settingsTargetToVscode(target))
            );
        },
        hasWorkspaceFolder(): boolean {
            return Boolean(vscode.workspace.workspaceFolders?.length);
        },
        workspaceFolderUri(): string {
            return vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'default';
        }
    };

    const storageRoot = context.globalStorageUri;

    const files: FilePort = {
        async ensureStorageDir(): Promise<void> {
            await vscode.workspace.fs.createDirectory(storageRoot);
        },
        async read(name: string): Promise<Uint8Array> {
            return vscode.workspace.fs.readFile(vscode.Uri.joinPath(storageRoot, name));
        },
        async write(name: string, bytes: Uint8Array): Promise<void> {
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(storageRoot, name), bytes);
        },
        async delete(name: string): Promise<void> {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(storageRoot, name));
        }
    };

    return { log, secrets, state, settings, files };
}
