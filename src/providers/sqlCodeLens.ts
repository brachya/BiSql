import * as vscode from 'vscode';
import { Commands } from '../commands/ids';
import { formatScanBytes } from '../db/bigquery';
import { SqlServerService } from '../db/connection';
import {
    extractSqlBlocks,
    isSqlDocument,
    splitSqlStatements
} from '../parser/sqlExtractor';
import { codeLensRange } from '../sql/sqlTarget';
import { DiagnosticsManager } from './diagnostics';

const LENS_ACTIONS: { title: string; tooltip: string; command: string }[] = [
    { title: '$(bisql-logo)', tooltip: 'BiSql', command: Commands.runSelectedSql },
    { title: '$(play) Run', tooltip: 'Run this SQL', command: Commands.runSelectedSql },
    { title: '$(symbol-ruler) Format', tooltip: 'Format this SQL', command: Commands.formatSqlAt },
    { title: '$(type-hierarchy) Explain', tooltip: 'Explain this SQL', command: Commands.explainSqlAt },
    { title: '$(verified) Validate', tooltip: 'Validate this SQL', command: Commands.validateSqlAt }
];

/**
 * Run / Format / Explain / Validate above each Python SQL string and each
 * statement in a `.sql` file. On BigQuery, a dry-run byte estimate sits
 * next to Run when save/validate has already fetched it (not billed).
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

    constructor(
        private readonly db: SqlServerService,
        private readonly diagnostics: DiagnosticsManager
    ) {
        this.diagnostics.onDidChangeScanHints(() => this.onDidChangeEmitter.fire());
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CodeLens[]> {
        if (!this.db.getConfig().enabled) {
            return [];
        }
        const detectByKeyword = this.db.getConfig().detectByKeyword;
        const targets = isSqlDocument(document)
            ? sqlFileTargets(document)
            : pythonTargets(document, detectByKeyword);
        const showScan = this.db.getConfig().engine === 'bigquery';
        const lenses: vscode.CodeLens[] = [];
        for (const target of targets) {
            const range = codeLensRange(document, target.offset, target.end);
            const args = [{ uri: document.uri.toString(), offset: target.offset }];
            for (const action of LENS_ACTIONS) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: action.title,
                        tooltip: action.tooltip,
                        command: action.command,
                        arguments: args
                    })
                );
                if (showScan && action.command === Commands.runSelectedSql && action.title.includes('Run')) {
                    const sql = document.getText().slice(target.offset, target.end);
                    const bytes = this.diagnostics.scanBytesFor(document.uri, sql);
                    if (bytes !== undefined) {
                        lenses.push(
                            new vscode.CodeLens(range, {
                                title: formatScanBytes(bytes),
                                tooltip:
                                    'BigQuery dry-run estimate. This check is not billed. LIMIT does not reduce bytes scanned.',
                                command: Commands.explainSqlAt,
                                arguments: args
                            })
                        );
                    }
                }
            }
        }
        return lenses;
    }
}

function pythonTargets(
    document: vscode.TextDocument,
    detectByKeyword: boolean
): { offset: number; end: number }[] {
    return extractSqlBlocks(document, detectByKeyword)
        .filter((block) => block.text.trim().length > 0)
        .map((block) => ({ offset: block.docStart, end: block.docEnd }));
}

function sqlFileTargets(document: vscode.TextDocument): { offset: number; end: number }[] {
    return splitSqlStatements(document.getText()).map((slice) => ({
        offset: slice.start,
        end: slice.end
    }));
}
