import * as vscode from 'vscode';
import { ExtensionConfig, SqlServerService } from '../db/connection';
import { hostEnabled } from '../db/hosts';
import {
    extractJsSqlStringLiterals,
    extractSqlStringLiterals,
    isBisqlDocument,
    isJavascriptHostLanguage,
    isSqlDocument,
    PythonStringLiteral
} from '../parser/sqlExtractor';
import { JsStringLiteral } from '../parser/jsBlocks';
import {
    anchorIndentFromLinePrefix,
    dialectForEngine,
    formatEmbeddedSql,
    formatStyleOf
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
        const config = this.db.getConfig();
        if (
            !config.enabled ||
            !isBisqlDocument(document) ||
            !hostEnabled(config, document.languageId)
        ) {
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
    if (isSqlDocument(document)) {
        return collectPlainSqlFormatEdits(document, config, filter);
    }
    const groups = isJavascriptHostLanguage(document.languageId)
        ? extractJsSqlStringLiterals(document)
        : extractSqlStringLiterals(document);
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
        const jsLiteral = literal as JsStringLiteral;
        const isTemplate = 'isTemplate' in jsLiteral && jsLiteral.isTemplate === true;
        const formatted = formatEmbeddedSql(literal.content, {
            dialect: dialectForEngine(config.engine),
            ...formatStyleOf(config),
            isFString: 'isFString' in literal ? literal.isFString : false,
            isTemplate,
            isTripleQuoted: literal.quote.length === 3,
            anchorIndent: anchorIndentForContent(
                document,
                literal.contentStart,
                literal.content,
                config.formatTabWidth
            )
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

function collectPlainSqlFormatEdits(
    document: vscode.TextDocument,
    config: ExtensionConfig,
    filter?: { range?: vscode.Range; position?: vscode.Position }
): FormatScanResult {
    const result: FormatScanResult = {
        edits: [],
        formatted: 0,
        unchanged: 0,
        skippedConcat: 0,
        failures: []
    };
    const full = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );
    const range = filter?.range ?? full;
    const content = document.getText(range);
    if (content.trim().length === 0) {
        return result;
    }
    const formatted = formatEmbeddedSql(content, {
        dialect: dialectForEngine(config.engine),
        ...formatStyleOf(config),
        isFString: false,
        isTripleQuoted: true,
        anchorIndent: anchorIndentForContent(
            document,
            document.offsetAt(range.start),
            content,
            config.formatTabWidth
        )
    });
    if (!formatted.ok) {
        result.failures.push(formatted.error);
        return result;
    }
    if (formatted.text === content) {
        result.unchanged += 1;
        return result;
    }
    result.edits.push(vscode.TextEdit.replace(range, formatted.text));
    result.formatted += 1;
    return result;
}

function anchorIndentForContent(
    document: vscode.TextDocument,
    contentStart: number,
    content: string,
    tabWidth: number
): string {
    const skip = content.search(/\S/);
    const offset = skip < 0 ? contentStart : contentStart + skip;
    const pos = document.positionAt(offset);
    const prefix = document.lineAt(pos.line).text.slice(0, pos.character);
    return anchorIndentFromLinePrefix(prefix, tabWidth);
}

function groupOverlapsFilter(
    document: vscode.TextDocument,
    group: Array<PythonStringLiteral | JsStringLiteral>,
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
