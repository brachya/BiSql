import * as vscode from 'vscode';
import { SqlServerService, tableLookupDefaults } from '../db/connection';
import { findSqlAtPosition, identifierAt, isSqlDocument, SqlAnalysis } from '../parser/sqlExtractor';
import { findSqlFunction, functionMarkdown } from '../sql/functions';
import { findRelation, resolveCteTables } from '../sql/cteSchema';
import {
    systemCatalogColumnHoverMarkdown,
    systemCatalogHoverMarkdown
} from '../sql/systemCatalogs';
import { buildColumnHover, buildTableHover } from './completion';

export class SqlHoverProvider implements vscode.HoverProvider {
    constructor(private readonly db: SqlServerService) {}

    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const config = this.db.getConfig();
        if (!config.enabled) {
            return undefined;
        }
        if (document.languageId !== 'python' && !isSqlDocument(document)) {
            return undefined;
        }

        const hit = findSqlAtPosition(document, position, config.detectByKeyword);
        if (!hit) {
            return undefined;
        }

        const { block, sqlOffset } = hit;
        const analysis = block.analyze();
        const ident = identifierAt(block.text, sqlOffset, analysis.tokens);
        if (!ident) {
            return undefined;
        }

        const range = block.toDocRange(ident.start, ident.end);
        const schema = this.db.schema;

        if (!schema.isEmpty) {
            const defaults = tableLookupDefaults(config);
            const findTable = (reference: string) =>
                schema.findTable(reference, defaults.database, defaults.schema);
            const ctes = resolveCteTables(analysis.tokens, findTable);
            const find = (reference: string) => findRelation(reference, findTable, ctes);
            const { aliasToTable, refs } = analysis;

            if (ident.parts.length >= 2) {
                const last = ident.parts[ident.parts.length - 1];
                const head = ident.parts.slice(0, -1).join('.');

                const tableName = aliasToTable.get(head.toLowerCase()) ?? head;
                const table = find(tableName) ?? find(head);
                if (table) {
                    const column = table.columnsByLower.get(last.toLowerCase());
                    if (column) {
                        return new vscode.Hover(buildColumnHover(table, column), range);
                    }
                }

                const asTable = find(ident.value);
                if (asTable) {
                    return new vscode.Hover(buildTableHover(asTable), range);
                }
            }

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
        }

        const systemMd = systemCatalogHoverFromIdent(ident, analysis, config.engine);
        if (systemMd) {
            return new vscode.Hover(new vscode.MarkdownString(systemMd), range);
        }

        return undefined;
    }
}

function systemCatalogHoverFromIdent(
    ident: { value: string; parts: string[] },
    analysis: SqlAnalysis,
    engine: string
): string | undefined {
    const { aliasToTable, refs } = analysis;
    if (ident.parts.length >= 2) {
        const last = ident.parts[ident.parts.length - 1];
        const head = ident.parts.slice(0, -1).join('.');
        const tableRef = aliasToTable.get(head.toLowerCase()) ?? head;
        const columnMd = systemCatalogColumnHoverMarkdown(tableRef, last, engine);
        if (columnMd) {
            return columnMd;
        }
        const tableMd =
            systemCatalogHoverMarkdown(ident.value, engine) ??
            systemCatalogHoverMarkdown(tableRef, engine);
        if (tableMd) {
            return tableMd;
        }
    }

    const name = ident.parts[0];
    const aliasRef = aliasToTable.get(name.toLowerCase());
    if (aliasRef) {
        const aliasMd = systemCatalogHoverMarkdown(aliasRef, engine);
        if (aliasMd) {
            return aliasMd;
        }
    }

    for (const ref of refs) {
        const columnMd = systemCatalogColumnHoverMarkdown(ref.table, name, engine);
        if (columnMd) {
            return columnMd;
        }
    }
    return undefined;
}
