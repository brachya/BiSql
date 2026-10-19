import { ColumnInfo, TableInfo } from '../db/schemaTypes';

export interface TableRelation {
    fromTable: string;
    fromColumns: string[];
    toTable: string;
    toColumns: string[];
    guessed: boolean;
    toCached: boolean;
}

export interface TableRelationBundle {
    outgoing: TableRelation[];
    incoming: TableRelation[];
}

// ponytail: naming-only guesses inside one database; upgrade path is JOIN history, not more heuristics.
const GUESS_SUFFIX = '_id';

function primaryKeyColumns(table: TableInfo): ColumnInfo[] {
    return table.columns.filter((column) => column.isPrimaryKey);
}

function declaredForeignColumns(table: TableInfo): Set<string> {
    const columns = new Set<string>();
    for (const fk of table.foreignKeys) {
        for (const name of fk.columns) {
            columns.add(name.toLowerCase());
        }
    }
    return columns;
}

function sameType(left: ColumnInfo, right: ColumnInfo): boolean {
    return left.typeName.toLowerCase() === right.typeName.toLowerCase();
}

function stemFromIdColumn(columnName: string): string | undefined {
    const lower = columnName.toLowerCase();
    if (!lower.endsWith(GUESS_SUFFIX) || lower.length <= GUESS_SUFFIX.length) {
        return undefined;
    }
    return lower.slice(0, -GUESS_SUFFIX.length);
}

function tableNameCandidates(stem: string): string[] {
    const names = new Set<string>();
    names.add(stem);
    if (stem.endsWith('y') && stem.length > 1) {
        names.add(`${stem.slice(0, -1)}ies`);
    }
    names.add(`${stem}s`);
    names.add(`${stem}es`);
    return [...names];
}

function resolveRefColumn(target: TableInfo, sourceColumn: ColumnInfo): ColumnInfo | undefined {
    const sameName = target.columnsByLower.get(sourceColumn.name.toLowerCase());
    if (sameName) {
        return sameName;
    }
    const pks = primaryKeyColumns(target);
    if (pks.length === 1) {
        return pks[0];
    }
    return undefined;
}

function relationKey(relation: TableRelation): string {
    return [
        relation.fromTable.toLowerCase(),
        relation.fromColumns.join(',').toLowerCase(),
        relation.toTable.toLowerCase(),
        relation.toColumns.join(',').toLowerCase(),
        relation.guessed ? 'g' : 'd'
    ].join('|');
}

function pushUnique(bucket: TableRelation[], relation: TableRelation): void {
    const key = relationKey(relation);
    if (bucket.some((item) => relationKey(item) === key)) {
        return;
    }
    bucket.push(relation);
}

function tableWords(tableName: string): string[] {
    return tableName
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/**
 * Structural ownership score when multiple tables share the same single-column PK `<stem>_id`
 * (e.g. an entity table vs a 1:1 child/projection table that reuses the entity key as its PK).
 */
function scorePkOwner(table: TableInfo, pkCol: ColumnInfo, stem: string): number {
    let score = 0;
    if (pkCol.isIdentity) {
        score += 4;
    }
    const candidates = new Set(tableNameCandidates(stem));
    const words = tableWords(table.name);
    if (words.some((word) => candidates.has(word))) {
        score += 3;
    }
    const initials = words.length > 1 ? words.map((word) => word[0]).join('') : '';
    if (initials && initials === stem) {
        score += 3;
    }
    const prefix = `${stem}_`;
    const pkLower = pkCol.name.toLowerCase();
    const hasSibling = table.columns.some((col) => {
        const lower = col.name.toLowerCase();
        return lower !== pkLower && lower.startsWith(prefix);
    });
    if (hasSibling) {
        score += 2;
    }
    if (pkCol.ordinal > 0 && pkCol.ordinal <= 2) {
        score += 1;
    }
    return score;
}

function pickCanonicalPkOwner(
    candidates: TableInfo[],
    sourceColumn: ColumnInfo,
    stem: string | undefined
): TableInfo | undefined {
    const typed = candidates.filter((item) => {
        const refCol = primaryKeyColumns(item)[0];
        return refCol !== undefined && sameType(sourceColumn, refCol);
    });
    if (typed.length === 1) {
        return typed[0];
    }
    if (typed.length === 0 || !stem) {
        return undefined;
    }
    let best: TableInfo | undefined;
    let bestScore = -1;
    let tied = false;
    for (const candidate of typed) {
        const pkCol = primaryKeyColumns(candidate)[0]!;
        const score = scorePkOwner(candidate, pkCol, stem);
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
            tied = false;
        } else if (score === bestScore) {
            tied = true;
        }
    }
    if (!best || tied || bestScore <= 0) {
        return undefined;
    }
    return best;
}

function guessRelation(
    table: TableInfo,
    column: ColumnInfo,
    tablesByDbAndName: Map<string, TableInfo[]>,
    pkOwnerByDbAndColumn: Map<string, TableInfo[]>,
    tablesByQualified: Map<string, TableInfo>
): TableRelation | undefined {
    const db = table.database.toLowerCase();
    const pks = primaryKeyColumns(table);
    const isSolePkOnThisTable =
        pks.length === 1 && pks[0]!.name.toLowerCase() === column.name.toLowerCase();
    const stem = stemFromIdColumn(column.name);

    if (!isSolePkOnThisTable && stem) {
        const candidates: TableInfo[] = [];
        for (const name of tableNameCandidates(stem)) {
            const matches = tablesByDbAndName.get(`${db}|${name}`) ?? [];
            candidates.push(
                ...matches.filter(
                    (item) =>
                        !item.isView &&
                        item.qualifiedName.toLowerCase() !== table.qualifiedName.toLowerCase()
                )
            );
        }
        const unique = [...new Map(candidates.map((item) => [item.qualifiedName.toLowerCase(), item])).values()];
        if (unique.length === 1) {
            const target = unique[0]!;
            const refColumn = resolveRefColumn(target, column);
            if (refColumn && sameType(column, refColumn)) {
                return {
                    fromTable: table.qualifiedName,
                    fromColumns: [column.name],
                    toTable: target.qualifiedName,
                    toColumns: [refColumn.name],
                    guessed: true,
                    toCached: tablesByQualified.has(target.qualifiedName.toLowerCase())
                };
            }
        }
    }

    const allPkOwners = (pkOwnerByDbAndColumn.get(`${db}|${column.name.toLowerCase()}`) ?? []).filter(
        (item) => !item.isView
    );
    if (isSolePkOnThisTable) {
        if (!stem || allPkOwners.length <= 1) {
            return undefined;
        }
        const canonical = pickCanonicalPkOwner(allPkOwners, column, stem);
        if (!canonical || canonical.qualifiedName.toLowerCase() === table.qualifiedName.toLowerCase()) {
            return undefined;
        }
        const refColumn = primaryKeyColumns(canonical)[0]!;
        return {
            fromTable: table.qualifiedName,
            fromColumns: [column.name],
            toTable: canonical.qualifiedName,
            toColumns: [refColumn.name],
            guessed: true,
            toCached: tablesByQualified.has(canonical.qualifiedName.toLowerCase())
        };
    }

    const otherPkOwners = allPkOwners.filter(
        (item) => item.qualifiedName.toLowerCase() !== table.qualifiedName.toLowerCase()
    );
    const target = pickCanonicalPkOwner(otherPkOwners, column, stem);
    if (target) {
        const refColumn = primaryKeyColumns(target)[0];
        if (refColumn && sameType(column, refColumn)) {
            return {
                fromTable: table.qualifiedName,
                fromColumns: [column.name],
                toTable: target.qualifiedName,
                toColumns: [refColumn.name],
                guessed: true,
                toCached: tablesByQualified.has(target.qualifiedName.toLowerCase())
            };
        }
    }

    return undefined;
}

export function buildTableRelations(tables: TableInfo[]): Map<string, TableRelationBundle> {
    const tablesByQualified = new Map<string, TableInfo>();
    const tablesByDbAndName = new Map<string, TableInfo[]>();
    const pkOwnerByDbAndColumn = new Map<string, TableInfo[]>();
    const bundles = new Map<string, TableRelationBundle>();

    for (const table of tables) {
        tablesByQualified.set(table.qualifiedName.toLowerCase(), table);
        bundles.set(table.qualifiedName.toLowerCase(), { outgoing: [], incoming: [] });
        const dbNameKey = `${table.database.toLowerCase()}|${table.name.toLowerCase()}`;
        const nameBucket = tablesByDbAndName.get(dbNameKey);
        if (nameBucket) {
            nameBucket.push(table);
        } else {
            tablesByDbAndName.set(dbNameKey, [table]);
        }
        if (!table.isView) {
            const pks = primaryKeyColumns(table);
            if (pks.length === 1) {
                const pkKey = `${table.database.toLowerCase()}|${pks[0]!.name.toLowerCase()}`;
                const pkBucket = pkOwnerByDbAndColumn.get(pkKey);
                if (pkBucket) {
                    pkBucket.push(table);
                } else {
                    pkOwnerByDbAndColumn.set(pkKey, [table]);
                }
            }
        }
    }

    for (const table of tables) {
        const outgoing: TableRelation[] = [];
        for (const fk of table.foreignKeys) {
            pushUnique(outgoing, {
                fromTable: table.qualifiedName,
                fromColumns: [...fk.columns],
                toTable: fk.refTable,
                toColumns: [...fk.refColumns],
                guessed: false,
                toCached: tablesByQualified.has(fk.refTable.toLowerCase())
            });
        }
        if (!table.isView) {
            const declared = declaredForeignColumns(table);
            for (const column of table.columns) {
                if (declared.has(column.name.toLowerCase())) {
                    continue;
                }
                const guess = guessRelation(
                    table,
                    column,
                    tablesByDbAndName,
                    pkOwnerByDbAndColumn,
                    tablesByQualified
                );
                if (guess) {
                    pushUnique(outgoing, guess);
                }
            }
        }
        const bundle = bundles.get(table.qualifiedName.toLowerCase())!;
        bundle.outgoing = outgoing;
    }

    for (const bundle of bundles.values()) {
        for (const relation of bundle.outgoing) {
            const target = bundles.get(relation.toTable.toLowerCase());
            if (target) {
                pushUnique(target.incoming, relation);
            }
        }
    }

    return bundles;
}

/** Outgoing relations that touch a column (for column badges). */
export function relationsForColumn(
    columnName: string,
    bundle: TableRelationBundle | undefined
): TableRelation[] {
    if (!bundle) {
        return [];
    }
    const key = columnName.toLowerCase();
    return bundle.outgoing.filter((relation) =>
        relation.fromColumns.some((name) => name.toLowerCase() === key)
    );
}

export function isSelfRelation(relation: TableRelation): boolean {
    return relation.fromTable.toLowerCase() === relation.toTable.toLowerCase();
}

/** Tables that have at least one incoming or outgoing link. */
export function compactRelationMap(
    bundles: Map<string, TableRelationBundle>
): Record<string, TableRelationBundle> {
    const out: Record<string, TableRelationBundle> = {};
    for (const [key, bundle] of bundles) {
        if (bundle.outgoing.length === 0 && bundle.incoming.length === 0) {
            continue;
        }
        out[key] = bundle;
    }
    return out;
}
