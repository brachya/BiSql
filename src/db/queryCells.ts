import { lookupParam, rewriteNamedBinds } from '../sql/parameters';
import { ResultSort } from '../sql/resultPage';
import { formatSqlDate } from '../sql/sqlDates';
import { ExtensionConfig } from './config';
import { DbEngine } from './engines';

export type ConnectionState =
    | 'disabled'
    | 'unconfigured'
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'error';

export interface DryRunError {
    number: number | undefined;
    message: string;
    lineNumber: number | undefined;
}

export type DryRunResult =
    | { kind: 'ok'; scanBytes?: number }
    | { kind: 'errors'; errors: DryRunError[] }
    | { kind: 'skipped'; reason: string }
    | { kind: 'unavailable'; reason: string };

export interface QueryResult {
    ok: boolean;
    /** SQL the user selected (before paging wrap or engine rewrite). */
    sql: string;
    /** SQL sent to the driver (`:name` rewritten, paging wrap applied). */
    executedSql: string;
    params: Record<string, string | null>;
    columns: string[];
    rows: string[][];
    /**
     * JSON-safe cells when `page.raw` was true. `null` is SQL NULL, not the
     * string `"NULL"`. Numbers stay numbers.
     */
    rawRows?: unknown[][];
    rowsAffected: number | undefined;
    elapsedMs: number;
    /** True when another page exists after this one. */
    truncated: boolean;
    /** Rows requested for this page (not including the extra lookahead row). */
    maxRows: number;
    /** Byte offset into the full result (0 for the first page). */
    pageOffset: number;
    /** True when this SELECT was wrapped with LIMIT/OFFSET. */
    paged: boolean;
    sort?: ResultSort;
    error?: string;
    /** 1-based line in the SQL batch, not in the file. */
    errorLine?: number;
    /** Plan / EXPLAIN tabs. Refresh re-explains; cells cannot be edited. */
    readOnly?: boolean;
    /** BigQuery bytes scanned (run) or estimated (explain). Other engines omit this. */
    scanBytes?: number;
}

export interface ExplainResult {
    ok: boolean;
    sql: string;
    executedSql: string;
    engine: DbEngine;
    columns: string[];
    rows: unknown[][];
    elapsedMs: number;
    error?: string;
    /** 1-based line in the SQL batch, not in the file. */
    errorLine?: number;
    /** Extra note (for example MySQL fell back from FORMAT=JSON). */
    note?: string;
    /** BigQuery dry-run estimate. */
    scanBytes?: number;
}

/** MySQL ER_VIEW_NO_EXPLAIN — SELECT on a view is allowed, EXPLAIN is not. */
const MYSQL_ER_VIEW_NO_EXPLAIN = 1345;

/**
 * True when EXPLAIN failed only because the login lacks base-table / SHOW VIEW
 * rights for a view. That is a dry-run limitation, not a bad query.
 */
export function isMysqlViewExplainPrivilegeError(
    errno: number | undefined,
    message: string
): boolean {
    if (errno === MYSQL_ER_VIEW_NO_EXPLAIN) {
        return true;
    }
    return /EXPLAIN\/SHOW can not be issued/i.test(message)
        || /lacking privileges for underlying table/i.test(message);
}

/**
 * Socket / pool failures, not bad SQL. Do not paint these on the query.
 * MySQL: 2006 gone away, 2013 lost during query, 4031 idle timeout, 1927 aborted.
 */
export function isTransientConnectionError(
    message: string,
    errno?: number
): boolean {
    const lower = message.toLowerCase();
    if (
        lower.includes('etimedout') ||
        lower.includes('econnreset') ||
        lower.includes('econnrefused') ||
        lower.includes('ehostunreach') ||
        lower.includes('epipe') ||
        lower.includes('enotfound') ||
        lower.includes('protocol_connection_lost') ||
        lower.includes('protocol_sequence_timeout') ||
        lower.includes('connection lost') ||
        lower.includes('server closed the connection') ||
        lower.includes('cannot enqueue') ||
        lower.includes('pool is closed') ||
        lower.includes('socket hang up')
    ) {
        return true;
    }
    return errno === 2006 || errno === 2013 || errno === 4031 || errno === 1927;
}

export function jsonQueryCell(value: unknown): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (value instanceof Date) {
        return formatSqlDate(value);
    }
    if (Buffer.isBuffer(value)) {
        return value.length === 0 ? '[binary]' : `[binary ${value.length} bytes]`;
    }
    if (typeof value === 'object') {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return String(value);
        }
    }
    return String(value);
}

/** Past this length the results grid shows only the start. Copy and Open still use the stored text. */
export const LONG_CELL_CHARS = 4000;

/**
 * Hard stop for one cell kept in memory.
 * ponytail: a single value can be hundreds of MB. Keep the start so the editor stays up.
 * Upgrade path: store a short preview and load the full cell when the user opens it.
 */
export const MAX_STORED_CELL_CHARS = 1_000_000;

/** Text sent to the results grid. The host keeps the full string for copy and open. */
export function gridCellPreview(value: string): string {
    if (value.length <= LONG_CELL_CHARS) {
        return value;
    }
    return `${value.slice(0, LONG_CELL_CHARS)}…`;
}

/**
 * Warning when a result cell is long. Undefined when every cell is short.
 * The grid shows the start. Copy and Open use the stored text.
 * A cell at the storage cap was cut. The rest was not loaded.
 */
export function longCellWarning(lengths: readonly number[]): string | undefined {
    let count = 0;
    let longest = 0;
    let cut = 0;
    for (const length of lengths) {
        if (length >= MAX_STORED_CELL_CHARS) {
            cut += 1;
        }
        if (length > LONG_CELL_CHARS) {
            count += 1;
            if (length > longest) {
                longest = length;
            }
        }
    }
    if (cut > 0) {
        const cells = cut === 1 ? 'One cell was' : `${cut} cells were`;
        return (
            `${cells} cut at ${MAX_STORED_CELL_CHARS} characters so the editor stays responsive. ` +
            'The rest was not loaded.'
        );
    }
    if (count === 0) {
        return undefined;
    }
    const cells = count === 1 ? 'One cell is' : `${count} cells are`;
    return (
        `${cells} longer than ${LONG_CELL_CHARS} characters. ` +
        `The longest has ${longest} characters. ` +
        'The row shows the start. Copy or open the cell to get the full value.'
    );
}

export function formatQueryCell(value: unknown): string {
    const text = formatQueryCellRaw(value);
    if (text.length <= MAX_STORED_CELL_CHARS) {
        return text;
    }
    return text.slice(0, MAX_STORED_CELL_CHARS);
}

export function formatQueryCellRaw(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (value instanceof Date) {
        return formatSqlDate(value);
    }
    if (Buffer.isBuffer(value)) {
        return value.length === 0 ? '[binary]' : `[binary ${value.length} bytes]`;
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

export function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function namedAtBinds(
    sql: string,
    params: Record<string, string | null>
): { sql: string; params: Record<string, string | null> } {
    const rewritten = rewriteNamedBinds(sql, 'at');
    const bound: Record<string, string | null> = {};
    for (const name of rewritten.namesInOrder) {
        bound[name] = lookupParam(params, name);
    }
    return { sql: rewritten.sql, params: bound };
}

export function isCancelError(error: unknown): boolean {
    const err = error as { code?: string; name?: string; message?: string };
    const code = String(err.code ?? '').toUpperCase();
    if (code === 'ECANCEL' || code === 'ABORT_ERR' || err.name === 'AbortError') {
        return true;
    }
    const message = errorText(error).toLowerCase();
    return (
        message.includes('canceled') ||
        message.includes('cancelled') ||
        message.includes('aborted')
    );
}

export function isQueryCancelled(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true || isCancelError(error);
}

export function errorErrno(error: unknown): number | undefined {
    const err = error as { errno?: number; number?: number };
    if (typeof err.errno === 'number') {
        return err.errno;
    }
    if (typeof err.number === 'number') {
        return err.number;
    }
    return undefined;
}

export function hintForConnectError(message: string, config: ExtensionConfig): string {
    const lower = message.toLowerCase();
    if (lower.includes('unable to process incoming packet') || lower.includes('connection lost')) {
        if (config.engine === 'mssql') {
            return (
                'This usually means the host is not SQL Server, or TLS failed. ' +
                'If you use MySQL, set Engine to MySQL (port 3306) on the login page. ' +
                'If you use PostgreSQL, set Engine to PostgreSQL (port 5432). ' +
                'For local SQL Server: enable Trust server certificate, or turn Encrypt off.'
            );
        }
        if (config.engine === 'postgres') {
            return 'PostgreSQL handshake failed. Check host, port 5432, user/password, database name, and TLS settings.';
        }
        if (config.engine === 'bigquery') {
            return 'BigQuery handshake failed. Check the project id and run: gcloud auth application-default login';
        }
        return 'MySQL handshake failed. Check host, port 3306, user/password, and TLS settings.';
    }
    if (
        lower.includes('login failed') ||
        lower.includes('access denied') ||
        lower.includes('password authentication failed')
    ) {
        return 'Username or password is wrong, or the login cannot access this database.';
    }
    if (
        lower.includes('default credentials') ||
        lower.includes('could not refresh access token') ||
        lower.includes('unable to authenticate')
    ) {
        return 'Application Default Credentials are missing or expired. Run: gcloud auth application-default login';
    }
    if (lower.includes('getaddrinfo') || lower.includes('enotfound')) {
        return config.engine === 'bigquery'
            ? 'Project id could not be resolved. Check the Project field.'
            : 'Server host name could not be resolved. Check the Server field.';
    }
    if (lower.includes('etimeout') || lower.includes('timeout')) {
        if (config.loginKind === 'supabase') {
            return 'Timed out. If you used the direct db.… host, paste the Session pooler URL instead.';
        }
        return 'Timed out. Check VPN/firewall, port, and that the database server is running.';
    }
    if (lower.includes('certificate') || lower.includes('self signed')) {
        return 'Enable "Trust server certificate" on the login page for local/self-signed TLS.';
    }
    return config.engine === 'bigquery'
        ? 'Open BiSql: Open Connection / Login and verify the project id. Then run: gcloud auth application-default login'
        : 'Open BiSql: Open Connection / Login and verify engine, server, and port.';
}