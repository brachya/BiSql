import type { ConnectionState } from '../db/queryCells';
import type { LoginKind } from '../db/engines';

/** After a successful save, describe connection outcome without treating "not connected yet" as a save failure. */
export function saveResultMessage(input: {
    connected: boolean;
    connectionState: ConnectionState;
    lastError?: string;
    tables: number;
    dbLabel: string;
    loginKind: LoginKind;
}): { ok: boolean; message: string } {
    if (input.connected) {
        return {
            ok: true,
            message: `Saved. Connected — ${input.tables} tables/views from ${input.dbLabel}.`
        };
    }
    if (input.lastError) {
        return {
            ok: false,
            message: `Saved. Connection failed: ${input.lastError}`
        };
    }
    if (input.connectionState === 'disabled') {
        return {
            ok: true,
            message: 'Saved. Extension is disabled — turn it on under Options, then Test Connection.'
        };
    }
    if (input.connectionState === 'unconfigured') {
        const hint =
            input.loginKind === 'bigquery'
                ? 'Set project and default dataset, then Test Connection.'
                : 'Fill in the login, then Test Connection.';
        return { ok: true, message: `Saved. ${hint}` };
    }
    const hint =
        input.loginKind === 'bigquery'
            ? 'Click Test Connection to verify Google login (ADC).'
            : 'Click Test Connection to connect.';
    return { ok: true, message: `Saved. ${hint}` };
}

/** Live schema/status belong to the active login only. A new or other row stays blank. */
export function panelStatsForSelection(input: {
    selectedId: string;
    activeId: string;
    hasServer: boolean;
    liveState: string;
    lastError?: string;
    tableCount: number;
    stale: boolean;
}): { state: string; lastError?: string; tableCount: number; stale: boolean } {
    if (!input.hasServer) {
        return { state: 'unconfigured', tableCount: 0, stale: false };
    }
    if (input.selectedId && input.selectedId === input.activeId) {
        return {
            state: input.liveState,
            lastError: input.lastError,
            tableCount: input.tableCount,
            stale: input.stale
        };
    }
    return { state: 'disconnected', tableCount: 0, stale: false };
}
