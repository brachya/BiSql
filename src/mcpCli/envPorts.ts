import { ConnectionProfile } from '../db/connectionProfiles';
import { CONFIG_SECTION, LEGACY_CONFIG_SECTION } from '../db/config';
import {
    FilePort,
    LogPort,
    SecretPort,
    ServicePorts,
    SettingsPort,
    SettingsTarget,
    StatePort
} from '../db/ports';

export type EnvPortOptions = {
    profile: ConnectionProfile;
    password: string;
    allowMutating: boolean;
    maxResultRows: number;
    bigqueryConfirmScanMb: number;
};

export function buildEnvPorts(options: EnvPortOptions): {
    ports: ServicePorts;
    primeSecrets: () => Promise<void>;
} {
    const secretStore = new Map<string, string>();
    const stateStore = new Map<string, unknown>();

    const globals: Record<string, unknown> = {
        connections: [options.profile],
        activeConnectionId: options.profile.id,
        enabled: true,
        password: '',
        connectionTimeout: 15_000,
        schemaRefreshMinutes: 30,
        validateOnType: true,
        dryRunOnSave: true,
        promptQuickSuggestions: true,
        cacheSchemaToDisk: false,
        queryMaxRows: 1000,
        formatKeywordCase: 'upper',
        formatTabWidth: 4,
        mcpEnabled: true,
        mcpAllowMutating: options.allowMutating,
        mcpMaxResultRows: options.maxResultRows,
        bigqueryConfirmScanMb: options.bigqueryConfirmScanMb
    };

    const log: LogPort = {
        appendLine(line: string): void {
            process.stderr.write(`${line}\n`);
        }
    };

    const secrets: SecretPort = {
        get: (key) => Promise.resolve(secretStore.get(key)),
        store: (key, value) => {
            secretStore.set(key, value);
            return Promise.resolve();
        },
        delete: (key) => {
            secretStore.delete(key);
            return Promise.resolve();
        }
    };

    const state: StatePort = {
        get: (key) => stateStore.get(key) as never,
        update: (key, value) => {
            stateStore.set(key, value);
            return Promise.resolve();
        }
    };

    const settings: SettingsPort = {
        inspect<T>(section: string, key: string) {
            if (section !== CONFIG_SECTION && section !== LEGACY_CONFIG_SECTION) {
                return undefined;
            }
            if (section === LEGACY_CONFIG_SECTION) {
                return undefined;
            }
            const globalValue = globals[key] as T | undefined;
            return { key, globalValue };
        },
        get<T>(section: string, key: string): T | undefined {
            if (section !== CONFIG_SECTION) {
                return undefined;
            }
            return globals[key] as T | undefined;
        },
        update(_section: string, _key: string, _value: unknown, _target: SettingsTarget): Promise<void> {
            return Promise.resolve();
        },
        hasWorkspaceFolder(): boolean {
            return false;
        },
        workspaceFolderUri(): string {
            return 'default';
        }
    };

    const files: FilePort = {
        ensureStorageDir: () => Promise.resolve(),
        read: () => Promise.reject(new Error('ENOENT')),
        write: () => Promise.resolve(),
        delete: () => Promise.resolve()
    };

    const primeSecrets = async (): Promise<void> => {
        if (options.password) {
            await secrets.store(`bisql.connection.${options.profile.id}.password`, options.password);
        }
    };

    return {
        ports: { log, secrets, state, settings, files },
        primeSecrets
    };
}
