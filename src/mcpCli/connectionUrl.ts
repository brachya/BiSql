import {
    ConnectionProfile,
    profileFromFlat,
    type FlatLogin
} from '../db/connectionProfiles';
import { defaultPortForEngine, engineForLoginKind } from '../db/engines';
import { normalizeDatabaseList } from '../db/config';
import { isSupabaseHost, parsePostgresUrl } from '../db/postgresUrl';

export const CLI_CONNECTION_ID = 'bisql-mcp-cli';

export type ParsedBisqlConnection = {
    profile: ConnectionProfile;
    password: string;
};

export type ParseBisqlUrlResult =
    | { ok: true; value: ParsedBisqlConnection }
    | { ok: false; error: string };

export function parseBisqlUrl(raw: string): ParseBisqlUrlResult {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { ok: false, error: 'BISQL_URL is empty.' };
    }

    const lower = trimmed.toLowerCase();
    if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) {
        return parsePostgresConnection(trimmed);
    }
    if (lower.startsWith('mysql://')) {
        return parseCredentialUrl(trimmed, 'mysql://'.length, 'mysql', 'mysql');
    }
    if (lower.startsWith('mssql://')) {
        return parseCredentialUrl(trimmed, 'mssql://'.length, 'mssql', 'mssql');
    }
    if (lower.startsWith('sqlserver://')) {
        return parseCredentialUrl(trimmed, 'sqlserver://'.length, 'mssql', 'mssql');
    }
    if (lower.startsWith('bigquery://')) {
        return parseBigqueryConnection(trimmed.slice('bigquery://'.length));
    }

    return {
        ok: false,
        error: 'Use postgres://, mysql://, mssql://, or bigquery:// in BISQL_URL.'
    };
}

function parsePostgresConnection(trimmed: string): ParseBisqlUrlResult {
    const parsed = parsePostgresUrl(trimmed);
    if (!parsed.ok) {
        return { ok: false, error: parsed.error };
    }
    const { host, port, user, password, database, sslMode, trustServerCertificate } = parsed.value;
    if (!database) {
        return { ok: false, error: 'Postgres URL needs a database name in the path.' };
    }
    const loginKind = isSupabaseHost(host) ? 'supabase' : 'postgres';
    const engine = engineForLoginKind(loginKind);
    const flat: FlatLogin = {
        loginKind,
        engine,
        server: host,
        database,
        databases: [database],
        cachedProjects: [],
        user,
        port,
        encrypt: sslMode !== 'disable',
        trustServerCertificate
    };
    return {
        ok: true,
        value: {
            profile: profileFromFlat(flat, CLI_CONNECTION_ID, 'bisql-mcp'),
            password
        }
    };
}

function parseCredentialUrl(
    trimmed: string,
    prefixLen: number,
    loginKind: FlatLogin['loginKind'],
    engine: FlatLogin['engine']
): ParseBisqlUrlResult {
    const rest = trimmed.slice(prefixLen);
    if (engine === 'mssql' && rest.includes('\\')) {
        return parseMssqlInstanceUrl(rest, loginKind);
    }

    let parsed: URL;
    try {
        parsed = new URL(`http://${rest}`);
    } catch {
        return { ok: false, error: 'That URL could not be read. Check BISQL_URL.' };
    }

    return credentialFlatFromParsedUrl(parsed, loginKind, engine);
}

function parseMssqlInstanceUrl(
    rest: string,
    loginKind: FlatLogin['loginKind']
): ParseBisqlUrlResult {
    const slash = rest.indexOf('/');
    if (slash < 0) {
        return { ok: false, error: 'The URL needs a database name in the path.' };
    }
    const authority = rest.slice(0, slash);
    const pathAndQuery = rest.slice(slash);
    const at = authority.lastIndexOf('@');
    if (at < 0) {
        return { ok: false, error: 'The URL has no host.' };
    }
    const userinfo = authority.slice(0, at);
    const hostPort = authority.slice(at + 1).trim();
    if (!hostPort) {
        return { ok: false, error: 'The URL has no host.' };
    }

    const colon = userinfo.indexOf(':');
    const user = decodeURIComponent(colon >= 0 ? userinfo.slice(0, colon) : userinfo);
    const password = decodeURIComponent(colon >= 0 ? userinfo.slice(colon + 1) : '');

    const backslash = hostPort.indexOf('\\');
    const portColon = hostPort.lastIndexOf(':');
    let server = hostPort;
    let port = defaultPortForEngine('mssql');
    if (portColon > backslash && portColon >= 0) {
        const portText = hostPort.slice(portColon + 1);
        const portNum = Number(portText);
        if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
            return { ok: false, error: 'The URL has a bad port.' };
        }
        server = hostPort.slice(0, portColon);
        port = portNum;
    }

    const qIndex = pathAndQuery.indexOf('?');
    const pathOnly = qIndex >= 0 ? pathAndQuery.slice(0, qIndex) : pathAndQuery;
    const database = decodeURIComponent(pathOnly.replace(/^\//, '')).split('/')[0] ?? '';
    if (!database) {
        return { ok: false, error: 'The URL needs a database name in the path.' };
    }
    const params =
        qIndex >= 0 ? new URLSearchParams(pathAndQuery.slice(qIndex + 1)) : new URLSearchParams();
    const databases = databasesFromQuery(params);

    const flat: FlatLogin = {
        loginKind,
        engine: 'mssql',
        server,
        database,
        databases: databases.length > 0 ? databases : [database],
        cachedProjects: [],
        user,
        port,
        encrypt: boolParam(params.get('encrypt'), true),
        trustServerCertificate: boolParam(params.get('trustServerCertificate'), false)
    };

    return {
        ok: true,
        value: {
            profile: profileFromFlat(flat, CLI_CONNECTION_ID, 'bisql-mcp'),
            password
        }
    };
}

function credentialFlatFromParsedUrl(
    parsed: URL,
    loginKind: FlatLogin['loginKind'],
    engine: FlatLogin['engine']
): ParseBisqlUrlResult {
    const host = decodeURIComponent(parsed.hostname).trim();
    if (!host) {
        return { ok: false, error: 'The URL has no host.' };
    }

    const defaultPort = defaultPortForEngine(engine);
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return { ok: false, error: 'The URL has a bad port.' };
    }

    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')).split('/')[0] ?? '';
    if (!database) {
        return { ok: false, error: 'The URL needs a database name in the path.' };
    }

    const databases = databasesFromQuery(parsed.searchParams);
    const flat: FlatLogin = {
        loginKind,
        engine,
        server: host,
        database,
        databases: databases.length > 0 ? databases : [database],
        cachedProjects: [],
        user: decodeURIComponent(parsed.username),
        port,
        encrypt: boolParam(parsed.searchParams.get('encrypt'), true),
        trustServerCertificate: boolParam(parsed.searchParams.get('trustServerCertificate'), false)
    };

    return {
        ok: true,
        value: {
            profile: profileFromFlat(flat, CLI_CONNECTION_ID, 'bisql-mcp'),
            password: decodeURIComponent(parsed.password)
        }
    };
}

function parseBigqueryConnection(rest: string): ParseBisqlUrlResult {
    const slash = rest.indexOf('/');
    if (slash <= 0) {
        return {
            ok: false,
            error: 'BigQuery URL must look like bigquery://project-id/dataset-id'
        };
    }
    const project = decodeURIComponent(rest.slice(0, slash)).trim();
    const tail = rest.slice(slash + 1);
    const dataset = decodeURIComponent(tail.split('?')[0] ?? '').trim();
    if (!project || !dataset) {
        return { ok: false, error: 'BigQuery URL needs a project id and dataset id.' };
    }

    let cachedProjects: string[] = [];
    const qIndex = tail.indexOf('?');
    if (qIndex >= 0) {
        const params = new URLSearchParams(tail.slice(qIndex + 1));
        const projects = params.get('projects')?.split(',').map((part) => part.trim()) ?? [];
        cachedProjects = normalizeDatabaseList(projects);
    }

    const flat: FlatLogin = {
        loginKind: 'bigquery',
        engine: 'bigquery',
        server: project,
        database: dataset,
        databases: [dataset],
        cachedProjects,
        user: '',
        port: defaultPortForEngine('bigquery'),
        encrypt: true,
        trustServerCertificate: false
    };

    return {
        ok: true,
        value: {
            profile: profileFromFlat(flat, CLI_CONNECTION_ID, 'bisql-mcp'),
            password: ''
        }
    };
}

function databasesFromQuery(params: URLSearchParams): string[] {
    const raw = params.get('databases');
    if (!raw) {
        return [];
    }
    return normalizeDatabaseList(raw.split(','));
}

function boolParam(raw: string | null, defaultValue: boolean): boolean {
    if (raw === null || raw === '') {
        return defaultValue;
    }
    const value = raw.toLowerCase();
    if (value === 'true' || value === '1' || value === 'yes') {
        return true;
    }
    if (value === 'false' || value === '0' || value === 'no') {
        return false;
    }
    return defaultValue;
}
