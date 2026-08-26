import * as vscode from 'vscode';
import { hasParam, uniqueBindNames, uniquePlaceholderNames } from '../sql/parameters';

/**
 * Asks for missing `{name}` placeholders, then missing `:name` binds.
 * Empty `{name}` pastes nothing. Empty `:name` is SQL NULL. Cancel aborts.
 */
export async function promptRunParams(
    sql: string,
    title: string,
    existing: Record<string, string | null> = {}
): Promise<Record<string, string | null> | undefined> {
    const params: Record<string, string | null> = { ...existing };
    for (const name of uniquePlaceholderNames(sql)) {
        if (hasParam(params, name)) {
            continue;
        }
        const value = await vscode.window.showInputBox({
            prompt: `Value for {${name}}`,
            placeHolder: 'Leave empty to paste nothing',
            ignoreFocusOut: true,
            title
        });
        if (value === undefined) {
            return undefined;
        }
        params[name] = value;
    }
    for (const name of uniqueBindNames(sql)) {
        if (hasParam(params, name)) {
            continue;
        }
        const value = await vscode.window.showInputBox({
            prompt: `Value for :${name}`,
            placeHolder: 'Leave empty for NULL',
            ignoreFocusOut: true,
            title
        });
        if (value === undefined) {
            return undefined;
        }
        params[name] = value === '' ? null : value;
    }
    return params;
}
