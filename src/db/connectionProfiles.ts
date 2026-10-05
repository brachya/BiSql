import * as crypto from 'crypto';
import {
    DbEngine,
    LoginKind,
    defaultPortForEngine,
    engineForLoginKind,
    parseEngine,
    parseLoginKind
} from './engines';

export type ConnectionProfile = {
    id: string;
    name: string;
    loginKind: LoginKind;
    engine: DbEngine;
    server: string;
    database: string;
    databases: string[];
    /** BigQuery: extra GCP projects whose schema is cached (home is always cached). */
    cachedProjects: string[];
    user: string;
    port: number;
    encrypt: boolean;
    trustServerCertificate: boolean;
};

export type FlatLogin = {
    loginKind: LoginKind;
    engine: DbEngine;
    server: string;
    database: string;
    databases: string[];
    cachedProjects: string[];
    user: string;
    port: number;
    encrypt: boolean;
    trustServerCertificate: boolean;
};

export type MigrateFromFlatInput = {
    existingProfiles: ConnectionProfile[];
    existingActiveId?: string;
    global?: FlatLogin;
    workspace?: FlatLogin;
    effective: FlatLogin;
};

export type MigrateFromFlatResult = {
    ran: boolean;
    profiles: ConnectionProfile[];
    activeId: string;
    globalId?: string;
    workspaceId?: string;
};

export function loginKindLabel(kind: LoginKind): string {
    if (kind === 'mysql') {
        return 'MySQL';
    }
    if (kind === 'postgres') {
        return 'PostgreSQL';
    }
    if (kind === 'supabase') {
        return 'Supabase';
    }
    if (kind === 'bigquery') {
        return 'BigQuery';
    }
    return 'SQL Server';
}

export function defaultConnectionName(
    login: Pick<ConnectionProfile, 'loginKind' | 'server'>
): string {
    const host = login.server.trim() || 'new';
    return `${loginKindLabel(login.loginKind)} · ${host}`;
}

export function hasLoginTarget(login: Pick<FlatLogin, 'server' | 'database'>): boolean {
    return login.server.trim().length > 0;
}

export function sameLogin(left: FlatLogin, right: FlatLogin): boolean {
    return (
        left.engine === right.engine &&
        left.loginKind === right.loginKind &&
        left.server.toLowerCase() === right.server.toLowerCase() &&
        left.port === right.port &&
        left.database.toLowerCase() === right.database.toLowerCase() &&
        left.user.toLowerCase() === right.user.toLowerCase()
    );
}

export function newConnectionId(): string {
    return crypto.randomBytes(8).toString('hex');
}

export function emptyProfile(id = newConnectionId()): ConnectionProfile {
    return profileFromFlat(
        {
            loginKind: 'mssql',
            engine: 'mssql',
            server: '',
            database: '',
            databases: [],
            cachedProjects: [],
            user: '',
            port: 1433,
            encrypt: true,
            trustServerCertificate: false
        },
        id
    );
}

export function profileFromFlat(
    flat: FlatLogin,
    id: string,
    name?: string
): ConnectionProfile {
    const loginKind = parseLoginKind(flat.loginKind, flat.engine, flat.server);
    const engine = engineForLoginKind(loginKind);
    const database = flat.database.trim();
    const databases =
        engine === 'postgres'
            ? database
                ? [database]
                : []
            : uniqueNames([database, ...normalizeNameList(flat.databases)]);
    return {
        id,
        name: (name ?? '').trim() || defaultConnectionName({ loginKind, server: flat.server }),
        loginKind,
        engine,
        server: flat.server.trim(),
        database: database || databases[0] || '',
        databases,
        cachedProjects:
            engine === 'bigquery' ? uniqueNames(normalizeNameList(flat.cachedProjects)) : [],
        user: flat.user.trim(),
        port: Number.isFinite(flat.port) && flat.port > 0 ? flat.port : defaultPortForEngine(engine),
        encrypt: Boolean(flat.encrypt),
        trustServerCertificate: Boolean(flat.trustServerCertificate)
    };
}

export function normalizeProfiles(raw: unknown): ConnectionProfile[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set<string>();
    const result: ConnectionProfile[] = [];
    for (const item of raw) {
        const profile = normalizeProfile(item);
        if (!profile || seen.has(profile.id)) {
            continue;
        }
        seen.add(profile.id);
        result.push(profile);
    }
    return result;
}

export function normalizeProfile(raw: unknown): ConnectionProfile | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const value = raw as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id) {
        return undefined;
    }
    const server = String(value.server ?? '').trim();
    const storedEngine = parseEngine(value.engine);
    const loginKind = parseLoginKind(value.loginKind, storedEngine, server);
    return profileFromFlat(
        {
            loginKind,
            engine: engineForLoginKind(loginKind),
            server,
            database: String(value.database ?? ''),
            databases: normalizeNameList(value.databases),
            cachedProjects: normalizeNameList(value.cachedProjects),
            user: String(value.user ?? ''),
            port: typeof value.port === 'number' ? value.port : defaultPortForEngine(engineForLoginKind(loginKind)),
            encrypt: value.encrypt !== false,
            trustServerCertificate: Boolean(value.trustServerCertificate)
        },
        id,
        typeof value.name === 'string' ? value.name : undefined
    );
}

export function migrateFromFlat(
    input: MigrateFromFlatInput,
    nextId: () => string = newConnectionId
): MigrateFromFlatResult {
    if (input.existingProfiles.length > 0) {
        const activeId =
            input.existingActiveId &&
            input.existingProfiles.some((profile) => profile.id === input.existingActiveId)
                ? input.existingActiveId
                : input.existingProfiles[0].id;
        return { ran: false, profiles: input.existingProfiles, activeId };
    }

    const global = input.global && hasLoginTarget(input.global) ? input.global : undefined;
    const workspace =
        input.workspace && hasLoginTarget(input.workspace) ? input.workspace : undefined;
    const effective = hasLoginTarget(input.effective) ? input.effective : undefined;

    if (!global && !workspace && !effective) {
        return { ran: false, profiles: [], activeId: '' };
    }

    const profiles: ConnectionProfile[] = [];
    let globalId: string | undefined;
    let workspaceId: string | undefined;

    if (global) {
        const profile = profileFromFlat(global, nextId());
        globalId = profile.id;
        profiles.push(profile);
    }

    if (workspace && (!global || !sameLogin(workspace, global))) {
        const profile = profileFromFlat(workspace, nextId());
        workspaceId = profile.id;
        profiles.push(profile);
    }

    if (profiles.length === 0 && effective) {
        const profile = profileFromFlat(effective, nextId());
        profiles.push(profile);
    }

    const match = effective
        ? profiles.find((profile) => sameLogin(profile, effective))
        : undefined;
    const activeId = match?.id ?? profiles[0]?.id ?? '';
    return { ran: true, profiles, activeId, globalId, workspaceId };
}

function normalizeNameList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return uniqueNames(value.map((item) => String(item ?? '')));
}

function uniqueNames(names: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
        const trimmed = name.trim();
        if (!trimmed) {
            continue;
        }
        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(trimmed);
    }
    return result;
}
