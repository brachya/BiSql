import { DbEngine, LoginKind, engineForLoginKind, parseLoginKind } from '../db/connection';
import { isSupabaseHost, parsePostgresUrl } from '../db/postgresUrl';

export type FormPayload = {
    connectionId: string;
    name: string;
    pinToWorkspace: boolean;
    loginKind: LoginKind;
    connectionUrl: string;
    server: string;
    database: string;
    databases: string[];
    cachedProjects: string[];
    user: string;
    password: string;
    port: number;
    encrypt: boolean;
    trustServerCertificate: boolean;
    enabled: boolean;
    clearPassword: boolean;
};


export function resolveFormConnection(
    message: Omit<FormPayload, 'enabled' | 'clearPassword'> & { enabled?: boolean },
    options?: { requireDatabase?: boolean }
):
    | {
          ok: true;
          settings: {
              engine: DbEngine;
              loginKind: LoginKind;
              server: string;
              database: string;
              databases: string[];
              cachedProjects: string[];
              user: string;
              port: number;
              encrypt: boolean;
              trustServerCertificate: boolean;
          };
          password: string;
      }
    | { ok: false; message: string } {
    const loginKind = parseLoginKind(message.loginKind, engineForLoginKind(message.loginKind), message.server);
    const requireDatabase = options?.requireDatabase !== false;

    if (loginKind === 'supabase') {
        const url = message.connectionUrl.trim();
        if (url) {
            const parsed = parsePostgresUrl(url);
            if (!parsed.ok) {
                return { ok: false, message: parsed.error };
            }
            if (!isSupabaseHost(parsed.value.host)) {
                return {
                    ok: false,
                    message: 'That host is not Supabase. Choose PostgreSQL and fill the fields.'
                };
            }
            const password = parsed.value.password || message.password;
            if (!password) {
                return {
                    ok: false,
                    message: 'Add the database password. It was not in the URL.'
                };
            }
            const database = parsed.value.database.trim() || 'postgres';
            return {
                ok: true,
                settings: {
                    engine: 'postgres',
                    loginKind: 'supabase',
                    server: parsed.value.host,
                    database,
                    databases: [database],
                    cachedProjects: [],
                    user: parsed.value.user,
                    port: parsed.value.port,
                    encrypt: parsed.value.sslMode !== 'disable',
                    // The login page already applied the sslmode rule to this control.
                    // A later change there must win over parsing the URL again.
                    trustServerCertificate: message.trustServerCertificate
                },
                password
            };
        }
        if (!message.server.trim() || !isSupabaseHost(message.server)) {
            return { ok: false, message: 'Paste a Supabase connection URL.' };
        }
        if (requireDatabase && !message.database.trim()) {
            return { ok: false, message: 'Paste a Supabase connection URL.' };
        }
        return {
            ok: true,
            settings: {
                engine: 'postgres',
                loginKind: 'supabase',
                server: message.server.trim(),
                database: message.database.trim() || 'postgres',
                databases: [message.database.trim() || 'postgres'],
                cachedProjects: [],
                user: message.user.trim(),
                port: message.port || 5432,
                encrypt: true,
                trustServerCertificate: message.trustServerCertificate !== false
            },
            password: message.password
        };
    }

    if (loginKind === 'bigquery') {
        if (!message.server.trim()) {
            return { ok: false, message: 'Project is required.' };
        }
        if (requireDatabase && !message.database.trim()) {
            return { ok: false, message: 'Dataset is required.' };
        }
        const datasets = normalizeFormDatabases(message.database, message.databases);
        const cachedProjects = normalizeFormDatabases('', message.cachedProjects);
        return {
            ok: true,
            settings: {
                engine: 'bigquery',
                loginKind: 'bigquery',
                server: message.server.trim(),
                database: message.database.trim() || datasets[0] || '',
                databases: datasets,
                cachedProjects,
                user: '',
                port: 0,
                encrypt: true,
                trustServerCertificate: false
            },
            password: ''
        };
    }

    const engine = engineForLoginKind(loginKind);
    if (!message.server.trim()) {
        return { ok: false, message: 'Server is required.' };
    }
    if (requireDatabase && !message.database.trim()) {
        return { ok: false, message: 'Database is required.' };
    }
    const databases = normalizeFormDatabases(message.database, message.databases);
    return {
        ok: true,
        settings: {
            engine,
            loginKind,
            server: message.server.trim(),
            database: message.database.trim() || databases[0] || '',
            databases,
            cachedProjects: [],
            user: message.user.trim(),
            port: message.port,
            encrypt: message.encrypt,
            trustServerCertificate: message.trustServerCertificate
        },
        password: message.password
    };
}

function normalizeFormDatabases(defaultDatabase: string, databases: string[] | undefined): string[] {
    const names = [defaultDatabase, ...(databases ?? [])]
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(name);
    }
    return result;
}

export function hintFromMessage(message: string, loginKind: LoginKind): string | undefined {
    const lower = message.toLowerCase();
    if (lower.includes('unable to process incoming packet') || lower.includes('connection lost')) {
        if (loginKind === 'mssql') {
            return (
                'If this is MySQL, choose MySQL. ' +
                'If this is PostgreSQL or Supabase, pick that card instead. ' +
                'For SQL Server: enable Trust server certificate, or turn Encrypt off.'
            );
        }
        if (loginKind === 'supabase') {
            return 'Supabase handshake failed. Paste the Session pooler URL and keep TLS on.';
        }
        if (loginKind === 'postgres') {
            return 'Check PostgreSQL host, port, credentials, database name, and TLS settings.';
        }
        if (loginKind === 'bigquery') {
            return 'Check the project id and run: gcloud auth application-default login';
        }
        return 'Check MySQL host, port, credentials, and TLS settings.';
    }
    if (
        lower.includes('default credentials') ||
        lower.includes('could not refresh access token') ||
        lower.includes('unable to authenticate')
    ) {
        return 'Run: gcloud auth application-default login';
    }
    if (lower.includes('login failed') || lower.includes('access denied') || lower.includes('password authentication failed')) {
        return 'Check username/password, and that the login can open this database.';
    }
    if (lower.includes('certificate') || lower.includes('self signed')) {
        return loginKind === 'mssql'
            ? 'Enable "Trust server certificate" for local or self-signed TLS.'
            : 'Enable "Allow self-signed certificate".';
    }
    if (lower.includes('etimeout') || lower.includes('timeout')) {
        return loginKind === 'supabase'
            ? 'Timed out. If you used the direct db.… host, paste the Session pooler URL instead.'
            : 'Check VPN/firewall, port, and that the database server is running.';
    }
    return undefined;
}

