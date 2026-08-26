import * as vscode from 'vscode';
import {
    findBlockAtPosition,
    isSqlDocument,
    SqlBlock,
    statementAtOffset
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
    args: SqlLensArgs,
    detectByKeyword: boolean
): Promise<SqlTarget | undefined> {
    const uri = vscode.Uri.parse(args.uri);
    const document = vscode.workspace.textDocuments.find(
        (entry) => entry.uri.toString() === uri.toString()
    );
    if (!document) {
        try {
            const opened = await vscode.workspace.openTextDocument(uri);
            return resolveSqlTargetAt(opened, args.offset, detectByKeyword);
        } catch {
            return undefined;
        }
    }
    return resolveSqlTargetAt(document, args.offset, detectByKeyword);
}

export function resolveSqlTargetFromEditor(
    editor: vscode.TextEditor,
    detectByKeyword: boolean
): SqlTarget | undefined {
    const document = editor.document;
    if (!editor.selection.isEmpty) {
        const sql = document.getText(editor.selection);
        if (sql.trim().length === 0) {
            return undefined;
        }
        return targetFromSelection(document, editor.selection, sql, detectByKeyword);
    }
    return resolveSqlTargetAt(
        document,
        document.offsetAt(editor.selection.active),
        detectByKeyword
    );
}

export function resolveSqlTargetAt(
    document: vscode.TextDocument,
    offset: number,
    detectByKeyword: boolean
): SqlTarget | undefined {
    if (isSqlDocument(document)) {
        const source = document.getText();
        const slice = statementAtOffset(source, offset);
        if (!slice || slice.text.trim().length === 0) {
            return undefined;
        }
        return {
            document,
            sql: slice.text,
            range: new vscode.Range(
                document.positionAt(slice.start),
                document.positionAt(slice.end)
            ),
            block: SqlBlock.fromDocumentSlice(source, slice.start, slice.end),
            isSqlFile: true
        };
    }

    if (document.languageId !== 'python') {
        return undefined;
    }
    const hit = findBlockAtPosition(
        document,
        document.positionAt(offset),
        detectByKeyword
    );
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
    sql: string,
    detectByKeyword: boolean
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
    const hit = findBlockAtPosition(document, selection.start, detectByKeyword);
    return {
        document,
        sql,
        range: new vscode.Range(selection.start, selection.end),
        block: hit?.block ?? SqlBlock.fromText(sql),
        isSqlFile: false
    };
}

/** First non-empty line of a document range — where CodeLens sits. */
export function codeLensRange(document: vscode.TextDocument, startOffset: number, endOffset: number): vscode.Range {
    const text = document.getText();
    let i = Math.max(0, startOffset);
    const end = Math.min(endOffset, text.length);
    while (i < end && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) {
        i += 1;
    }
    const position = document.positionAt(Math.min(i, end));
    return new vscode.Range(position.line, 0, position.line, 0);
}
