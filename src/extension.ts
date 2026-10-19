import * as vscode from 'vscode';
import { formatSqlInFile } from './commands/formatSql';
import { formatSqlAt } from './commands/formatSqlAt';
import { explainSqlAt } from './commands/explainSqlAt';
import { Commands } from './commands/ids';
import { switchConnection } from './commands/switchConnection';
import { refreshSchemaWithPicker } from './commands/refreshSchema';
import { switchProject } from './commands/switchProject';
import { showQueryHistory } from './commands/queryHistory';
import { runSelectedSql } from './commands/runSelectedSql';
import { validateSqlAt } from './commands/validateSqlAt';
import { CONFIG_SECTION, LoginKind, SqlServerService, selectedDatabases } from './db/connection';
import { vscodePorts } from './db/vscodePorts';
import { SqlCodeActionProvider } from './providers/codeActions';
import { SqlCodeLensProvider } from './providers/sqlCodeLens';
import { SqlCompletionProvider } from './providers/completion';
import { DiagnosticsManager } from './providers/diagnostics';
import { SqlHoverProvider } from './providers/hover';
import { SqlRangeFormatProvider } from './providers/sqlFormat';
import { ConnectionPanel } from './ui/connectionPanel';
import { SchemaExplorer } from './ui/schemaExplorer';
import { BisqlExplorerProvider } from './ui/explorerTree';
import { schemaMapGroupFromNode, schemaMapGroupKey } from './ui/schemaTreeModel';
import { registerExplorerCommands } from './commands/explorerCommands';
import { startBisqlMcp } from './mcp/register';

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

    db = new SqlServerService(vscodePorts(context, output));
    context.subscriptions.push(db);

    await db.migrateSavedConnections();
    // Disk snapshot first, so the first validate already has table names.
    await db.loadDiskCache();

    diagnostics = new DiagnosticsManager(db);
    context.subscriptions.push(diagnostics);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = Commands.switchConnection;
    statusBar.tooltip = 'BiSql — switch connection';
    context.subscriptions.push(statusBar);
    updateStatusBar();

    context.subscriptions.push(
        db.onDidChangeState(() => updateStatusBar()),
        db.onDidChangeSchema(() => updateStatusBar())
    );

    const selector: vscode.DocumentSelector = [{ language: 'python' }, { language: 'sql' }];

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
        ),
        vscode.languages.registerCodeLensProvider(selector, new SqlCodeLensProvider(db, diagnostics))
    );

    const explorer = new BisqlExplorerProvider(context, db);
    const treeView = vscode.window.createTreeView('bisql.explorer', {
        treeDataProvider: explorer,
        showCollapseAll: true
    });
    context.subscriptions.push(explorer, treeView);
    registerExplorerCommands(context, db, diagnostics, explorer, treeView);

    const revealInSidebar = (qualifiedName: string) => {
        void explorer.revealQualifiedName(treeView, qualifiedName);
    };
    SchemaExplorer.defaultRevealInSidebar = revealInSidebar;

    context.subscriptions.push(
        vscode.commands.registerCommand(Commands.openConnectionPanel, () => {
            ConnectionPanel.show(context, db!, diagnostics!);
        }),
        vscode.commands.registerCommand(Commands.switchConnection, () =>
            switchConnection(db!, diagnostics!)
        ),
        vscode.commands.registerCommand(Commands.switchProject, () =>
            switchProject(db!, diagnostics!)
        ),
        vscode.commands.registerCommand(Commands.openSchemaExplorer, () => {
            SchemaExplorer.show(
                db!,
                () => {
                    ConnectionPanel.show(context, db!, diagnostics!);
                },
                { revealInSidebar, diagnostics: diagnostics! }
            );
        }),
        vscode.commands.registerCommand(Commands.visualizeSchema, async (item?: { node?: { database?: string; schemaName?: string; qualifiedName?: string } }) => {
            const openLogin = () => {
                ConnectionPanel.show(context, db!, diagnostics!);
            };
            const tables = db!.schema.tables;
            if (tables.length === 0) {
                SchemaExplorer.show(db!, openLogin, {
                    mode: 'map',
                    revealInSidebar,
                    diagnostics: diagnostics!
                });
                return;
            }
            const config = db!.getConfig();
            const engine = config.engine;
            const fromNode = item?.node
                ? schemaMapGroupFromNode(
                      item.node,
                      engine,
                      tables,
                      engine === 'bigquery' ? config.server : ''
                  )
                : undefined;
            if (fromNode) {
                SchemaExplorer.show(db!, openLogin, {
                    mode: 'map',
                    database: fromNode,
                    focusTable: item?.node?.qualifiedName,
                    revealInSidebar,
                    diagnostics: diagnostics!
                });
                return;
            }
            const counts = new Map<string, number>();
            for (const table of tables) {
                const key = schemaMapGroupKey(table, engine);
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            const entries = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            let pickedDb: string | undefined;
            if (entries.length === 1) {
                pickedDb = entries[0]![0];
            } else if (entries.length > 1) {
                const defaultDb = config.database.toLowerCase();
                const home = engine === 'bigquery' ? config.server.toLowerCase() : '';
                const isDefaultGroup = (name: string): boolean => {
                    const lower = name.toLowerCase();
                    return lower === defaultDb || (home !== '' && lower === `${home}.${defaultDb}`);
                };
                entries.sort((a, b) => {
                    const aDef = isDefaultGroup(a[0]) ? 0 : 1;
                    const bDef = isDefaultGroup(b[0]) ? 0 : 1;
                    return aDef - bDef || a[0].localeCompare(b[0]);
                });
                const noun =
                    engine === 'postgres'
                        ? 'schema'
                        : engine === 'bigquery'
                          ? 'dataset'
                          : 'database';
                const picked = await vscode.window.showQuickPick(
                    entries.map(([name, count]) => ({
                        label: name,
                        description: `${count} table${count === 1 ? '' : 's'}`,
                        database: name
                    })),
                    {
                        placeHolder: `Pick a ${noun} to visualize on the Schema Map…`
                    }
                );
                if (!picked) {
                    return;
                }
                pickedDb = picked.database;
            }
            SchemaExplorer.show(db!, openLogin, {
                mode: 'map',
                database: pickedDb,
                revealInSidebar,
                diagnostics: diagnostics!
            });
        }),
        vscode.commands.registerCommand(Commands.setPassword, async () => {
            const config = db!.getConfig();
            if (config.engine === 'bigquery') {
                vscode.window.showWarningMessage(
                    'BigQuery does not use a password. Sign in with gcloud.'
                );
                return;
            }
            const password = await vscode.window.showInputBox({
                prompt: `${passwordEngineLabel(config.loginKind)} password`,
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
            if (db!.getConfig().engine === 'bigquery') {
                vscode.window.showWarningMessage(
                    'BigQuery does not use a password. Sign in with gcloud.'
                );
                return;
            }
            await db!.clearPassword();
            vscode.window.showInformationMessage('Stored password cleared.');
            await db!.reconfigure();
        }),
        vscode.commands.registerCommand(Commands.refreshSchema, async () => {
            const refreshed = await refreshSchemaWithPicker(db!, diagnostics!);
            updateStatusBar();
            if (refreshed.updated) {
                explorer.refresh();
            }
        }),
        vscode.commands.registerCommand(Commands.testConnection, async () => {
            const result = await db!.testConnection();
            if (result.ok) {
                vscode.window.showInformationMessage(`Connected: ${result.message}`);
                await refreshSchemaWithPicker(db!, diagnostics!, { silent: true });
            } else {
                vscode.window.showErrorMessage(`Connection failed: ${result.message}`);
            }
            updateStatusBar();
        }),
        vscode.commands.registerCommand(Commands.validateCurrentFile, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || (editor.document.languageId !== 'python' && editor.document.languageId !== 'sql')) {
                vscode.window.showWarningMessage('Open a Python or SQL file first.');
                return;
            }
            await diagnostics!.validateDocument(editor.document, true);
            vscode.window.showInformationMessage('Validation finished.');
        }),
        vscode.commands.registerCommand(Commands.validateProject, async () => {
            const result = await diagnostics!.validateProject();
            if ('skipped' in result) {
                vscode.window.showWarningMessage(result.skipped);
                return;
            }
            if (result.cancelled) {
                vscode.window.showInformationMessage('Project validation cancelled.');
                return;
            }
            await vscode.commands.executeCommand('workbench.action.problems.focus');
            if (result.issues === 0) {
                vscode.window.showInformationMessage('No BiSql problems.');
                return;
            }
            vscode.window.showInformationMessage(
                `${result.issues} problem${result.issues === 1 ? '' : 's'} in ${result.files} file${
                    result.files === 1 ? '' : 's'
                }.`
            );
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
        vscode.commands.registerCommand(Commands.runSelectedSql, (...args: unknown[]) =>
            runSelectedSql(db!, ...args)
        ),
        vscode.commands.registerCommand(Commands.queryHistory, () => showQueryHistory(db!)),
        vscode.commands.registerCommand(Commands.formatSqlInFile, () =>
            formatSqlInFile(db!)
        ),
        vscode.commands.registerCommand(Commands.formatSqlAt, (...args: unknown[]) =>
            formatSqlAt(db!, ...args)
        ),
        vscode.commands.registerCommand(Commands.explainSqlAt, (...args: unknown[]) =>
            explainSqlAt(db!, ...args)
        ),
        vscode.commands.registerCommand(Commands.validateSqlAt, (...args: unknown[]) =>
            validateSqlAt(diagnostics!, ...args)
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
                    await db!.enforceQueryHistoryLimit();
                    await db!.reconfigure();
                    await diagnostics!.revalidateOpenDocuments(true);
                    updateStatusBar();
                })();
            }, 250);
        })
    );

    updateStatusBar();

    const mcp = await startBisqlMcp(context, db, output);
    if (mcp) {
        context.subscriptions.push(mcp);
    }

    // First-run: open the login page when a Python file is open and nothing is configured.
    // Do not pop this on every Cursor start just because MCP activated.
    const config = db.getConfig();
    const hasPython = vscode.workspace.textDocuments.some(
        (document) => document.languageId === 'python'
    );
    if (hasPython && (!config.server || !config.database)) {
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

function passwordEngineLabel(kind: LoginKind): string {
    if (kind === 'mysql') {
        return 'MySQL';
    }
    if (kind === 'postgres') {
        return 'PostgreSQL';
    }
    if (kind === 'supabase') {
        return 'Supabase';
    }
    return 'SQL Server';
}

function updateStatusBar(): void {
    if (!statusBar || !db) {
        return;
    }
    const config = db.getConfig();
    const bigQuery = config.engine === 'bigquery';
    // Command palette: Switch Project only for BigQuery. Password commands for the others.
    void vscode.commands.executeCommand('setContext', 'bisql.isBigQuery', bigQuery);
    void vscode.commands.executeCommand('setContext', 'bisql.usesPassword', !bigQuery);
    if (!config.enabled) {
        statusBar.text = '$(database) SQL: off';
        statusBar.show();
        return;
    }
    const count = db.schema.tables.length;
    const stale = db.schema.stale ? ' (cached)' : '';
    const label = config.connectionName || (
        config.engine === 'mysql'
            ? 'MySQL'
            : config.engine === 'postgres'
              ? 'PostgreSQL'
              : config.engine === 'bigquery'
                ? 'BigQuery'
                : 'SQL'
    );
    const dbCount = selectedDatabases(config).length;
    const dbSuffix = dbCount > 1 ? ` · ${dbCount} DBs` : '';
    switch (db.connectionState) {
        case 'connected':
            statusBar.text = `$(database) ${label}: ${count} tables${stale}${dbSuffix}`;
            break;
        case 'connecting':
            statusBar.text = `$(sync~spin) ${label}: connecting…`;
            break;
        case 'unconfigured':
            statusBar.text = '$(key) SQL: login';
            break;
        case 'error':
            statusBar.text = `$(warning) ${label}: error`;
            break;
        case 'disabled':
            statusBar.text = '$(database) SQL: off';
            break;
        default:
            statusBar.text =
                count > 0
                    ? `$(database) ${label}: ${count} tables${stale}`
                    : '$(key) SQL: login';
            break;
    }
    statusBar.tooltip =
        db.connectionState === 'error' && db.lastErrorMessage
            ? `${db.lastErrorMessage} — click to switch connection`
            : 'BiSql — switch connection';
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
