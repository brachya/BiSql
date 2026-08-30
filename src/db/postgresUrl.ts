export type PostgresSslMode = 'disable' | 'require' | 'verify-full';

export type ParsedPostgresUrl = {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    sslMode: PostgresSslMode;
};

export type ParsePostgresUrlFailure = {
    ok: false;
    kind: 'empty' | 'mysql' | 'not-postgres' | 'invalid';
    error: string;
};

export type ParsePostgresUrlResult =
    | { ok: true; value: ParsedPostgresUrl }
    | ParsePostgresUrlFailure;

const DEFAULT_PORT = 5432;

export function isSupabaseHost(host: string): boolean {
    return host.toLowerCase().includes('supabase.');
}

/** Direct `db.<ref>.supabase.co` host — often IPv6-only and times out. */
export function isDirectSupabaseHost(host: string): boolean {
    const lower = host.toLowerCase();
    return lower.startsWith('db.') && lower.includes('supabase.');
}

export function parsePostgresUrl(raw: string): ParsePostgresUrlResult {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {
            ok: false,
            kind: 'empty',
            error: 'Paste a postgres:// or postgresql:// URL.'
        };
    }

    const lower = trimmed.toLowerCase();
    if (lower.startsWith('mysql://') || lower.startsWith('mysql+')) {
        return {
            ok: false,
            kind: 'mysql',
            error: 'This is a MySQL URL. Choose MySQL.'
        };
    }

    let rest: string | undefined;
    if (lower.startsWith('postgresql://')) {
        rest = trimmed.slice('postgresql://'.length);
    } else if (lower.startsWith('postgres://')) {
        rest = trimmed.slice('postgres://'.length);
    }
    if (rest === undefined) {
        return {
            ok: false,
            kind: 'not-postgres',
            error: 'Use a postgres:// or postgresql:// URL from the Supabase dashboard.'
        };
    }

    let parsed: URL;
    try {
        parsed = new URL(`http://${rest}`);
    } catch {
        return {
            ok: false,
            kind: 'invalid',
            error: 'That URL could not be read. Check it and paste again.'
        };
    }

    const host = decodeURIComponent(parsed.hostname).trim();
    if (!host) {
        return { ok: false, kind: 'invalid', error: 'The URL has no host.' };
    }

    const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT;
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return { ok: false, kind: 'invalid', error: 'The URL has a bad port.' };
    }

    return {
        ok: true,
        value: {
            host,
            port,
            user: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
            database: decodeURIComponent(parsed.pathname.replace(/^\//, '')).split('/')[0] ?? '',
            sslMode: sslModeFromParam(parsed.searchParams.get('sslmode'))
        }
    };
}

function sslModeFromParam(raw: string | null): PostgresSslMode {
    const value = (raw ?? '').toLowerCase();
    if (value === 'disable') {
        return 'disable';
    }
    if (value === 'verify-ca' || value === 'verify-full') {
        return 'verify-full';
    }
    return 'require';
}
