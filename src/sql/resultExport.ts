import { NULL_DISPLAY } from './resultEdit';

export type ExportScope = 'table' | 'row' | 'cell';
export type ExportFormat = 'json' | 'csv';

export interface ExportRequest {
    columns: string[];
    rows: string[][];
    scope: ExportScope;
    format: ExportFormat;
    row?: number;
    col?: number;
    nullDisplay?: string;
}

export interface ExportResult {
    content: string;
    suggestedName: string;
}

/**
 * Build JSON or CSV text from a result grid.
 * NULL cells become JSON null / empty CSV fields, not the display word "NULL".
 */
export function buildResultExport(request: ExportRequest): ExportResult | { error: string } {
    const nullDisplay = request.nullDisplay ?? NULL_DISPLAY;
    const columns = request.columns;
    if (!columns || columns.length === 0) {
        return { error: 'There are no columns to export.' };
    }

    const scope = request.scope;
    if (scope !== 'table' && scope !== 'row' && scope !== 'cell') {
        return { error: 'Choose All rows, This row, or This cell.' };
    }
    if (request.format !== 'json' && request.format !== 'csv') {
        return { error: 'Choose JSON or CSV.' };
    }
    if (scope === 'row' || scope === 'cell') {
        const row = request.row;
        if (!Number.isInteger(row) || row === undefined || row < 0 || row >= request.rows.length) {
            return { error: scope === 'row' ? 'Select a row first.' : 'Select a cell first.' };
        }
    }
    if (scope === 'cell') {
        const col = request.col;
        if (!Number.isInteger(col) || col === undefined || col < 0 || col >= columns.length) {
            return { error: 'Select a cell first.' };
        }
    }

    if (request.format === 'json') {
        return {
            content: toJson(request, nullDisplay),
            suggestedName: suggestedName(request, 'json')
        };
    }
    return {
        content: toCsv(request, nullDisplay),
        suggestedName: suggestedName(request, 'csv')
    };
}

function toJson(request: ExportRequest, nullDisplay: string): string {
    const keys = uniqueColumnKeys(request.columns);
    if (request.scope === 'cell') {
        const value = cellValue(request.rows[request.row!][request.col!], nullDisplay);
        return `${JSON.stringify(value, null, 2)}\n`;
    }
    if (request.scope === 'row') {
        return `${JSON.stringify(rowObject(keys, request.rows[request.row!], nullDisplay), null, 2)}\n`;
    }
    const objects = request.rows.map((row) => rowObject(keys, row, nullDisplay));
    return `${JSON.stringify(objects, null, 2)}\n`;
}

function toCsv(request: ExportRequest, nullDisplay: string): string {
    if (request.scope === 'cell') {
        return `${csvField(cellValue(request.rows[request.row!][request.col!], nullDisplay))}\n`;
    }
    const header = request.columns.map((name) => csvField(name)).join(',');
    if (request.scope === 'row') {
        return `${header}\n${csvRow(request.rows[request.row!], request.columns.length, nullDisplay)}\n`;
    }
    const lines = [header];
    for (const row of request.rows) {
        lines.push(csvRow(row, request.columns.length, nullDisplay));
    }
    return `${lines.join('\n')}\n`;
}

function rowObject(
    keys: string[],
    row: string[],
    nullDisplay: string
): Record<string, string | null> {
    const obj: Record<string, string | null> = {};
    for (let i = 0; i < keys.length; i++) {
        obj[keys[i]] = cellValue(row[i], nullDisplay);
    }
    return obj;
}

function csvRow(row: string[], columnCount: number, nullDisplay: string): string {
    const fields: string[] = [];
    for (let i = 0; i < columnCount; i++) {
        fields.push(csvField(cellValue(row[i], nullDisplay)));
    }
    return fields.join(',');
}

function cellValue(raw: string | undefined, nullDisplay: string): string | null {
    if (raw === undefined || raw === nullDisplay) {
        return null;
    }
    return raw;
}

/** RFC 4180: quote when the value has comma, quote, CR, or LF. */
export function csvField(value: string | null): string {
    if (value === null) {
        return '';
    }
    if (/[",\r\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

function uniqueColumnKeys(columns: string[]): string[] {
    const seen = new Map<string, number>();
    return columns.map((name) => {
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        return n === 1 ? name : `${name}_${n}`;
    });
}

function suggestedName(request: ExportRequest, ext: ExportFormat): string {
    if (request.scope === 'cell') {
        const col = safeFilePart(request.columns[request.col!] || 'cell');
        return `sql-cell-${col}.${ext}`;
    }
    if (request.scope === 'row') {
        return `sql-row-${(request.row ?? 0) + 1}.${ext}`;
    }
    return `sql-results.${ext}`;
}

function safeFilePart(value: string): string {
    const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned.slice(0, 40) || 'cell';
}
