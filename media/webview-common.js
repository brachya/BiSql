(function (root) {
  function engineLabel(kind) {
    if (kind === 'mysql') return 'MySQL';
    if (kind === 'postgres') return 'PostgreSQL';
    if (kind === 'supabase') return 'Supabase';
    if (kind === 'bigquery') return 'BigQuery';
    return 'SQL Server';
  }

  function initPage() {
    if (typeof acquireVsCodeApi !== 'function') {
      return null;
    }
    return acquireVsCodeApi();
  }

  root.bisqlWebview = { engineLabel: engineLabel, initPage: initPage };
})(typeof globalThis !== 'undefined' ? globalThis : this);
