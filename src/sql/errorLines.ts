import { SqlBlock } from '../parser/sqlExtractor';

const ALREADY_ANNOTATED = /\bquery line\s+\d+,\s*file line\s+\d+/i;

/**
 * Engines count lines from the SQL batch they received, not from the .sql or
 * .py file. Map that batch line onto the file so both numbers can be shown.
 */
export function fileLineForQueryLine(block: SqlBlock, queryLine: number): number {
    return block.sqlOffsetToDocPosition(block.lineToSqlOffset(queryLine)).line + 1;
}

export function parseQueryLineFromMessage(message: string): number | undefined {
    const re = /\b(?:at\s+line|on\s+line|LINE|Line)\s+(\d+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(message))) {
        const before = message.slice(Math.max(0, match.index - 6), match.index).toLowerCase();
        if (before.endsWith('query ') || before.endsWith('file ')) {
            continue;
        }
        return finiteLine(Number(match[1]));
    }
    return undefined;
}

/** Postgres `position` is a 1-based character index into the SQL it parsed. */
export function queryLineFromCharPosition(sql: string, position: number): number {
    if (!Number.isFinite(position) || position < 1) {
        return 1;
    }
    const end = Math.min(Math.floor(position) - 1, sql.length);
    let line = 1;
    for (let i = 0; i < end; i++) {
        if (sql[i] === '\n') {
            line += 1;
        }
    }
    return line;
}

/** Newlines before `offset`. Used to lift a per-statement line onto the batch. */
export function newlinesBefore(sql: string, offset: number): number {
    const end = Math.max(0, Math.min(Math.floor(offset), sql.length));
    let lines = 0;
    for (let i = 0; i < end; i++) {
        if (sql[i] === '\n') {
            lines += 1;
        }
    }
    return lines;
}

/** Engine line is 1-based inside one statement. Return the 1-based line in `fullSql`. */
export function queryLineInFullSql(
    fullSql: string,
    statementStart: number,
    statementLine: number
): number {
    return (finiteLine(statementLine) ?? 1) + newlinesBefore(fullSql, statementStart);
}

/**
 * Engine messages count lines inside the one statement they saw.
 * Shift those numbers onto the full batch before mapping to the file.
 */
export function shiftEngineLineRefs(message: string, extraLines: number): string {
    if (extraLines === 0) {
        return message;
    }
    return message.replace(
        /\b(?:at\s+line|on\s+line|LINE|Line)\s+(\d+)\b/g,
        (full, raw, offset: number, whole: string) => {
            const before = whole.slice(Math.max(0, offset - 6), offset).toLowerCase();
            if (before.endsWith('query ') || before.endsWith('file ')) {
                return full;
            }
            const queryLine = finiteLine(Number(raw));
            if (queryLine === undefined) {
                return full;
            }
            const next = queryLine + extraLines;
            if (/^at\s+line/i.test(full)) {
                return `at line ${next}`;
            }
            if (/^on\s+line/i.test(full)) {
                return `on line ${next}`;
            }
            if (/^LINE/.test(full)) {
                return `LINE ${next}`;
            }
            return `Line ${next}`;
        }
    );
}

export function queryLineFromEngineError(error: unknown, sql?: string): number | undefined {
    const err = error as {
        position?: string | number;
        lineNumber?: number;
        sqlMessage?: string;
        message?: string;
    };
    if (sql !== undefined && err.position !== undefined && err.position !== '') {
        const pos = Number(err.position);
        if (Number.isFinite(pos) && pos >= 1) {
            return queryLineFromCharPosition(sql, pos);
        }
    }
    const message =
        typeof err.sqlMessage === 'string'
            ? err.sqlMessage
            : typeof err.message === 'string'
              ? err.message
              : '';
    return parseQueryLineFromMessage(message) ?? finiteLine(err.lineNumber);
}

export function annotateSqlError(
    message: string,
    block: SqlBlock,
    reportedQueryLine?: number
): string {
    if (ALREADY_ANNOTATED.test(message)) {
        return message;
    }
    const rewritten = replaceEngineLineRefs(message, (queryLine) =>
        formatQueryAndFile(queryLine, fileLineForQueryLine(block, queryLine))
    );
    if (rewritten !== message) {
        return rewritten;
    }
    const queryLine = parseQueryLineFromMessage(message) ?? finiteLine(reportedQueryLine);
    if (queryLine === undefined) {
        return message;
    }
    return `${trimRight(message)} (${formatQueryAndFile(queryLine, fileLineForQueryLine(block, queryLine))})`;
}

function formatQueryAndFile(queryLine: number, fileLine: number): string {
    return `query line ${queryLine}, file line ${fileLine}`;
}

function replaceEngineLineRefs(message: string, format: (queryLine: number) => string): string {
    return message.replace(
        /\b(?:at\s+line|on\s+line|LINE|Line)\s+(\d+)\b/g,
        (full, raw, offset: number, whole: string) => {
            const before = whole.slice(Math.max(0, offset - 6), offset).toLowerCase();
            if (before.endsWith('query ') || before.endsWith('file ')) {
                return full;
            }
            const queryLine = finiteLine(Number(raw));
            if (queryLine === undefined) {
                return full;
            }
            if (/^at\s+line/i.test(full)) {
                return `at ${format(queryLine)}`;
            }
            if (/^on\s+line/i.test(full)) {
                return `on ${format(queryLine)}`;
            }
            return format(queryLine);
        }
    );
}

function finiteLine(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        return undefined;
    }
    return Math.floor(value);
}

function trimRight(text: string): string {
    return text.replace(/\s+$/, '');
}
