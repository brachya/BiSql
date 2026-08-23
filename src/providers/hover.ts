import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import {
    collectTableRefs,
    findBlockAtPosition,
    identifierAt
} from '../parser/sqlExtractor';
import { findSqlFunction, functionMarkdown } from '../sql/functions';
import { buildColumnHover, buildTableHover } from './completion';

export class SqlHoverProvider implements vscode.HoverProvider {
    constructor(private readonly db: SqlServerService) {}

    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const config = this.db.getConfig();
        if (!config.enabled || document.languageId !== 'python') {
            return undefined;
        }

        const hit = findBlockAtPosition(document, position, config.detectByKeyword);
        if (!hit) {
            return undefined;
        }

        const schema = this.db.schema;
        if (schema.isEmpty) {
            return undefined;
        }

        const prefs = config.tableDatabasePreferences;
        const defaultDb = config.database;
        const find = (reference: string) => schema.findTable(reference, prefs, defaultDb);

        const { block, sqlOffset } = hit;
        const ident = identifierAt(block.text, sqlOffset);
        if (!ident) {
            return undefined;
        }

        const range = block.toDocRange(ident.start, ident.end);
        const { aliasToTable } = collectTableRefs(block.text);

        // Multi-part: alias.column or schema.table or schema.table.column
        if (ident.parts.length >= 2) {
            const last = ident.parts[ident.parts.length - 1];
            const head = ident.parts.slice(0, -1).join('.');

            // Try as alias.column / table.column first.
            const tableName = aliasToTable.get(head.toLowerCase()) ?? head;
            const table = find(tableName) ?? find(head);
            if (table) {
                const column = table.columnsByLower.get(last.toLowerCase());
                if (column) {
                    return new vscode.Hover(buildColumnHover(table, column), range);
                }
                // Maybe the whole thing is schema.table (no column).
            }

            const asTable = find(ident.value);
            if (asTable) {
                return new vscode.Hover(buildTableHover(asTable), range);
            }
        }

        // Single identifier: alias, table, column, or function.
        const name = ident.parts[0];

        const aliasTableName = aliasToTable.get(name.toLowerCase());
        if (aliasTableName) {
            const table = find(aliasTableName);
            if (table) {
                return new vscode.Hover(buildTableHover(table), range);
            }
        }

        const table = find(name);
        if (table) {
            return new vscode.Hover(buildTableHover(table), range);
        }

        // Column across referenced tables.
        const { refs } = collectTableRefs(block.text);
        for (const ref of refs) {
            const refTable = find(ref.table);
            if (!refTable) {
                continue;
            }
            const column = refTable.columnsByLower.get(name.toLowerCase());
            if (column) {
                return new vscode.Hover(buildColumnHover(refTable, column), range);
            }
        }

        const fn = findSqlFunction(name, config.engine);
        if (fn) {
            const md = new vscode.MarkdownString(
                `**${fn.name}** _(SQL function)_\n\n${functionMarkdown(fn)}`
            );
            return new vscode.Hover(md, range);
        }

        return undefined;
    }
}
