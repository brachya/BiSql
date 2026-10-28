import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import {
    buildDeleteSql,
    buildInsertSql,
    buildRenameSql,
    buildUpdateSql,
    canDuplicateRow,
    NULL_DISPLAY,
    ResultEditPlan
} from '../sql/resultEdit';

export type ConfirmResult = 'applied' | 'cancelled' | 'failed';

export type CellEditResult = ConfirmResult | 'unchanged';

export interface ResultMutationHost {
    plan: ResultEditPlan;
    rows: string[][];
    columns: string[];
    db: SqlServerService;
    rowAt(row: number): string[] | undefined;
    postStatus(message: string, ok: boolean): Promise<void>;
    post(message: Record<string, unknown>): Promise<void>;
    confirmAndRun(
        title: string,
        sql: string,
        params: Record<string, string | null>,
        requireOneRow: boolean
    ): Promise<ConfirmResult>;
    refresh(): Promise<void>;
}

export async function handleSetNull(host: ResultMutationHost, row: number, col: number): Promise<void> {
    const column = host.plan.columns[col];
    if (!host.plan.editable || !column?.canSetNull || !column.sourceColumn) {
        await host.postStatus('This cell cannot be set to NULL.', false);
        return;
    }
    const current = host.rowAt(row);
    if (!current) {
        return;
    }
    if (current[col] === NULL_DISPLAY) {
        await host.postStatus('That cell is already NULL.', true);
        return;
    }
    const mutation = buildUpdateSql(host.plan, column.sourceColumn, null, current);
    if ('error' in mutation) {
        await host.postStatus(mutation.error, false);
        return;
    }
    const confirmed = await host.confirmAndRun(
        'This will set a live database value to NULL.',
        mutation.sql,
        mutation.params,
        true
    );
    if (confirmed !== 'applied') {
        return;
    }
    current[col] = NULL_DISPLAY;
    await host.post({ type: 'applied', action: 'setNull', row, col, value: NULL_DISPLAY });
}

export async function handleEditCell(
    host: ResultMutationHost,
    row: number,
    col: number,
    value: string
): Promise<CellEditResult> {
    const column = host.plan.columns[col];
    if (!host.plan.editable || !column?.canEdit || !column.sourceColumn) {
        await host.postStatus('This cell cannot be edited.', false);
        return 'failed';
    }
    const current = host.rowAt(row);
    if (!current) {
        return 'failed';
    }
    if (current[col] === value) {
        return 'unchanged';
    }
    const mutation = buildUpdateSql(host.plan, column.sourceColumn, value, current);
    if ('error' in mutation) {
        await host.postStatus(mutation.error, false);
        return 'failed';
    }
    const confirmed = await host.confirmAndRun(
        'This will change live data in the database.',
        mutation.sql,
        mutation.params,
        true
    );
    if (confirmed !== 'applied') {
        return confirmed;
    }
    current[col] = value;
    await host.post({ type: 'applied', action: 'editCell', row, col, value });
    return 'applied';
}

export async function handleDeleteRow(host: ResultMutationHost, row: number): Promise<void> {
    if (!host.plan.editable) {
        await host.postStatus('This result cannot be edited.', false);
        return;
    }
    const current = host.rowAt(row);
    if (!current) {
        return;
    }
    const mutation = buildDeleteSql(host.plan, current);
    if ('error' in mutation) {
        await host.postStatus(mutation.error, false);
        return;
    }
    const confirmed = await host.confirmAndRun(
        'This will delete a row from the live table.',
        mutation.sql,
        mutation.params,
        true
    );
    if (confirmed !== 'applied') {
        return;
    }
    host.rows.splice(row, 1);
    await host.post({ type: 'applied', action: 'deleteRow', row });
}

export async function handleInsertRow(
    host: ResultMutationHost,
    values: string[],
    omit: readonly number[] = []
): Promise<void> {
    if (!canDuplicateRow(host.plan)) {
        await host.postStatus('This table cannot take a new row.', false);
        await host.post({ type: 'rowFormIdle' });
        return;
    }
    if (values.length !== host.plan.columns.length) {
        await host.postStatus('The form does not match the result columns.', false);
        await host.post({ type: 'rowFormIdle' });
        return;
    }
    const mutation = buildInsertSql(host.plan, values, omit);
    if ('error' in mutation) {
        await host.postStatus(mutation.error, false);
        await host.post({ type: 'rowFormIdle' });
        return;
    }
    // Triggers (SQL Server adds them up) can report more than 1 row after the
    // insert is already saved. Requiring exactly 1 then looks like a failure,
    // and the open form makes a second insert one click away.
    const confirmed = await host.confirmAndRun(
        'This will insert a row into the live table.',
        mutation.sql,
        mutation.params,
        false
    );
    if (confirmed !== 'applied') {
        await host.post({ type: 'rowFormIdle' });
        return;
    }
    await host.post({ type: 'applied', action: 'insertRow' });
    await host.refresh();
}

export async function handleRenameColumn(host: ResultMutationHost, col: number): Promise<void> {
    const column = host.plan.columns[col];
    if (!host.plan.editable || !column?.canRename || !column.sourceColumn) {
        await host.postStatus('This column cannot be renamed.', false);
        return;
    }
    const oldName = column.sourceColumn;
    const newName = await vscode.window.showInputBox({
        title: 'Rename column',
        prompt: `New name for ${oldName} on ${host.plan.tableDisplay}`,
        value: oldName,
        ignoreFocusOut: true
    });
    if (newName === undefined) {
        return;
    }
    const trimmed = newName.trim();
    const built = buildRenameSql(host.plan, oldName, trimmed);
    if ('error' in built) {
        vscode.window.showErrorMessage(built.error);
        return;
    }
    const confirmed = await host.confirmAndRun(
        'This will rename a real table column. Queries that use the old name will break.',
        built.sql,
        {},
        false
    );
    if (confirmed !== 'applied') {
        return;
    }
    applyRenameInMemory(host, oldName, trimmed, col);
    await host.db.refreshSchema();
    await host.post({
        type: 'applied',
        action: 'renameColumn',
        col,
        displayName: trimmed,
        sourceColumn: trimmed
    });
}

export function applyRenameInMemory(
    host: ResultMutationHost,
    oldName: string,
    newName: string,
    col: number
): void {
    host.columns[col] = newName;
    const editCol = host.plan.columns[col];
    if (editCol) {
        editCol.displayName = newName;
        editCol.sourceColumn = newName;
    }
    const table = host.plan.table;
    if (!table) {
        return;
    }
    const info = table.columnsByLower.get(oldName.toLowerCase());
    if (!info) {
        return;
    }
    table.columnsByLower.delete(oldName.toLowerCase());
    info.name = newName;
    table.columnsByLower.set(newName.toLowerCase(), info);
}
