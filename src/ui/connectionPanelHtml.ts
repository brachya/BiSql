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
