export type DbEngine = 'mssql' | 'mysql' | 'postgres' | 'bigquery';

/** Login page kind. Supabase is a UI on top of PostgreSQL, not a fourth engine. */
export type LoginKind = 'mssql' | 'mysql' | 'postgres' | 'supabase' | 'bigquery';

export function parseEngine(value: unknown): DbEngine {
    if (value === 'mysql' || value === 'postgres' || value === 'bigquery') {
        return value;
    }
    return 'mssql';
}

export function parseLoginKind(value: unknown, engine: DbEngine, server = ''): LoginKind {
    if (
        value === 'mssql' ||
        value === 'mysql' ||
        value === 'postgres' ||
        value === 'supabase' ||
        value === 'bigquery'
    ) {
        return value;
    }
    if (engine === 'postgres' && server.toLowerCase().includes('supabase.')) {
        return 'supabase';
    }
    return engine;
}

export function engineForLoginKind(kind: LoginKind): DbEngine {
    return kind === 'supabase' ? 'postgres' : kind;
}

export function defaultPortForEngine(engine: DbEngine): number {
    if (engine === 'mysql') {
        return 3306;
    }
    if (engine === 'postgres') {
        return 5432;
    }
    if (engine === 'bigquery') {
        return 0;
    }
    return 1433;
}

export function defaultSchemaForEngine(engine: DbEngine): string | undefined {
    if (engine === 'mysql' || engine === 'bigquery') {
        return undefined;
    }
    return engine === 'postgres' ? 'public' : 'dbo';
}
