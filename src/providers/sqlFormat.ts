import * as vscode from 'vscode';
import { ExtensionConfig, SqlServerService } from '../db/connection';
import {
    extractSqlStringLiterals,
    PythonStringLiteral
} from '../parser/sqlExtractor';
import {
    dialectForEngine,
    formatEmbeddedSql
} from '../sql/formatEmbeddedSql';

export interface FormatScanResult {
    edits: vscode.TextEdit[];
    formatted: number;
    unchanged: number;
    skippedConcat: number;
    failures: string[];
}

export class SqlRangeFormatProvider implements vscode.DocumentRangeFormattingEditProvider {
    constructor(private readonly db: SqlServerService) {}

    public provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range
    ): vscode.TextEdit[] {
        if (document.languageId !== 'python') {
            return [];
        }
        const config = this.db.getConfig();
        if (!config.enabled) {
            return [];
        }
        const empty = range.start.isEqual(range.end);
        return collectSqlFormatEdits(
            document,
            config,
            empty ? { position: range.start } : { range }
        ).edits;
    }
}

export function collectSqlFormatEdits(
    document: vscode.TextDocument,
    config: ExtensionConfig,
    filter?: { range?: vscode.Range; position?: vscode.Position }
): FormatScanResult {
    const groups = extractSqlStringLiterals(document, config.detectByKeyword);
    const result: FormatScanResult = {
        edits: [],
        formatted: 0,
        unchanged: 0,
        skippedConcat: 0,
        failures: []
    };

    for (const group of groups) {
        if (!groupOverlapsFilter(document, group, filter)) {
            continue;
        }
        if (group.length !== 1) {
            result.skippedConcat += 1;
            continue;
        }
        const literal = group[0];
        const formatted = formatEmbeddedSql(literal.content, {
            dialect: dialectForEngine(config.engine),
            keywordCase: config.formatKeywordCase,
            tabWidth: config.formatTabWidth,
            isFString: literal.isFString,
            isTripleQuoted: literal.quote.length === 3
        });
        if (!formatted.ok) {
            result.failures.push(formatted.error);
            continue;
        }
        if (formatted.text === literal.content) {
            result.unchanged += 1;
            continue;
        }
        const range = new vscode.Range(
            document.positionAt(literal.contentStart),
            document.positionAt(literal.contentEnd)
        );
        result.edits.push(vscode.TextEdit.replace(range, formatted.text));
        result.formatted += 1;
    }

    return result;
}

function groupOverlapsFilter(
    document: vscode.TextDocument,
    group: PythonStringLiteral[],
    filter?: { range?: vscode.Range; position?: vscode.Position }
): boolean {
    if (!filter || (!filter.range && !filter.position)) {
        return true;
    }
    const start = group[0].quoteStart;
    const end = group[group.length - 1].quoteEnd;
    const full = new vscode.Range(document.positionAt(start), document.positionAt(end));
    if (filter.range && full.intersection(filter.range)) {
        return true;
    }
    if (filter.position && full.contains(filter.position)) {
        return true;
    }
    return false;
}
