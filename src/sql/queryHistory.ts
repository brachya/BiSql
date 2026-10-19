export const QUERY_HISTORY_STATE = 'bisql.queryHistory';

/** ponytail: workspace state is not a file store. Longer SQL is not saved. */
const MAX_SQL_CHARS = 20_000;

export interface QueryHistoryEntry {
    sql: string;
    at: number;
    connectionId: string;
}

export function normalizeQueryHistory(value: unknown): QueryHistoryEntry[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const result: QueryHistoryEntry[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const row = item as Record<string, unknown>;
        if (typeof row.sql !== 'string') {
            continue;
        }
        const sql = row.sql.trim();
        if (sql.length === 0 || sql.length > MAX_SQL_CHARS) {
            continue;
        }
        const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0;
        const connectionId = typeof row.connectionId === 'string' ? row.connectionId : '';
        result.push({ sql, at, connectionId });
    }
    return result;
}

/**
 * Newest first. The same SQL (ignoring surrounding space) moves to the front.
 * `limit` of 0 leaves the list unchanged.
 */
export function rememberQuery(
    entries: QueryHistoryEntry[],
    entry: QueryHistoryEntry,
    limit: number
): QueryHistoryEntry[] {
    if (!Number.isFinite(limit) || limit <= 0) {
        return entries;
    }
    const sql = entry.sql.trim();
    if (sql.length === 0 || sql.length > MAX_SQL_CHARS) {
        return entries;
    }
    const cap = Math.min(500, Math.floor(limit));
    const rest = entries.filter((item) => item.sql !== sql);
    return [{ sql, at: entry.at, connectionId: entry.connectionId }, ...rest].slice(0, cap);
}

export function historyPickLabel(sql: string): string {
    const oneLine = sql.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= 80) {
        return oneLine;
    }
    return `${oneLine.slice(0, 77)}…`;
}
