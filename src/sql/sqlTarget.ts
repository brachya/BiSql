import * as vscode from 'vscode';
import {
    findBlockAtPosition,
    isBisqlDocument,
    isSqlDocument,
    SqlBlock,
    sqlStatementBlockAtDocOffset,
    tokenizeSql
} from '../parser/sqlExtractor';

export interface SqlLensArgs {
    uri: string;
    offset: number;
}

export interface SqlTarget {
    document: vscode.TextDocument;
    sql: string;
    range: vscode.Range;
    block: SqlBlock;
    isSqlFile: boolean;
}

export function isSqlLensArgs(value: unknown): value is SqlLensArgs {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.uri === 'string' && typeof record.offset === 'number';
}

/** CodeLens may pass `{ uri, offset }` or wrap it in an extra array. */
export function pickLensArgs(...args: unknown[]): SqlLensArgs | undefined {
    for (const arg of args) {
        if (isSqlLensArgs(arg)) {
            return arg;
        }
        if (Array.isArray(arg) && isSqlLensArgs(arg[0])) {
            return arg[0];
        }
    }
    return undefined;
}

export async function resolveSqlTargetFromArgs(
    args: SqlLensArgs
): Promise<SqlTarget | undefined> {
    const uri = vscode.Uri.parse(args.uri);
    const document = vscode.workspace.textDocuments.find(
        (entry) => entry.uri.toString() === uri.toString()
    );
    if (!document) {
        try {
            const opened = await vscode.workspace.openTextDocument(uri);
            return resolveSqlTargetAt(opened, args.offset);
        } catch {
            return undefined;
        }
    }
    return resolveSqlTargetAt(document, args.offset);
}

export function resolveSqlTargetFromEditor(
    editor: vscode.TextEditor
): SqlTarget | undefined {
    const document = editor.document;
    if (!editor.selection.isEmpty) {
        const sql = document.getText(editor.selection);
        if (sql.trim().length === 0) {
            return undefined;
        }
        return targetFromSelection(document, editor.selection, sql);
    }
    return resolveSqlTargetAt(document, document.offsetAt(editor.selection.active));
}

export function resolveSqlTargetAt(
    document: vscode.TextDocument,
    offset: number
): SqlTarget | undefined {
    if (isSqlDocument(document)) {
        const block = sqlStatementBlockAtDocOffset(document, offset);
        if (!block) {
            return undefined;
        }
        return {
            document,
            sql: block.originalText,
            range: new vscode.Range(
                document.positionAt(block.docStart),
                document.positionAt(block.docEnd)
            ),
            block,
            isSqlFile: true
        };
    }

    if (!isBisqlDocument(document)) {
        return undefined;
    }
    const hit = findBlockAtPosition(document, document.positionAt(offset));
    if (!hit || hit.block.originalText.trim().length === 0) {
        return undefined;
    }
    return {
        document,
        sql: hit.block.originalText,
        range: hit.block.toDocRange(0, hit.block.text.length),
        block: hit.block,
        isSqlFile: false
    };
}

function targetFromSelection(
    document: vscode.TextDocument,
    selection: vscode.Selection,
    sql: string
): SqlTarget {
    if (isSqlDocument(document)) {
        const start = document.offsetAt(selection.start);
        const end = document.offsetAt(selection.end);
        return {
            document,
            sql,
            range: new vscode.Range(selection.start, selection.end),
            block: SqlBlock.fromDocumentSlice(document.getText(), start, end),
            isSqlFile: true
        };
    }
    const hit = findBlockAtPosition(document, selection.start);
    return {
        document,
        sql,
        range: new vscode.Range(selection.start, selection.end),
        block: hit?.block ?? SqlBlock.fromText(sql),
        isSqlFile: false
    };
}

/**
 * First real SQL line in a range — where CodeLens sits.
 * Leading blank lines and comments stay in the statement, but the buttons
 * belong on the query (`SELECT …`), not on `-- commented-out SQL` above it.
 */
export function codeLensRange(document: vscode.TextDocument, startOffset: number, endOffset: number): vscode.Range {
    const text = document.getText();
    const from = Math.max(0, startOffset);
    const to = Math.min(endOffset, text.length);
    const tokens = tokenizeSql(text.slice(from, to));
    const i = tokens.length > 0 ? from + tokens[0].start : skipWhitespace(text, from, to);
    const position = document.positionAt(Math.min(i, to));
    return new vscode.Range(position.line, 0, position.line, 0);
}

function skipWhitespace(text: string, start: number, end: number): number {
    let i = start;
    while (i < end && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) {
        i += 1;
    }
    return i;
}
