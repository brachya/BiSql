import * as vscode from 'vscode';
import { ColumnInfo, SqlServerService, TableInfo } from '../db/connection';
import { hostEnabled } from '../db/hosts';
import { findSqlAtPosition, isBisqlDocument, isSqlDocument } from '../parser/sqlExtractor';
import { isCteTable } from '../sql/cteSchema';
import { findSqlFunction, functionMarkdown } from '../sql/functions';
import { SqlCompleter, SqlCompletionHit } from '../sql/completeSql';

interface ItemPayload {
    kind: 'table' | 'column' | 'function';
    table?: TableInfo;
    column?: ColumnInfo;
    functionName?: string;
}

const PAYLOAD = new WeakMap<vscode.CompletionItem, ItemPayload>();

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
    private readonly completer: SqlCompleter;

    constructor(private readonly db: SqlServerService) {
        this.completer = new SqlCompleter(db);
    }

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionList> {
        const config = this.db.getConfig();
        if (!config.enabled) {
            return undefined;
        }
        if (!isBisqlDocument(document) || !hostEnabled(config, document.languageId)) {
            return undefined;
        }

        const hit = findSqlAtPosition(document, position);
        if (!hit) {
            return undefined;
        }

        // Closing quote sits at the block end — findBlockAtPosition already missed it.
        if (
            !isSqlDocument(document) &&
            context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
            (context.triggerCharacter === "'" || context.triggerCharacter === '"')
        ) {
            const offset = document.offsetAt(position);
            if (offset <= hit.block.docStart || offset >= hit.block.docEnd) {
                return undefined;
            }
        }

        const result = isSqlDocument(document)
            ? this.completer.complete(hit.block.text, hit.sqlOffset, hit.block)
            : this.completer.complete(hit.block.text, hit.sqlOffset);
        if (!result) {
            return undefined;
        }
        const sqlStart = Math.max(0, hit.sqlOffset - result.replaceLength);
        const tokenRange = new vscode.Range(
            hit.block.sqlOffsetToDocPosition(sqlStart),
            position
        );
        const typed = hit.block.text.slice(sqlStart, hit.sqlOffset);
        const items = result.items.map((entry) => this.toVscodeItem(entry, tokenRange, typed));
        // Incomplete so Cursor asks again on each letter. A complete list is
        // filtered locally on leftover insertText and tables vanish.
        return new vscode.CompletionList(items, true);
    }

    public resolveCompletionItem(
        item: vscode.CompletionItem,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem> {
        const payload = PAYLOAD.get(item);
        if (!payload) {
            return item;
        }
        if (payload.kind === 'table' && payload.table) {
            item.documentation = tableMarkdown(payload.table);
        } else if (payload.kind === 'column' && payload.table && payload.column) {
            item.documentation = columnMarkdown(payload.table, payload.column);
        } else if (payload.kind === 'function' && payload.functionName) {
            const fn = findSqlFunction(payload.functionName, this.db.getConfig().engine);
            if (fn) {
                item.documentation = new vscode.MarkdownString(functionMarkdown(fn));
            }
        }
        return item;
    }

    private toVscodeItem(
        hit: SqlCompletionHit,
        tokenRange: vscode.Range,
        typed: string
    ): vscode.CompletionItem {
        const kind =
            hit.item.kind === 'column'
                ? vscode.CompletionItemKind.Field
                : hit.item.kind === 'function'
                  ? vscode.CompletionItemKind.Function
                  : hit.item.kind === 'keyword'
                    ? vscode.CompletionItemKind.Keyword
                    : hit.item.kind === 'alias'
                      ? vscode.CompletionItemKind.Variable
                      : hit.table?.isView
                        ? vscode.CompletionItemKind.Interface
                        : vscode.CompletionItemKind.Class;
        const label = hit.item.description
            ? { label: hit.item.label, description: hit.item.description }
            : hit.item.label;
        const item = new vscode.CompletionItem(label, kind);
        const raw =
            hit.snippet && /\$\d|\$\{/.test(hit.snippet)
                ? hit.snippet
                : hit.item.insertText;
        // Full text, not leftover. Cursor filters the popup on insertText.
        // Leftover `.roles_…` after typing `datalign_dev` hid every table.
        item.range = tokenRange;
        item.insertText = /\$\d|\$\{/.test(raw)
            ? new vscode.SnippetString(raw)
            : raw;
        item.detail = hit.item.detail;
        item.filterText = `${typed} ${raw} ${hit.item.filterText ?? hit.item.label}`;
        if (hit.item.sortText) {
            item.sortText = hit.item.sortText;
        }
        if (hit.table && hit.item.kind === 'table') {
            PAYLOAD.set(item, { kind: 'table', table: hit.table });
        } else if (hit.column && hit.table) {
            PAYLOAD.set(item, { kind: 'column', table: hit.table, column: hit.column });
        } else if (hit.functionName) {
            PAYLOAD.set(item, { kind: 'function', functionName: hit.functionName });
        }
        return item;
    }
}

function tableMarkdown(table: TableInfo): vscode.MarkdownString {
    const cte = isCteTable(table);
    const title = cte
        ? table.name
        : table.database.toLowerCase() === table.schema.toLowerCase()
          ? `${table.database}.${table.name}`
          : table.qualifiedName;
    const kind = cte ? '(CTE)' : table.isView ? '(view)' : '(table)';
    const lines = [
        `**${title}** ${kind}`,
        '',
        '| | Column | Type | Null |',
        '| --- | --- | --- | --- |'
    ];
    for (const column of table.columns) {
        const pk = column.isPrimaryKey ? 'PK' : '';
        lines.push(
            `| ${pk} | \`${column.name}\` | ${column.typeDisplay} | ${column.isNullable ? 'YES' : 'NO'} |`
        );
    }
    return new vscode.MarkdownString(lines.join('\n'));
}

function columnMarkdown(table: TableInfo, column: ColumnInfo): vscode.MarkdownString {
    const flags: string[] = [];
    if (column.isPrimaryKey) {
        flags.push('PRIMARY KEY');
    }
    if (column.isIdentity) {
        flags.push('IDENTITY');
    }
    if (column.isComputed) {
        flags.push('COMPUTED');
    }
    flags.push(column.isNullable ? 'NULL' : 'NOT NULL');
    return new vscode.MarkdownString(
        [
            `**${table.fullName}.${column.name}**`,
            '',
            `\`${column.typeDisplay}\``,
            '',
            flags.join(' · ')
        ].join('\n')
    );
}

/** Exported for hover docs reuse. */
export function buildTableHover(table: TableInfo): vscode.MarkdownString {
    return tableMarkdown(table);
}

export function buildColumnHover(table: TableInfo, column: ColumnInfo): vscode.MarkdownString {
    return columnMarkdown(table, column);
}
