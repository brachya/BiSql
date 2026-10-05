export type CellEditorLanguage = 'json' | 'plaintext';

export interface CellEditorText {
    language: CellEditorLanguage;
    text: string;
}

/**
 * Text for the cell editor.
 * Objects and arrays are pretty-printed. Keep this in step with prettyJsonText
 * in media/webview-common.js so the popup and the editor show the same text.
 * Numbers are copied as written. JSON.parse would round integers above 2^53-1.
 */
export function cellEditorText(value: string): CellEditorText {
    const pretty = prettyJsonText(value);
    if (pretty === undefined) {
        return { language: 'plaintext', text: value };
    }
    return { language: 'json', text: pretty };
}

/** Pretty-print a JSON object or array. Undefined when the text is not one. */
export function prettyJsonText(value: string): string | undefined {
    const src = value.trim();
    if (
        !((src.startsWith('{') && src.endsWith('}')) || (src.startsWith('[') && src.endsWith(']')))
    ) {
        return undefined;
    }
    let i = 0;
    const out: string[] = [];
    const fail = (): undefined => undefined;
    const peek = (): string => src[i] ?? '';
    const skip = (): void => {
        while (i < src.length && (src[i] === ' ' || src[i] === '\n' || src[i] === '\r' || src[i] === '\t')) {
            i += 1;
        }
    };
    const readString = (): string => {
        const start = i;
        if (src[i] !== '"') {
            throw fail();
        }
        i += 1;
        while (i < src.length) {
            const ch = src[i];
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === '"') {
                i += 1;
                return src.slice(start, i);
            }
            if (ch < ' ') {
                throw fail();
            }
            i += 1;
        }
        throw fail();
    };
    const readNumber = (): string => {
        const start = i;
        if (src[i] === '-') {
            i += 1;
        }
        if (src[i] === '0') {
            i += 1;
        } else if (src[i] >= '1' && src[i] <= '9') {
            while (src[i] >= '0' && src[i] <= '9') {
                i += 1;
            }
        } else {
            throw fail();
        }
        if (src[i] === '.') {
            i += 1;
            if (!(src[i] >= '0' && src[i] <= '9')) {
                throw fail();
            }
            while (src[i] >= '0' && src[i] <= '9') {
                i += 1;
            }
        }
        if (src[i] === 'e' || src[i] === 'E') {
            i += 1;
            if (src[i] === '+' || src[i] === '-') {
                i += 1;
            }
            if (!(src[i] >= '0' && src[i] <= '9')) {
                throw fail();
            }
            while (src[i] >= '0' && src[i] <= '9') {
                i += 1;
            }
        }
        return src.slice(start, i);
    };
    const readLiteral = (word: string): void => {
        if (!src.startsWith(word, i)) {
            throw fail();
        }
        i += word.length;
        out.push(word);
    };
    const parseValue = (indent: number): void => {
        skip();
        const ch = peek();
        if (ch === '{') {
            parseObject(indent);
            return;
        }
        if (ch === '[') {
            parseArray(indent);
            return;
        }
        if (ch === '"') {
            out.push(readString());
            return;
        }
        if (ch === '-' || (ch >= '0' && ch <= '9')) {
            out.push(readNumber());
            return;
        }
        if (ch === 't') {
            readLiteral('true');
            return;
        }
        if (ch === 'f') {
            readLiteral('false');
            return;
        }
        if (ch === 'n') {
            readLiteral('null');
            return;
        }
        throw fail();
    };
    const parseObject = (indent: number): void => {
        i += 1;
        skip();
        if (peek() === '}') {
            i += 1;
            out.push('{}');
            return;
        }
        out.push('{\n');
        for (;;) {
            out.push('  '.repeat(indent + 1));
            skip();
            out.push(readString());
            skip();
            if (peek() !== ':') {
                throw fail();
            }
            i += 1;
            out.push(': ');
            parseValue(indent + 1);
            skip();
            if (peek() === ',') {
                i += 1;
                out.push(',\n');
                skip();
                continue;
            }
            if (peek() !== '}') {
                throw fail();
            }
            i += 1;
            out.push(`\n${'  '.repeat(indent)}}`);
            return;
        }
    };
    const parseArray = (indent: number): void => {
        i += 1;
        skip();
        if (peek() === ']') {
            i += 1;
            out.push('[]');
            return;
        }
        out.push('[\n');
        for (;;) {
            out.push('  '.repeat(indent + 1));
            parseValue(indent + 1);
            skip();
            if (peek() === ',') {
                i += 1;
                out.push(',\n');
                skip();
                continue;
            }
            if (peek() !== ']') {
                throw fail();
            }
            i += 1;
            out.push(`\n${'  '.repeat(indent)}]`);
            return;
        }
    };
    try {
        parseValue(0);
        skip();
        if (i !== src.length) {
            return undefined;
        }
        return out.join('');
    } catch {
        return undefined;
    }
}

export interface CellKey {
    sourceColumn: string;
    value: string;
}

/** Row whose key columns match. -1 when the row is not in this page. */
export function rowMatchingKeys(
    rows: readonly (readonly string[])[],
    sourceColumns: readonly (string | undefined)[],
    keys: readonly CellKey[]
): number {
    if (keys.length === 0) {
        return -1;
    }
    const indexes = keys.map((key) => sourceColumns.indexOf(key.sourceColumn));
    if (indexes.some((index) => index < 0)) {
        return -1;
    }
    return rows.findIndex((row) => indexes.every((index, i) => row[index] === keys[i].value));
}

/** Panel id from a cell uri path like `/3/payload (row 1).json`. */
export function cellPanelId(path: string): number | undefined {
    const part = path.split('/').find((piece) => piece.length > 0);
    if (!part || !/^\d+$/.test(part)) {
        return undefined;
    }
    return Number(part);
}

/** Tab label for one cell. Slashes become underscores, so a/b and a_b share a name. */
export function cellFileName(column: string, rowNumber: number, language: CellEditorLanguage): string {
    const base = (column.trim() || 'cell').replace(/[\\/:*?"<>|]/g, '_');
    const ext = language === 'json' ? '.json' : '.txt';
    return `${base} (row ${rowNumber})${ext}`;
}
