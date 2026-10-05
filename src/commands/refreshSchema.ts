import * as vscode from 'vscode';
import { effectiveCachedProjects } from '../db/bigqueryCache';
import { SqlServerService } from '../db/connection';
import { DiagnosticsManager } from '../providers/diagnostics';

export type RefreshSchemaOptions = {
    /** BigQuery: refresh only these project ids. Omit to prompt, or home when silent. */
    projects?: string[];
    /** Skip the project picker. BigQuery then refreshes the home project only. */
    silent?: boolean;
};

export type RefreshSchemaResult = {
    ok: boolean;
    cancelled: boolean;
    /** Cache changed, including a partial BigQuery refresh. */
    updated: boolean;
};

/**
 * Reload schema. BigQuery asks which cached project(s) unless `projects` or `silent` is set.
 */
export async function refreshSchemaWithPicker(
    db: SqlServerService,
    diagnostics: DiagnosticsManager,
    options: RefreshSchemaOptions = {}
): Promise<RefreshSchemaResult> {
    const config = db.getConfig();
    if (config.engine !== 'bigquery') {
        const ok = await db.refreshSchema();
        return finishRefresh(db, diagnostics, { ok, updated: ok }, options.silent === true);
    }

    let projects = options.projects;
    if (!projects && !options.silent) {
        const picked = await pickBigqueryRefreshProjects(config.server, config.cachedProjects);
        if (!picked) {
            return { ok: false, cancelled: true, updated: false };
        }
        projects = picked;
    }
    if (!projects) {
        const home = config.server.trim();
        projects = options.silent
            ? home
                ? [home]
                : []
            : effectiveCachedProjects(config.server, config.cachedProjects);
    }
    if (projects.length === 0) {
        vscode.window.showWarningMessage('No BigQuery project to refresh. Set a home project first.');
        return { ok: false, cancelled: false, updated: false };
    }

    const label =
        projects.length === 1
            ? `Refreshing ${projects[0]}…`
            : `Refreshing ${projects.length} projects…`;
    const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: label },
        () => db.refreshSchemaOutcome({ projects })
    );
    return finishRefresh(db, diagnostics, outcome, options.silent === true);
}

async function pickBigqueryRefreshProjects(
    homeProject: string,
    cachedProjects: readonly string[]
): Promise<string[] | undefined> {
    const all = effectiveCachedProjects(homeProject, cachedProjects);
    if (all.length === 0) {
        return [];
    }
    if (all.length === 1) {
        return all;
    }

    const home = homeProject.trim().toLowerCase();
    const defaultPick =
        all.length <= 3 ? all : all.filter((project) => project.toLowerCase() === home);

    const items: vscode.QuickPickItem[] = [
        {
            label: 'All cached projects',
            description: `${all.length} projects`,
            picked: defaultPick.length === all.length
        },
        ...all.map((projectId) => ({
            label: projectId,
            description: projectId.toLowerCase() === home ? 'Home' : 'Cached',
            picked: defaultPick.some((picked) => picked.toLowerCase() === projectId.toLowerCase())
        }))
    ];

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Refresh schema — pick project(s)',
        placeHolder: 'Home only, one project, or all cached',
        canPickMany: true
    });
    if (!selected || selected.length === 0) {
        return undefined;
    }
    if (selected.some((item) => item.label === 'All cached projects')) {
        return all;
    }
    return selected.map((item) => item.label);
}

async function finishRefresh(
    db: SqlServerService,
    diagnostics: DiagnosticsManager,
    outcome: { ok: boolean; updated: boolean },
    silent: boolean
): Promise<RefreshSchemaResult> {
    if (outcome.updated) {
        await diagnostics.revalidateOpenDocuments(false);
    }
    if (outcome.ok) {
        if (!silent) {
            vscode.window.showInformationMessage(
                `Schema refreshed: ${db.schema.tables.length} tables/views.`
            );
        }
    } else {
        vscode.window.showWarningMessage(
            db.lastErrorMessage ?? 'Could not refresh schema. Check connection settings.'
        );
    }
    return { ok: outcome.ok, cancelled: false, updated: outcome.updated };
}
