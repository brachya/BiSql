import * as vscode from 'vscode';
import { SqlServerService } from '../db/connection';
import { formatScanBytes, shouldConfirmScan } from '../db/bigquery';

/**
 * Asks before a BigQuery Run whose dry-run estimate is above
 * `bisql.bigqueryConfirmScanMb`. Other engines, failed estimates, and
 * scans at or under the threshold return true without a prompt.
 */
export async function confirmBigqueryScan(
    db: SqlServerService,
    sql: string,
    params: Record<string, string | null>
): Promise<boolean> {
    const estimate = await db.estimateBigqueryScan(sql, params);
    if (!estimate) {
        return true;
    }
    const thresholdMb = db.getConfig().bigqueryConfirmScanMb;
    const bytes = estimate.bytes;
    if (!shouldConfirmScan(bytes, thresholdMb) || bytes === undefined) {
        return true;
    }
    const confirm = await vscode.window.showWarningMessage(
        `This BigQuery job may scan ${formatScanBytes(bytes)}. Run it anyway?`,
        { modal: true },
        'Run'
    );
    return confirm === 'Run';
}
