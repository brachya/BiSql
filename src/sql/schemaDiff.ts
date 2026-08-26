export interface DiffableColumn {
    name: string;
    typeDisplay: string;
    isNullable: boolean;
    isIdentity: boolean;
    isComputed: boolean;
    isPrimaryKey: boolean;
}

export interface DiffableTable {
    database: string;
    schema: string;
    name: string;
    isView: boolean;
    columns: DiffableColumn[];
}

export type DiffStatus = 'identical' | 'changed' | 'leftOnly' | 'rightOnly';

/** How deep a difference goes. Lower is bigger (missing table), higher is finer (length). */
export type ChangeLevel = 'table' | 'column' | 'type' | 'size' | 'flags' | 'none';

export interface ColumnDiff {
    name: string;
    status: DiffStatus;
    left?: DiffableColumn;
    right?: DiffableColumn;
    changes: string[];
    changeLevel: ChangeLevel;
}

export interface TableDiff {
    key: string;
    displayName: string;
    status: DiffStatus;
    left?: { isView: boolean; columnCount: number };
    right?: { isView: boolean; columnCount: number };
    kindChanged: boolean;
    changeLevel: ChangeLevel;
    columns: ColumnDiff[];
}

export interface SchemaDiff {
    left: string;
    right: string;
    identical: number;
    changed: number;
    leftOnly: number;
    rightOnly: number;
    tables: TableDiff[];
}

export function tableMatchKey(table: DiffableTable, engine: string): string {
    if (engine === 'mysql') {
        return table.name.toLowerCase();
    }
    return `${table.schema}.${table.name}`.toLowerCase();
}

export function tableDisplayName(table: DiffableTable, engine: string): string {
    return engine === 'mysql' ? table.name : `${table.schema}.${table.name}`;
}

/**
 * Compare tables and columns in two databases from the schema cache.
 * Matching is by table name (MySQL) or schema.table (SQL Server / PostgreSQL).
 */
export function compareDatabases(
    tables: DiffableTable[],
    leftDb: string,
    rightDb: string,
    engine: string
): SchemaDiff {
    const leftName = leftDb.trim();
    const rightName = rightDb.trim();
    const leftKey = leftName.toLowerCase();
    const rightKey = rightName.toLowerCase();
    const leftMap = indexByMatchKey(tables, leftKey, engine);
    const rightMap = indexByMatchKey(tables, rightKey, engine);
    const keys = new Set([...leftMap.keys(), ...rightMap.keys()]);
    const diffs: TableDiff[] = [];

    for (const key of [...keys].sort()) {
        const left = leftMap.get(key);
        const right = rightMap.get(key);
        if (left && !right) {
            diffs.push(oneSidedDiff(left, engine, 'leftOnly'));
            continue;
        }
        if (right && !left) {
            diffs.push(oneSidedDiff(right, engine, 'rightOnly'));
            continue;
        }
        diffs.push(bothSidesDiff(left!, right!, engine));
    }

    return {
        left: leftName,
        right: rightName,
        identical: diffs.filter((item) => item.status === 'identical').length,
        changed: diffs.filter((item) => item.status === 'changed').length,
        leftOnly: diffs.filter((item) => item.status === 'leftOnly').length,
        rightOnly: diffs.filter((item) => item.status === 'rightOnly').length,
        tables: diffs
    };
}

export type DiffFilter = 'all' | 'diff' | 'changed' | 'left' | 'right' | 'identical';

export interface SchemaDiffReportOptions {
    filter?: DiffFilter;
    query?: string;
    depth?: ChangeLevel;
}

const CHANGE_LEVEL_RANK: Record<ChangeLevel, number> = {
    table: 1,
    column: 2,
    type: 3,
    size: 4,
    flags: 4,
    none: 9
};

export function parseTypeDisplay(typeDisplay: string): { base: string; args: string } {
    const raw = (typeDisplay || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const match = /^([a-z][a-z0-9]*)(?:\s*)(?:\((.*)\))?(.*)$/i.exec(raw);
    if (!match) {
        return { base: raw, args: '' };
    }
    const inner = (match[2] || '').trim();
    const suffix = (match[3] || '').trim();
    return {
        base: match[1].toLowerCase(),
        args: [inner, suffix]
            .filter((part) => part.length > 0)
            .join(' ')
            .replace(/\s*,\s*/g, ',')
            .replace(/\s+/g, ' ')
            .trim()
    };
}

export function changeLevelRank(level: ChangeLevel): number {
    return CHANGE_LEVEL_RANK[level] ?? 9;
}

export function isChangeVisible(level: ChangeLevel, depth: ChangeLevel): boolean {
    return changeLevelRank(level) <= changeLevelRank(depth);
}

export function strongerChangeLevel(left: ChangeLevel, right: ChangeLevel): ChangeLevel {
    const leftRank = changeLevelRank(left);
    const rightRank = changeLevelRank(right);
    if (leftRank < rightRank) {
        return left;
    }
    if (rightRank < leftRank) {
        return right;
    }
    if (left === 'size' || right === 'size') {
        return 'size';
    }
    return left;
}

export function effectiveTableStatus(table: TableDiff, depth: ChangeLevel): DiffStatus {
    if (
        table.status === 'leftOnly' ||
        table.status === 'rightOnly' ||
        table.status === 'identical'
    ) {
        return table.status;
    }
    return isChangeVisible(table.changeLevel, depth) ? 'changed' : 'identical';
}

export function parseChangeLevel(value: string | undefined): ChangeLevel {
    if (
        value === 'table' ||
        value === 'column' ||
        value === 'type' ||
        value === 'size' ||
        value === 'flags' ||
        value === 'none'
    ) {
        return value;
    }
    return 'size';
}

export function parseDiffFilter(value: string | undefined): DiffFilter {
    if (
        value === 'all' ||
        value === 'diff' ||
        value === 'changed' ||
        value === 'left' ||
        value === 'right' ||
        value === 'identical'
    ) {
        return value;
    }
    return 'diff';
}

/** Same rules as the Cached Schema compare list. */
export function tableDiffMatches(
    table: TableDiff,
    filter: DiffFilter = 'diff',
    query = '',
    depth: ChangeLevel = 'size'
): boolean {
    const status = effectiveTableStatus(table, depth);
    if (filter === 'diff' && status === 'identical') {
        return false;
    }
    if (filter === 'changed' && status !== 'changed') {
        return false;
    }
    if (filter === 'left' && status !== 'leftOnly') {
        return false;
    }
    if (filter === 'right' && status !== 'rightOnly') {
        return false;
    }
    if (filter === 'identical' && status !== 'identical') {
        return false;
    }
    const needle = query.trim().toLowerCase();
    if (!needle) {
        return true;
    }
    if (table.displayName.toLowerCase().includes(needle)) {
        return true;
    }
    return table.columns.some((column) => column.name.toLowerCase().includes(needle));
}

export function formatSchemaDiffReport(
    diff: SchemaDiff,
    options: SchemaDiffReportOptions = {}
): string {
    const filter = options.filter ?? 'diff';
    const query = options.query ?? '';
    const depth = options.depth ?? 'size';
    const tables = diff.tables.filter((table) => tableDiffMatches(table, filter, query, depth));
    let identical = 0;
    let changed = 0;
    let leftOnly = 0;
    let rightOnly = 0;
    for (const table of tables) {
        const status = effectiveTableStatus(table, depth);
        if (status === 'identical') {
            identical += 1;
        } else if (status === 'changed') {
            changed += 1;
        } else if (status === 'leftOnly') {
            leftOnly += 1;
        } else {
            rightOnly += 1;
        }
    }
    const lines = [`Schema compare`, `${diff.left}  →  ${diff.right}`];
    const queryText = query.trim();
    if (filter !== 'diff' || queryText || depth !== 'size') {
        lines.push('');
        if (filter !== 'diff') {
            lines.push(`Filter: ${diffFilterLabel(filter)}`);
        }
        if (depth !== 'size') {
            lines.push(`Depth: ${changeDepthLabel(depth)}`);
        }
        if (queryText) {
            lines.push(`Search: ${queryText}`);
        }
    }
    lines.push(
        '',
        `${identical} identical`,
        `${changed} different`,
        `${leftOnly} only in ${diff.left}`,
        `${rightOnly} only in ${diff.right}`,
        ''
    );
    for (const table of tables) {
        const status = effectiveTableStatus(table, depth);
        if (status === 'identical') {
            lines.push(`= ${table.displayName}  (identical)`);
            continue;
        }
        if (status === 'leftOnly') {
            lines.push(`- ${table.displayName}  (only ${diff.left})`);
            continue;
        }
        if (status === 'rightOnly') {
            lines.push(`+ ${table.displayName}  (only ${diff.right})`);
            continue;
        }
        lines.push(`~ ${table.displayName}  (${changeDepthLabel(table.changeLevel)})`);
        if (table.kindChanged && isChangeVisible('table', depth)) {
            const leftKind = table.left?.isView ? 'view' : 'table';
            const rightKind = table.right?.isView ? 'view' : 'table';
            lines.push(`    kind: ${leftKind} → ${rightKind}`);
        }
        for (const column of table.columns) {
            if (!isChangeVisible(column.changeLevel, depth) || column.status === 'identical') {
                continue;
            }
            if (column.status === 'leftOnly') {
                lines.push(`    - ${column.name} ${column.left?.typeDisplay ?? ''}`.trimEnd());
                continue;
            }
            if (column.status === 'rightOnly') {
                lines.push(`    + ${column.name} ${column.right?.typeDisplay ?? ''}`.trimEnd());
                continue;
            }
            lines.push(`    ~ ${column.name}  ${column.changes.join(', ')}`);
            if (column.changes.includes('type') || column.changes.includes('size')) {
                lines.push(
                    `        ${column.left?.typeDisplay ?? '—'} → ${column.right?.typeDisplay ?? '—'}`
                );
            }
        }
    }
    return lines.join('\n').trimEnd() + '\n';
}

function diffFilterLabel(filter: DiffFilter): string {
    if (filter === 'all') {
        return 'all';
    }
    if (filter === 'changed') {
        return 'changed';
    }
    if (filter === 'left') {
        return 'only left';
    }
    if (filter === 'right') {
        return 'only right';
    }
    if (filter === 'identical') {
        return 'identical';
    }
    return 'differences';
}

function changeDepthLabel(level: ChangeLevel): string {
    if (level === 'table') {
        return 'table';
    }
    if (level === 'column') {
        return 'columns';
    }
    if (level === 'type') {
        return 'type';
    }
    if (level === 'flags') {
        return 'flags';
    }
    return 'size';
}

function indexByMatchKey(
    tables: DiffableTable[],
    databaseLower: string,
    engine: string
): Map<string, DiffableTable> {
    const map = new Map<string, DiffableTable>();
    for (const table of tables) {
        if (table.database.toLowerCase() !== databaseLower) {
            continue;
        }
        map.set(tableMatchKey(table, engine), table);
    }
    return map;
}

function oneSidedDiff(
    table: DiffableTable,
    engine: string,
    status: 'leftOnly' | 'rightOnly'
): TableDiff {
    const columns: ColumnDiff[] = table.columns.map((column) => ({
        name: column.name,
        status,
        left: status === 'leftOnly' ? column : undefined,
        right: status === 'rightOnly' ? column : undefined,
        changes: [],
        changeLevel: 'column'
    }));
    return {
        key: tableMatchKey(table, engine),
        displayName: tableDisplayName(table, engine),
        status,
        left: status === 'leftOnly' ? sideMeta(table) : undefined,
        right: status === 'rightOnly' ? sideMeta(table) : undefined,
        kindChanged: false,
        changeLevel: 'table',
        columns
    };
}

function bothSidesDiff(left: DiffableTable, right: DiffableTable, engine: string): TableDiff {
    const leftCols = indexColumns(left.columns);
    const rightCols = indexColumns(right.columns);
    const names = new Set([...leftCols.keys(), ...rightCols.keys()]);
    const columns: ColumnDiff[] = [];
    for (const name of [...names].sort()) {
        const leftCol = leftCols.get(name);
        const rightCol = rightCols.get(name);
        columns.push(diffColumn(leftCol, rightCol));
    }
    const kindChanged = left.isView !== right.isView;
    let changeLevel: ChangeLevel = kindChanged ? 'table' : 'none';
    for (const column of columns) {
        changeLevel = strongerChangeLevel(changeLevel, column.changeLevel);
    }
    return {
        key: tableMatchKey(left, engine),
        displayName: tableDisplayName(left, engine),
        status: changeLevel === 'none' ? 'identical' : 'changed',
        left: sideMeta(left),
        right: sideMeta(right),
        kindChanged,
        changeLevel,
        columns
    };
}

function diffColumn(left?: DiffableColumn, right?: DiffableColumn): ColumnDiff {
    if (left && !right) {
        return {
            name: left.name,
            status: 'leftOnly',
            left,
            changes: [],
            changeLevel: 'column'
        };
    }
    if (right && !left) {
        return {
            name: right.name,
            status: 'rightOnly',
            right,
            changes: [],
            changeLevel: 'column'
        };
    }
    const changes: string[] = [];
    let changeLevel: ChangeLevel = 'none';
    const leftType = parseTypeDisplay(left!.typeDisplay);
    const rightType = parseTypeDisplay(right!.typeDisplay);
    if (leftType.base !== rightType.base) {
        changes.push('type');
        changeLevel = strongerChangeLevel(changeLevel, 'type');
    } else if (leftType.args !== rightType.args) {
        changes.push('size');
        changeLevel = strongerChangeLevel(changeLevel, 'size');
    } else if (
        (left!.typeDisplay || '').toLowerCase() !== (right!.typeDisplay || '').toLowerCase()
    ) {
        changes.push('size');
        changeLevel = strongerChangeLevel(changeLevel, 'size');
    }
    if (left!.isNullable !== right!.isNullable) {
        changes.push('null');
        changeLevel = strongerChangeLevel(changeLevel, 'flags');
    }
    if (left!.isPrimaryKey !== right!.isPrimaryKey) {
        changes.push('pk');
        changeLevel = strongerChangeLevel(changeLevel, 'flags');
    }
    if (left!.isIdentity !== right!.isIdentity) {
        changes.push('identity');
        changeLevel = strongerChangeLevel(changeLevel, 'flags');
    }
    if (left!.isComputed !== right!.isComputed) {
        changes.push('computed');
        changeLevel = strongerChangeLevel(changeLevel, 'flags');
    }
    return {
        name: left!.name,
        status: changes.length > 0 ? 'changed' : 'identical',
        left,
        right,
        changes,
        changeLevel
    };
}

function indexColumns(columns: DiffableColumn[]): Map<string, DiffableColumn> {
    const map = new Map<string, DiffableColumn>();
    for (const column of columns) {
        map.set(column.name.toLowerCase(), column);
    }
    return map;
}

function sideMeta(table: DiffableTable): { isView: boolean; columnCount: number } {
    return { isView: table.isView, columnCount: table.columns.length };
}
