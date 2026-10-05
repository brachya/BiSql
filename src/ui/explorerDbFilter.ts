import * as vscode from 'vscode';

/** profileId → database names shown in the sidebar. Missing entry means show all. */
export type ExplorerDbFilterMap = Record<string, string[]>;

export const EXPLORER_DB_FILTER_STATE = 'bisql.explorerSidebarDbFilter';

export function readExplorerDbFilter(context: vscode.ExtensionContext): ExplorerDbFilterMap {
    const raw = context.globalState.get<unknown>(EXPLORER_DB_FILTER_STATE);
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const map: ExplorerDbFilterMap = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(value)) {
            continue;
        }
        const names = value.map(String).filter((name) => name.trim().length > 0);
        if (names.length > 0) {
            map[key] = names;
        }
    }
    return map;
}

export async function writeExplorerDbFilter(
    context: vscode.ExtensionContext,
    map: ExplorerDbFilterMap
): Promise<void> {
    await context.globalState.update(EXPLORER_DB_FILTER_STATE, map);
}

function sameName(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

/** Names that may appear under a connection in the explorer. */
export function sidebarDatabaseNames(
    profileId: string,
    defaultDatabase: string,
    allNames: readonly string[],
    filterMap: ExplorerDbFilterMap
): string[] {
    const saved = filterMap[profileId];
    const defaultDb = defaultDatabase.trim();
    if (!saved || saved.length === 0) {
        return [...allNames];
    }
    const allowed = new Set(saved.map((name) => name.toLowerCase()));
    if (defaultDb) {
        allowed.add(defaultDb.toLowerCase());
    }
    const visible = allNames.filter((name) => allowed.has(name.toLowerCase()));
    if (defaultDb && !visible.some((name) => sameName(name, defaultDb))) {
        return [defaultDb, ...visible];
    }
    return visible;
}

/** Drop filter entries that no longer exist on the connection. */
export function pruneExplorerDbFilter(
    profileId: string,
    allNames: readonly string[],
    defaultDatabase: string,
    filterMap: ExplorerDbFilterMap
): ExplorerDbFilterMap {
    const saved = filterMap[profileId];
    if (!saved) {
        return filterMap;
    }
    const known = new Set(allNames.map((name) => name.toLowerCase()));
    const defaultDb = defaultDatabase.trim();
    if (defaultDb) {
        known.add(defaultDb.toLowerCase());
    }
    const next = saved.filter((name) => known.has(name.toLowerCase()));
    if (next.length === saved.length) {
        return filterMap;
    }
    const copy = { ...filterMap };
    if (next.length === 0) {
        delete copy[profileId];
    } else {
        copy[profileId] = next;
    }
    return copy;
}

export function hasSavedSidebarFilter(
    profileId: string,
    filterMap: ExplorerDbFilterMap
): boolean {
    const saved = filterMap[profileId];
    return Boolean(saved && saved.length > 0);
}

/** Keep only names on this connection; default database is always included. */
export function normalizeSidebarFilterVisible(
    visible: readonly string[],
    allNames: readonly string[],
    defaultDatabase: string
): string[] {
    const known = new Set(allNames.map((name) => name.toLowerCase()));
    const defaultDb = defaultDatabase.trim();
    if (defaultDb) {
        known.add(defaultDb.toLowerCase());
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of visible) {
        const name = raw.trim();
        if (!name) {
            continue;
        }
        const key = name.toLowerCase();
        if (!known.has(key) || seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(name);
    }
    if (defaultDb) {
        const defaultKey = defaultDb.toLowerCase();
        if (!seen.has(defaultKey)) {
            const fromAll = allNames.find((name) => sameName(name, defaultDb));
            result.unshift(fromAll ?? defaultDb);
        }
    }
    return result;
}

export function removeExplorerDbFilterForProfile(
    filterMap: ExplorerDbFilterMap,
    profileId: string
): ExplorerDbFilterMap {
    if (!filterMap[profileId]) {
        return filterMap;
    }
    const copy = { ...filterMap };
    delete copy[profileId];
    return copy;
}

export async function pruneAndPersistExplorerDbFilter(
    context: vscode.ExtensionContext,
    profileId: string,
    allNames: readonly string[],
    defaultDatabase: string
): Promise<void> {
    const current = readExplorerDbFilter(context);
    const pruned = pruneExplorerDbFilter(profileId, allNames, defaultDatabase, current);
    if (pruned === current) {
        return;
    }
    await writeExplorerDbFilter(context, pruned);
}
