import * as vscode from 'vscode';
import { cellFileName, CellEditorLanguage } from '../sql/cellDocument';

const SCHEME = 'bisql-cell';

interface StoredCell {
    text: string;
    mtime: number;
    writable: boolean;
}

export type CellSaveResult = 'saved' | 'cancelled' | 'failed';

type CellSaveHandler = (uri: vscode.Uri, text: string) => Promise<CellSaveResult>;

/**
 * One virtual file per opened cell, so it gets a real editor tab.
 * Editable cells can be saved. Saving calls the handler, which writes the database.
 * Other cells stay read-only.
 * ponytail: every opened cell stays in memory until the window reloads.
 * Upgrade path: drop the entry when the last editor for that uri closes.
 */
class CellValueFileSystem implements vscode.FileSystemProvider {
    private readonly files = new Map<string, StoredCell>();
    private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.emitter.event;
    saveHandler: CellSaveHandler | undefined;

    put(uri: vscode.Uri, text: string, writable: boolean): void {
        this.files.set(uri.toString(), { text, mtime: Date.now(), writable });
        this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const file = this.require(uri);
        return {
            type: vscode.FileType.File,
            ctime: file.mtime,
            mtime: file.mtime,
            size: Buffer.byteLength(file.text),
            permissions: file.writable ? undefined : vscode.FilePermission.Readonly
        };
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    readFile(uri: vscode.Uri): Uint8Array {
        return Buffer.from(this.require(uri).text, 'utf8');
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const file = this.require(uri);
        if (!file.writable) {
            throw vscode.FileSystemError.NoPermissions('This cell cannot be edited.');
        }
        const text = Buffer.from(content).toString('utf8');
        if (text === file.text) {
            return;
        }
        const result = this.saveHandler ? await this.saveHandler(uri, text) : 'failed';
        if (result === 'cancelled') {
            // Stay dirty. The message says the user stopped the save.
            throw vscode.FileSystemError.Unavailable('Save cancelled.');
        }
        if (result !== 'saved') {
            throw vscode.FileSystemError.Unavailable('The database change was not applied.');
        }
        file.text = text;
        file.mtime = Date.now();
        this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    private require(uri: vscode.Uri): StoredCell {
        const file = this.files.get(uri.toString());
        if (!file) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return file;
    }
}

const files = new CellValueFileSystem();
let registered = false;

export function cellValueUri(
    panelId: number,
    rowNumber: number,
    column: string,
    language: CellEditorLanguage
): vscode.Uri {
    return vscode.Uri.from({
        scheme: SCHEME,
        path: `/${panelId}/${cellFileName(column, rowNumber, language)}`
    });
}

export function putCellValue(uri: vscode.Uri, text: string, writable: boolean): void {
    if (!registered) {
        registered = true;
        vscode.workspace.registerFileSystemProvider(SCHEME, files);
    }
    files.put(uri, text, writable);
}

export function setCellSaveHandler(handler: CellSaveHandler): void {
    files.saveHandler = handler;
}
