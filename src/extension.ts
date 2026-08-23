import * as vscode from 'vscode';
import { formatSqlInFile } from './commands/formatSql';
import { Commands } from './commands/ids';
import { runSelectedSql } from './commands/runSelectedSql';
import { CONFIG_SECTION, SqlServerService, selectedDatabases } from './db/connection';
import { SqlCodeActionProvider } from './providers/codeActions';
import { SqlCompletionProvider } from './providers/completion';
import { DiagnosticsManager } from './providers/diagnostics';
import { SqlHoverProvider } from './providers/hover';
import { SqlRangeFormatProvider } from './providers/sqlFormat';
import { ConnectionPanel } from './ui/connectionPanel';

const QUICK_SUGGESTIONS_FLAG = 'bisql.quickSuggestionsPrompted';
const LEGACY_QUICK_SUGGESTIONS_FLAG = 'sqlPythonValidator.quickSuggestionsPrompted';
const LEGACY_CONFIG_SECTION = 'sqlPythonValidator';

let db: SqlServerService | undefined;
let diagnostics: DiagnosticsManager | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    output = vscode.window.createOutputChannel('BiSql');
    context.subscriptions.push(output);

    db = new SqlServerService(context, output);
    context.subscriptions.push(db);

    // Disk snapshot first, so the first validate already has table names.
    await db.loadDiskCache();

    diagnostics = new DiagnosticsManager(db);
    context.subscriptions.push(diagnostics);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    // Clicking the status bar opens the login page (not just refresh).
    statusBar.command = Commands.openConnectionPanel;
    statusBar.tooltip = 'BiSql — open connection / login';
    context.subscriptions.push(statusBar);
    updateStatusBar();

    context.subscriptions.push(
        db.onDidChangeState(() => updateStatusBar()),
        db.onDidChangeSchema(() => updateStatusBar())
    );

    const selector: vscode.DocumentSelector = { language: 'python' };

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            new SqlCompletionProvider(db),
            ' ',
            '.',
            "'",
            '"',
            '[',
            ',',
            '('
        ),
        vscode.languages.registerHoverProvider(selector, new SqlHoverProvider(db)),
        vscode.languages.registerCodeActionsProvider(
            selector,
            new SqlCodeActionProvider(diagnostics),
            { providedCodeActionKinds: SqlCodeActionProvider.providedCodeActionKinds }
        ),
        vscode.languages.registerDocumentRangeFormattingEditProvider(
            selector,
            new SqlRangeFormatProvider(db)
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(Commands.openConnectionPanel, () => {
            ConnectionPanel.show(context, db!, diagnostics!);
        }),
        vscode.commands.registerCommand(Commands.setPassword, async () => {
            const password = await vscode.window.showInputBox({
                prompt: 'SQL Server password',
                password: true,
                ignoreFocusOut: true
            });
            if (password === undefined) {
                return;
            }
            await db!.setPassword(password);
            vscode.window.showInformationMessage(
                'Password stored in the OS keychain (SecretStorage).'
            );
            await db!.reconfigure();
            await diagnostics!.revalidateOpenDocuments(true);
        }),
        vscode.commands.registerCommand(Commands.clearPassword, async () => {
            await db!.clearPassword();
            vscode.window.showInformationMessage('Stored password cleared.');
            await db!.reconfigure();
        }),
        vscode.commands.registerCommand(Commands.refreshSchema, async () => {
            const ok = await db!.refreshSchema();
            if (ok) {
                vscode.window.showInformationMessage(
                    `Schema refreshed: ${db!.schema.tables.length} tables/views.`
                );
                await diagnostics!.revalidateOpenDocuments(false);
            } else {
                vscode.window.showWarningMessage(
                    db!.lastErrorMessage ??
                        'Could not refresh schema. Check connection settings.'
                );
            }
            updateStatusBar();
        }),
        vscode.commands.registerCommand(Commands.testConnection, async () => {
            const result = await db!.testConnection();
            if (result.ok) {
                vscode.window.showInformationMessage(`Connected: ${result.message}`);
                await db!.refreshSchema();
            } else {
                vscode.window.showErrorMessage(`Connection failed: ${result.message}`);
            }
            updateStatusBar();
        }),
        vscode.commands.registerCommand(Commands.validateCurrentFile, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'python') {
                vscode.window.showWarningMessage('Open a Python file first.');
                return;
            }
            await diagnostics!.validateDocument(editor.document, true);
            vscode.window.showInformationMessage('Validation finished.');
        }),
        vscode.commands.registerCommand(
            Commands.enableInlineSuggestions,
            async () => {
                await enablePythonStringSuggestions();
                vscode.window.showInformationMessage(
                    'Enabled suggestions inside Python strings for this user.'
                );
            }
        ),
        vscode.commands.registerCommand(Commands.clearSchemaCache, async () => {
            await db!.clearDiskCache();
            vscode.window.showInformationMessage('Cached schema snapshot cleared.');
            updateStatusBar();
        }),
        vscode.commands.registerCommand(Commands.runSelectedSql, () =>
            runSelectedSql(db!)
        ),
        vscode.commands.registerCommand(Commands.formatSqlInFile, () =>
            formatSqlInFile(db!)
        ),
        vscode.commands.registerCommand(
            Commands.setTableDatabasePreference,
            async (tableKey: string, database: string) => {
                if (!tableKey || !database) {
                    return;
                }
                await db!.setTableDatabasePreference(tableKey, database);
                await diagnostics!.revalidateOpenDocuments(false);
                vscode.window.showInformationMessage(
                    `Prefer '${database}' for table '${tableKey}'.`
                );
                updateStatusBar();
            }
        )
    );

    let reconfigureTimer: NodeJS.Timeout | undefined;
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                !event.affectsConfiguration(CONFIG_SECTION) &&
                !event.affectsConfiguration(LEGACY_CONFIG_SECTION)
            ) {
                return;
            }
            // Debounce: the login form writes several settings in a row.
            if (reconfigureTimer) {
                clearTimeout(reconfigureTimer);
            }
            reconfigureTimer = setTimeout(() => {
                void (async () => {
                    db!.invalidateConfigCache();
                    await db!.reconfigure();
                    await diagnostics!.revalidateOpenDocuments(true);
                    updateStatusBar();
                })();
            }, 250);
        })
    );

    updateStatusBar();

    // First-run: open the login page when nothing is configured yet.
    const config = db.getConfig();
    if (!config.server || !config.database) {
        ConnectionPanel.show(context, db, diagnostics);
    }

    void maybePromptQuickSuggestions(context);
    output.appendLine('BiSql activated.');
}

export function deactivate(): void {
    diagnostics?.dispose();
    db?.dispose();
    statusBar?.dispose();
    output?.dispose();
}

function updateStatusBar(): void {
    if (!statusBar || !db) {
        return;
    }
    const config = db.getConfig();
    if (!config.enabled) {
        statusBar.text = '$(database) SQL: off';
        statusBar.show();
        return;
    }
    const count = db.schema.tables.length;
    const stale = db.schema.stale ? ' (cached)' : '';
    const engineLabel = config.engine === 'mysql' ? 'MySQL' : 'SQL';
    const dbCount = selectedDatabases(config).length;
    const dbSuffix = dbCount > 1 ? ` · ${dbCount} DBs` : '';
    switch (db.connectionState) {
        case 'connected':
            statusBar.text = `$(database) ${engineLabel}: ${count} tables${stale}${dbSuffix}`;
            break;
        case 'connecting':
            statusBar.text = `$(sync~spin) ${engineLabel}: connecting…`;
            break;
        case 'unconfigured':
            statusBar.text = '$(key) SQL: login';
            break;
        case 'error':
            statusBar.text = `$(warning) ${engineLabel}: error`;
            statusBar.tooltip =
                (db.lastErrorMessage ?? 'Connection error') + ' — click to open login';
            break;
        case 'disabled':
            statusBar.text = '$(database) SQL: off';
            break;
        default:
            statusBar.text =
                count > 0
                    ? `$(database) ${engineLabel}: ${count} tables${stale}`
                    : '$(key) SQL: login';
            break;
    }
    statusBar.show();
}

async function enablePythonStringSuggestions(): Promise<void> {
    const config = vscode.workspace.getConfiguration('editor', {
        languageId: 'python'
    });
    await config.update(
        'quickSuggestions',
        { other: 'on', comments: 'off', strings: 'on' },
        vscode.ConfigurationTarget.Global
    );
}

async function maybePromptQuickSuggestions(context: vscode.ExtensionContext): Promise<void> {
    const extensionConfig = db!.getConfig();
    if (!extensionConfig.promptQuickSuggestions) {
        return;
    }
    if (
        context.globalState.get<boolean>(QUICK_SUGGESTIONS_FLAG) ||
        context.globalState.get<boolean>(LEGACY_QUICK_SUGGESTIONS_FLAG)
    ) {
        return;
    }

    const inspected = vscode.workspace
        .getConfiguration('editor', { languageId: 'python' })
        .get<{ other?: string | boolean; comments?: string | boolean; strings?: string | boolean }>(
            'quickSuggestions'
        );
    const strings = inspected?.strings;
    if (strings === 'on' || strings === true) {
        await context.globalState.update(QUICK_SUGGESTIONS_FLAG, true);
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        'Enable SQL suggestions while typing inside Python strings?',
        'Enable',
        'Not now',
        'Never'
    );
    if (choice === 'Enable') {
        await enablePythonStringSuggestions();
        await context.globalState.update(QUICK_SUGGESTIONS_FLAG, true);
    } else if (choice === 'Never') {
        await context.globalState.update(QUICK_SUGGESTIONS_FLAG, true);
    }
}
