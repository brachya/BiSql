export interface LogPort {
    appendLine(line: string): void;
}

export interface SecretPort {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface StatePort {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Promise<void>;
}

export type SettingsTarget = 'global' | 'workspace';

export type ConfigInspect<T> = {
    key: string;
    defaultValue?: T;
    globalValue?: T;
    workspaceValue?: T;
    workspaceFolderValue?: T;
};

export interface SettingsPort {
    inspect<T>(section: string, key: string): ConfigInspect<T> | undefined;
    get<T>(section: string, key: string): T | undefined;
    update(section: string, key: string, value: unknown, target: SettingsTarget): Promise<void>;
    hasWorkspaceFolder(): boolean;
    /** Used for workspace-scoped secret key hashing. */
    workspaceFolderUri(): string;
}

export interface FilePort {
    ensureStorageDir(): Promise<void>;
    read(name: string): Promise<Uint8Array>;
    write(name: string, bytes: Uint8Array): Promise<void>;
    delete(name: string): Promise<void>;
}

export interface ServicePorts {
    log: LogPort;
    secrets: SecretPort;
    state: StatePort;
    settings: SettingsPort;
    files: FilePort;
}
