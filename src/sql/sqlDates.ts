/**
 * Print a driver Date the way SQL stores a datetime, not as UTC ISO.
 * tedious (useUTC default) and leftover Dates use UTC wall-clock numbers.
 */
export function formatSqlDate(value: Date): string {
    const y = value.getUTCFullYear();
    const m = pad2(value.getUTCMonth() + 1);
    const d = pad2(value.getUTCDate());
    const hh = pad2(value.getUTCHours());
    const mm = pad2(value.getUTCMinutes());
    const ss = pad2(value.getUTCSeconds());
    const ms = value.getUTCMilliseconds();
    if (hh === '00' && mm === '00' && ss === '00' && ms === 0) {
        return `${y}-${m}-${d}`;
    }
    if (ms === 0) {
        return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
    }
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}.${String(ms).padStart(3, '0')}`;
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}
