import * as fs from 'fs/promises';
import * as path from 'path';
import { FilePort } from '../db/ports';

const CACHE_OFF = /^(off|false|0|no)$/i;

/**
 * Unset uses ~/.cache/bisql. Empty, off, false, 0, or no turns the disk cache off.
 */
export function resolveBisqlCacheDir(envValue: string | undefined, home: string): string | undefined {
    if (envValue === undefined) {
        return path.join(home, '.cache', 'bisql');
    }
    const trimmed = envValue.trim();
    if (trimmed === '' || CACHE_OFF.test(trimmed)) {
        return undefined;
    }
    return path.resolve(trimmed);
}

export function cacheFiles(dir: string): FilePort {
    const filePath = (name: string): string => {
        // path.join would escape the cache dir if name is absolute or contains '..'.
        if (name === '' || path.basename(name) !== name) {
            throw new Error('Invalid cache file name.');
        }
        return path.join(dir, name);
    };

    return {
        ensureStorageDir(): Promise<void> {
            return fs.mkdir(dir, { recursive: true }).then(() => undefined);
        },
        read(name: string): Promise<Uint8Array> {
            return fs.readFile(filePath(name));
        },
        async write(name: string, bytes: Uint8Array): Promise<void> {
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(filePath(name), bytes);
        },
        delete(name: string): Promise<void> {
            return fs.rm(filePath(name), { force: true }).then(() => undefined);
        }
    };
}
