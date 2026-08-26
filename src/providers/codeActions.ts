import * as vscode from 'vscode';
import { Commands } from '../commands/ids';
import { DIAGNOSTIC_SOURCE, DiagnosticsManager } from './diagnostics';

export class SqlCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    constructor(private readonly diagnostics: DiagnosticsManager) {}

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
                continue;
            }

            const fixes = this.diagnostics.getFixes(document.uri, diagnostic.range);
            let preferredSet = false;
            for (const fix of fixes) {
                const action = new vscode.CodeAction(
                    fix.label,
                    vscode.CodeActionKind.QuickFix
                );
                action.diagnostics = [diagnostic];
                const edit = new vscode.WorkspaceEdit();
                edit.replace(document.uri, diagnostic.range, fix.replacement);
                action.edit = edit;
                if (!preferredSet) {
                    action.isPreferred = true;
                    preferredSet = true;
                }
                actions.push(action);
            }

            const code = diagnostic.code;
            const isNotFound =
                code === 'unknown-table' ||
                code === 'unknown-column' ||
                code === 208 ||
                code === 207 ||
                code === 4104;
            if (isNotFound) {
                const refresh = new vscode.CodeAction(
                    'Refresh database schema',
                    vscode.CodeActionKind.QuickFix
                );
                refresh.diagnostics = [diagnostic];
                refresh.command = {
                    title: 'Refresh database schema',
                    command: Commands.refreshSchema
                };
                actions.push(refresh);
            }
        }

        // Also surface fixes when the lightbulb is requested without context diagnostics
        // (some hosts only pass overlapping ones — keep a range lookup as backup).
        if (actions.length === 0) {
            const fixes = this.diagnostics.getFixes(document.uri, range);
            for (const fix of fixes) {
                const action = new vscode.CodeAction(
                    fix.label,
                    vscode.CodeActionKind.QuickFix
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(document.uri, range, fix.replacement);
                action.edit = edit;
                action.isPreferred = true;
                actions.push(action);
            }
        }

        return actions;
    }
}
