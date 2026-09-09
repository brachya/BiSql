(function () {
  const dateCells = (typeof globalThis !== 'undefined' && globalThis.bisqlDateCells) || {};
  const dateInputType = dateCells.dateInputType || function () { return 'text'; };
  const sqlToInput = dateCells.sqlToInput || function (_type, value) { return value || ''; };
  const inputToSql = dateCells.inputToSql || function (_type, value) { return value || ''; };
  const vscode = (typeof globalThis !== 'undefined' && globalThis.bisqlWebview)
    ? globalThis.bisqlWebview.initPage()
    : (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
  if (!vscode) {
    return;
  }

  const NULL_DISPLAY = 'NULL';
  const EXPAND_ICON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 6.2V3.4h2.8M12.6 6.2V3.4h-2.8M3.4 9.8v2.8h2.8M12.6 9.8v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CELL_PREVIEW_LEN = 160;
  let state = { sql: '', columns: [], rows: [], edit: {}, pager: {} };
  let selected = { row: -1, col: -1 };
  let busy = false;
  let editing = false;
  let detailed = false;
  let viewer = { open: false, mode: 'cell', row: -1, col: -1 };
  let applyingView = false;

  const host = document.getElementById('tableHost');
  const pageTitle = document.getElementById('pageTitle');
  const scanCost = document.getElementById('scanCost');
  const toolbar = document.getElementById('toolbar');
  const editActions = document.getElementById('editActions');
  const resultBanner = document.getElementById('resultBanner');
  const pager = document.getElementById('pager');
  const pageLabel = document.getElementById('pageLabel');
  const sqlBox = document.getElementById('sqlBox');
  const btnSqlToggle = document.getElementById('btnSqlToggle');
  const btnCopySql = document.getElementById('btnCopySql');
  const btnRunSql = document.getElementById('btnRunSql');
  const btnEditSql = document.getElementById('btnEditSql');
  const sqlText = document.getElementById('sqlText');
  const sqlPreview = document.getElementById('sqlPreview');
  const paramList = document.getElementById('paramList');
  const paramLabel = document.getElementById('paramLabel');
  const btnInfo = document.getElementById('btnInfo');
  const infoPop = document.getElementById('infoPop');
  const btnNull = document.getElementById('btnNull');
  const btnDelete = document.getElementById('btnDelete');
  const btnDuplicate = document.getElementById('btnDuplicate');
  const btnRename = document.getElementById('btnRename');
  const btnDetailed = document.getElementById('btnDetailed');
  const btnRefresh = document.getElementById('btnRefresh');
const ctxMenu = document.getElementById('ctxMenu');
const exportScope = document.getElementById('exportScope');
const exportFormat = document.getElementById('exportFormat');
const btnCopy = document.getElementById('btnCopy');
const btnSave = document.getElementById('btnSave');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const pageSize = document.getElementById('pageSize');
const liveStatus = document.getElementById('liveStatus');
const cellViewer = document.getElementById('cellViewer');
const viewerTitle = document.getElementById('viewerTitle');
const viewerBody = document.getElementById('viewerBody');
const viewerToggle = document.getElementById('viewerToggle');
const viewerCopy = document.getElementById('viewerCopy');
const viewerClose = document.getElementById('viewerClose');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bindValueFromInput(value) {
  if (/^null$/i.test(value)) return null;
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) {
      const inner = value.slice(1, -1);
      if (!inner.includes(quote)) return inner;
    }
  }
  return value;
}

function readParamValues() {
  const values = {};
  if (!paramList) return values;
  paramList.querySelectorAll('.param-input').forEach((input) => {
    const name = input.getAttribute('data-name');
    if (!name) return;
    const kind = input.getAttribute('data-kind');
    const raw = input.value;
    values[name] = kind === 'placeholder' ? raw : bindValueFromInput(raw);
  });
  return values;
}

function renderParamFields(params, fields) {
  if (!paramList) return;
  const list = Array.isArray(fields) && fields.length
    ? fields
    : Object.keys(params || {}).map((name) => ({ name, kind: 'bind' }));
  if (list.length === 0) {
    paramList.innerHTML = '';
    paramList.hidden = true;
    if (paramLabel) paramLabel.hidden = true;
    return;
  }
  paramList.hidden = false;
  if (paramLabel) paramLabel.hidden = false;
  paramList.innerHTML = list.map((field) => {
    const name = field.name;
    const current = params && Object.prototype.hasOwnProperty.call(params, name)
      ? params[name]
      : undefined;
    const shown = current === null
      ? 'NULL'
      : current === undefined ? '' : current;
    const label = field.kind === 'placeholder' ? '{' + name + '}' : ':' + name;
    const hint = field.kind === 'placeholder' ? 'paste into SQL' : 'empty string';
    return '<div class="param-row"><label><span class="param">' + escapeHtml(label) +
      '</span></label><input class="param-input" data-name="' + escapeHtml(name) +
      '" data-kind="' + escapeHtml(field.kind || 'bind') +
      '" value="' + escapeHtml(shown) + '" placeholder="' + escapeHtml(hint) +
      '" spellcheck="false" /></div>';
  }).join('');
}

  function applySqlDraft(msg) {
    if (sqlPreview && typeof msg.previewHtml === 'string') sqlPreview.innerHTML = msg.previewHtml;
    if (sqlText && typeof msg.sqlHtml === 'string') sqlText.innerHTML = msg.sqlHtml;
    if (msg.params && typeof msg.params === 'object') renderParamFields(msg.params, msg.paramFields);
  }

  function applySqlOpenClass(open) {
    if (!sqlBox || !btnSqlToggle) return;
    sqlBox.classList.toggle('open', open);
    btnSqlToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function fillPageSize(pager) {
    if (!pageSize || !pager || !Array.isArray(pager.pageSizes)) return;
    const sizes = pager.pageSizes;
    const current = String(pager.pageSize);
    pageSize.innerHTML = sizes.map((size) => {
      return '<option value="' + size + '"' + (size === pager.pageSize ? ' selected' : '') + '>' +
        size + '</option>';
    }).join('');
    pageSize.value = current;
  }

  function renderInfo(items) {
    if (!infoPop) return;
    infoPop.innerHTML = (items || []).map((item) => {
      return '<p><span class="k">' + escapeHtml(item.label) + '</span>' +
        escapeHtml(item.text) + '</p>';
    }).join('');
  }

  function applyBanner(msg) {
    const hasGrid = !!(msg.ok && msg.grid && msg.grid.columns && msg.grid.columns.length > 0);
    if (toolbar) toolbar.hidden = !hasGrid;
    if (pager) pager.hidden = !hasGrid;
    if (editActions) {
      editActions.hidden = !(hasGrid && msg.grid.edit && msg.grid.edit.editable);
    }
    if (!resultBanner) return;
    if (msg.loading) {
      resultBanner.hidden = false;
      resultBanner.className = 'status info';
      resultBanner.textContent =
        'Running SQL… The editor stays usable. Cancel from the progress toast if it hangs.';
      return;
    }
    if (!msg.ok) {
      resultBanner.hidden = false;
      resultBanner.className = 'status error';
      resultBanner.textContent = msg.error || 'The query failed.';
      return;
    }
    if (!hasGrid) {
      const affected = msg.rowsAffected === undefined
        ? 'The statement finished. No result rows.'
        : msg.rowsAffected + ' row' + (msg.rowsAffected === 1 ? '' : 's') + ' affected.';
      resultBanner.hidden = false;
      resultBanner.className = 'status info';
      resultBanner.textContent = affected;
      return;
    }
    resultBanner.hidden = true;
  }

  function applyScanCost(msg) {
    if (!scanCost) return;
    const text = msg.loading ? '' : (msg.scanLabel || '');
    scanCost.hidden = !text;
    scanCost.textContent = text;
  }

  function applySetResult(msg) {
    applyingView = true;
    try {
    const prevKey = scrollKey();
    state = msg.grid || { sql: '', columns: [], rows: [], edit: {}, pager: {} };
    detailed = !!msg.detailed;
    document.body.classList.toggle('detailed', detailed);
    const nextKey = scrollKey();
    if (prevKey !== nextKey) {
      selected = { row: -1, col: -1 };
      scrollTarget = readSavedScroll();
    }
    if (selected.row >= (state.rows || []).length) selected.row = -1;
    if (selected.col >= (state.columns || []).length) selected.col = -1;
    paintedRows = 0;
    if (pageTitle) {
      pageTitle.textContent = msg.loading
        ? 'Running SQL'
        : !msg.ok
          ? 'Query failed'
          : msg.readOnly
            ? 'Query plan'
            : 'Query results';
    }
    applyScanCost(msg);
    applySqlOpenClass(!!msg.sqlOpen);
    applySqlDraft(msg);
    renderInfo(msg.info);
    fillPageSize(state.pager);
    if (pageLabel && state.pager) {
      pageLabel.textContent = state.pager.rowEnd === 0
        ? 'No rows'
        : 'Rows ' + state.pager.rowStart + '–' + state.pager.rowEnd;
    }
    applyBanner(msg);
    hideCtxMenu();
    renderTable(true);
    updateToolbar();
    } finally {
      applyingView = false;
    }
  }

  function runEditorSql() {
  if (busy) return;
  setSqlOpen(true);
  vscode.postMessage({ type: 'runQuery', params: readParamValues() });
}

function colMeta(col) {
  return (state.edit && state.edit.columns && state.edit.columns[col]) || {};
}

function columnDetailLine(meta) {
  const bits = [];
  if (meta.typeDisplay) bits.push(meta.typeDisplay);
  else if (meta.typeName) bits.push(meta.typeName);
  if (meta.isPrimaryKey) bits.push('PK');
  if (meta.isIdentity) bits.push('identity');
  if (meta.isComputed) bits.push('computed');
  if (meta.sourceColumn) bits.push(meta.isNullable ? 'NULL' : 'NOT NULL');
  return bits.join(' · ');
}

function typeKind(typeName) {
  const t = String(typeName || '').toLowerCase();
  if (/uniqueidentifier|uuid|guid/.test(t)) return 'id';
  if (/^rowversion$/.test(t)) return 'id';
  if (/\b(bit|bool)/.test(t)) return 'bool';
  if (/date|time/.test(t)) return 'date';
  if (/int|decimal|numeric|float|real|money|double|number|smallmoney/.test(t)) return 'number';
  if (/binary|varbinary|blob|image/.test(t)) return 'id';
  if (/char|text|json|xml|enum|set|clob/.test(t)) return 'string';
  return '';
}

function inferKind(value) {
  const v = String(value).trim();
  if (/^(true|false)$/i.test(v)) return 'bool';
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return 'number';
  if (/^\d{4}-\d{2}-\d{2}([ tT]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return 'date';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'id';
  return 'string';
}

function valueKind(typeName, value) {
  return typeKind(typeName) || inferKind(value);
}

function cellPreview(value) {
  // One line in the grid; the full value stays in state.rows for the viewer.
  const oneLine = String(value).replace(/[\r\n\t]+/g, ' ');
  if (oneLine.length > CELL_PREVIEW_LEN) return oneLine.slice(0, CELL_PREVIEW_LEN) + '…';
  return oneLine;
}

function needsExpand(value) {
  const text = String(value);
  if (text === NULL_DISPLAY) return false;
  return /[\r\n]/.test(text) || text.length > 80;
}

function formatFullValue(value) {
  if (value === NULL_DISPLAY) return value;
  const text = String(value);
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (err) {}
  }
  return text;
}

function expandButtonHtml() {
  return '<button type="button" class="cell-expand icon-btn" data-view="cell" title="View full cell">' +
    EXPAND_ICON + '</button>';
}

function markOverflowCells() {
  if (!host) return;
  host.querySelectorAll('td[data-row]').forEach((td) => {
    if (td.querySelector('.cell-expand')) return;
    const textEl = td.querySelector('.cell-text');
    if (!textEl || textEl.scrollWidth <= textEl.clientWidth + 1) return;
    const inner = td.querySelector('.cell-inner');
    if (!inner) return;
    inner.insertAdjacentHTML('beforeend', expandButtonHtml());
  });
}

function closeViewer() {
  viewer.open = false;
  if (cellViewer) cellViewer.classList.remove('open');
}

function renderViewer() {
  if (!cellViewer || !viewerTitle || !viewerBody || !viewerToggle) return;
  const row = state.rows[viewer.row];
  if (!row) {
    closeViewer();
    return;
  }
  if (viewer.mode === 'row') {
    viewerTitle.textContent = 'Row ' + (viewer.row + 1);
    viewerToggle.textContent = 'View cell';
    viewerToggle.disabled = viewer.col < 0;
    viewerBody.innerHTML = state.columns.map((name, i) => {
      return '<div class="viewer-field"><div class="viewer-key">' + escapeHtml(name) +
        '</div><pre class="viewer-val">' + escapeHtml(formatFullValue(row[i])) + '</pre></div>';
    }).join('');
  } else {
    const name = state.columns[viewer.col] || 'Cell';
    viewerTitle.textContent = name;
    viewerToggle.textContent = 'View row';
    viewerToggle.disabled = false;
    viewerBody.innerHTML = '<pre>' + escapeHtml(formatFullValue(row[viewer.col])) + '</pre>';
  }
  cellViewer.classList.add('open');
  viewer.open = true;
}

function openViewer(mode, row, col) {
  hideCtxMenu();
  setInfoOpen(false);
  viewer = { open: true, mode: mode, row: row, col: col };
  renderViewer();
}

let paintedRows = 0;
const ROW_BATCH = 80;
// After a full webview reload, keep applying saved scroll until the table
// is tall/wide enough. Cleared once we reach it or there are no more rows.
let scrollTarget = null;

function scrollKey() {
  return String(state.sql || '') + '\0' + (state.columns || []).join('\0');
}

function readSavedScroll() {
  const saved = vscode.getState();
  if (!saved || saved.scrollKey !== scrollKey()) return { top: 0, left: 0 };
  return { top: Number(saved.scrollTop) || 0, left: Number(saved.scrollLeft) || 0 };
}

function writeSavedScroll(wrap) {
  if (!wrap) return;
  vscode.setState({
    scrollKey: scrollKey(),
    scrollTop: wrap.scrollTop,
    scrollLeft: wrap.scrollLeft
  });
}

function restoreScroll(wrap, top, left) {
  if (!wrap) return;
  requestAnimationFrame(() => {
    wrap.scrollTop = top;
    wrap.scrollLeft = left;
    if (scrollTarget) {
      const reachedTop = wrap.scrollTop >= scrollTarget.top - 1
        || (paintedRows >= state.rows.length
          && wrap.scrollTop >= wrap.scrollHeight - wrap.clientHeight - 1);
      const reachedLeft = wrap.scrollLeft >= scrollTarget.left - 1
        || wrap.scrollLeft >= wrap.scrollWidth - wrap.clientWidth - 1;
      if (reachedTop && reachedLeft) scrollTarget = null;
    }
    writeSavedScroll(wrap);
  });
}

function rowNumber(r) {
  const start = state.pager && state.pager.rowStart ? state.pager.rowStart : 1;
  return start + r;
}

function headHtml() {
  // Display-only gutter. No data-col, so sort does not treat # as a query column.
  return '<th class="row-num" scope="col">#</th>' + state.columns.map((name, col) => {
    const meta = colMeta(col);
    const sorted = state.pager && state.pager.sortCol === col;
    const kind = typeKind(meta.typeName || meta.typeDisplay);
    const cls = [
      meta.canEdit ? '' : 'locked',
      col === selected.col ? 'selected' : '',
      sorted ? 'sorted' : '',
      kind ? 'kind-' + kind : ''
    ].filter(Boolean).join(' ');
    const mark = sorted ? (state.pager.sortDir === 'DESC' ? ' ▼' : ' ▲') : '';
    const detail = columnDetailLine(meta);
    const title = sorted
      ? 'Sorted ' + state.pager.sortDir + ' — click to change'
      : (detail || (meta.sourceColumn && meta.sourceColumn !== name
        ? 'Column ' + meta.sourceColumn
        : 'Click to sort'));
    return '<th data-col="' + col + '" class="' + cls + '"' +
      (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' +
      '<span class="col-name">' +
      (kind ? '<span class="type-dot"></span>' : '') +
      escapeHtml(name) +
      (meta.isPrimaryKey ? ' (PK)' : '') +
      '<span class="sort-mark">' + mark + '</span></span>' +
      (detail ? '<span class="col-meta">' + escapeHtml(detail) + '</span>' : '') +
      '</th>';
  }).join('');
}

function rowHtml(row, r) {
  const cells = row.map((cell, c) => {
    const meta = colMeta(c);
    const isNull = cell === NULL_DISPLAY;
    const kind = isNull ? 'null' : valueKind(meta.typeName || meta.typeDisplay, cell);
    const classes = [
      isNull ? 'null' : 'cell-' + kind,
      meta.canEdit ? '' : 'locked',
      meta.isPrimaryKey ? 'pk' : '',
      selected.row === r && selected.col === c ? 'selected' : ''
    ].filter(Boolean).join(' ');
    const editHint = state.edit && state.edit.editable && meta.canEdit
      ? 'Click again or press Enter to edit'
      : '';
    const preview = cellPreview(cell);
    const expand = needsExpand(cell) ? expandButtonHtml() : '';
    return '<td data-row="' + r + '" data-col="' + c + '" class="' + classes + '"' +
      (editHint ? ' title="' + editHint + '"' : '') + '>' +
      '<span class="cell-inner"><span class="cell-text">' + escapeHtml(preview) +
      '</span>' + expand + '</span></td>';
  }).join('');
  const trClass = selected.row === r ? ' class="selected"' : '';
  return '<tr' + trClass + '><td class="row-num">' + rowNumber(r) + '</td>' + cells + '</tr>';
}

function bindLazyPaint(wrap) {
  if (!wrap || paintedRows >= state.rows.length) return;
  if (wrap.scrollHeight <= wrap.clientHeight + 4) {
    requestAnimationFrame(() => {
      paintedRows = Math.min(state.rows.length, paintedRows + ROW_BATCH);
      renderTable(false);
    });
  } else {
    wrap.addEventListener('scroll', () => {
      if (paintedRows >= state.rows.length) return;
      if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 80) return;
      paintedRows = Math.min(state.rows.length, paintedRows + ROW_BATCH);
      renderTable(false);
    }, { once: true });
  }
}

function renderTable(resetPaint) {
  if (!host) return;
  if (!state.columns || state.columns.length === 0) {
    host.innerHTML = '';
    return;
  }
  let wrap = host.querySelector('.table-wrap');
  if (scrollTarget === null && !wrap) {
    scrollTarget = readSavedScroll();
  }
  const keepTop = scrollTarget ? scrollTarget.top : (wrap ? wrap.scrollTop : 0);
  const keepLeft = scrollTarget ? scrollTarget.left : (wrap ? wrap.scrollLeft : 0);
  const wasPainted = paintedRows;
  if (resetPaint === true || paintedRows === 0) {
    paintedRows = Math.min(ROW_BATCH, state.rows.length);
  }

  const canAppend = resetPaint !== true && wrap && wasPainted > 0 && paintedRows > wasPainted;
  if (canAppend) {
    const tbody = wrap.querySelector('tbody');
    if (tbody && state.rows.length > 0) {
      tbody.insertAdjacentHTML(
        'beforeend',
        state.rows.slice(wasPainted, paintedRows).map((row, i) => rowHtml(row, wasPainted + i)).join('')
      );
      bindLazyPaint(wrap);
      restoreScroll(wrap, keepTop, keepLeft);
      markOverflowCells();
      return;
    }
  }

  closeViewer();
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    host.innerHTML = '';
    host.appendChild(wrap);
  }
  let body;
  if (state.rows.length === 0) {
    body = '<tr><td class="row-num"></td><td colspan="' + state.columns.length + '" class="null">No rows</td></tr>';
  } else {
    body = state.rows.slice(0, paintedRows).map((row, r) => rowHtml(row, r)).join('');
  }
  wrap.innerHTML = '<table><thead><tr>' + headHtml() + '</tr></thead><tbody>' + body + '</tbody></table>';
  bindLazyPaint(wrap);
  restoreScroll(wrap, keepTop, keepLeft);
  markOverflowCells();
}

function currentScope() {
  return exportScope ? exportScope.value : 'table';
}

function currentFormat() {
  return exportFormat ? exportFormat.value : 'json';
}

function exportEnabled() {
  if (busy) return false;
  const scope = currentScope();
  if (scope === 'row') return selected.row >= 0;
  if (scope === 'cell') return selected.row >= 0 && selected.col >= 0;
  return true;
}

function setInfoOpen(open) {
  if (!infoPop || !btnInfo) return;
  infoPop.hidden = !open;
  btnInfo.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function setSqlOpen(open) {
  if (!sqlBox || !btnSqlToggle) return;
  sqlBox.classList.toggle('open', open);
  btnSqlToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  vscode.postMessage({ type: 'setSqlOpen', on: !!open });
}

function updateToolbar() {
  const editable = !!(state.edit && state.edit.editable);
  const meta = selected.col >= 0 ? colMeta(selected.col) : {};
  if (btnNull) btnNull.disabled = busy || !editable || selected.row < 0 || !meta.canSetNull;
  if (btnDelete) btnDelete.disabled = busy || !editable || selected.row < 0;
  if (btnDuplicate) {
    btnDuplicate.disabled = busy || !editable || selected.row < 0 || !state.edit.canDuplicate;
  }
  if (btnRename) btnRename.disabled = busy || !editable || selected.col < 0 || !meta.canRename;
  if (btnDetailed) btnDetailed.setAttribute('aria-pressed', detailed ? 'true' : 'false');
  if (btnRefresh) btnRefresh.disabled = busy;
  if (btnRunSql) btnRunSql.disabled = busy;
  if (exportScope) {
    const optRow = exportScope.querySelector('option[value="row"]');
    const optCell = exportScope.querySelector('option[value="cell"]');
    if (optRow) optRow.disabled = selected.row < 0;
    if (optCell) optCell.disabled = selected.row < 0 || selected.col < 0;
    if (currentScope() === 'row' && selected.row < 0) exportScope.value = 'table';
    if (currentScope() === 'cell' && (selected.row < 0 || selected.col < 0)) exportScope.value = 'table';
  }
  const canExport = exportEnabled();
  if (btnCopy) btnCopy.disabled = !canExport;
  if (btnSave) btnSave.disabled = !canExport;
  if (btnPrev) btnPrev.disabled = busy || !(state.pager && state.pager.hasPrev);
  if (btnNext) btnNext.disabled = busy || !(state.pager && state.pager.hasMore);
  if (pageSize) pageSize.disabled = busy;
}

function postExport(kind, scope) {
  vscode.postMessage({
    type: kind,
    scope: scope || currentScope(),
    format: currentFormat(),
    row: selected.row,
    col: selected.col
  });
}

let ctxJustOpened = false;

function hideCtxMenu() {
  if (ctxMenu) ctxMenu.hidden = true;
}

function showCtxMenu(x, y) {
  if (!ctxMenu) return;
  const editable = !!(state.edit && state.edit.editable);
  const meta = selected.col >= 0 ? colMeta(selected.col) : {};
  const byAct = (act) => ctxMenu.querySelector('[data-act="' + act + '"]');
  const btnEdit = byAct('edit');
  const btnSetNull = byAct('null');
  const btnDup = byAct('duplicate');
  const btnDel = byAct('delete');
  const btnCopyCell = byAct('copyCell');
  const btnCopyRow = byAct('copyRow');
  const btnViewCell = byAct('viewCell');
  const btnViewRow = byAct('viewRow');
  if (btnEdit) btnEdit.disabled = busy || !editable || !meta.canEdit;
  if (btnSetNull) btnSetNull.disabled = busy || !editable || !meta.canSetNull;
  if (btnDup) btnDup.disabled = busy || !editable || !state.edit.canDuplicate;
  if (btnDel) btnDel.disabled = busy || !editable;
  if (btnCopyCell) btnCopyCell.disabled = busy || selected.col < 0;
  if (btnCopyRow) btnCopyRow.disabled = busy;
  if (btnViewCell) btnViewCell.disabled = busy || selected.col < 0;
  if (btnViewRow) btnViewRow.disabled = busy;
  ctxMenu.hidden = false;
  const pad = 8;
  const nextX = Math.min(x, window.innerWidth - ctxMenu.offsetWidth - pad);
  const nextY = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - pad);
  ctxMenu.style.left = Math.max(pad, nextX) + 'px';
  ctxMenu.style.top = Math.max(pad, nextY) + 'px';
  ctxJustOpened = true;
  setTimeout(() => { ctxJustOpened = false; }, 0);
}

function setStatus(message, ok) {
  if (!liveStatus) return;
  if (!message) {
    liveStatus.hidden = true;
    liveStatus.textContent = '';
    return;
  }
  liveStatus.hidden = false;
  liveStatus.textContent = message;
  liveStatus.className = 'status ' + (ok ? 'ok' : 'error');
}

function applySelection() {
  if (!host) return;
  host.querySelectorAll('td.selected, th.selected, tr.selected').forEach((el) => {
    el.classList.remove('selected');
  });
  if (selected.col >= 0) {
    const th = host.querySelector('th[data-col="' + selected.col + '"]');
    if (th) th.classList.add('selected');
  }
  if (selected.row >= 0) {
    const first = host.querySelector('td[data-row="' + selected.row + '"]');
    if (first && first.parentElement) first.parentElement.classList.add('selected');
    if (selected.col >= 0) {
      const td = host.querySelector(
        'td[data-row="' + selected.row + '"][data-col="' + selected.col + '"]'
      );
      if (td) td.classList.add('selected');
    }
  }
}

function selectCell(row, col) {
  selected = { row: row, col: col };
  applySelection();
  updateToolbar();
}

function startEdit(td, row, col) {
  const meta = colMeta(col);
  if (busy || editing) return;
  if (!state.edit || !state.edit.editable) {
    setStatus((state.edit && state.edit.reason) || 'This result is read only.', false);
    return;
  }
  if (!meta.canEdit) {
    if (meta.isPrimaryKey) setStatus('The primary key cannot be edited.', false);
    else if (meta.isIdentity) setStatus('Identity columns cannot be edited.', false);
    else if (meta.isComputed) setStatus('Computed columns cannot be edited.', false);
    else setStatus('This cell cannot be edited.', false);
    return;
  }
  setStatus('', true);
  closeViewer();
  const original = state.rows[row][col];
  const typeName = meta.typeName || meta.typeDisplay;
  const raw = original === NULL_DISPLAY ? '' : original;
  const inputType = dateInputType(typeName, raw);
  const input = document.createElement('input');
  input.type = inputType;
  if (inputType === 'datetime-local' || inputType === 'time') input.step = '1';
  input.value = sqlToInput(inputType, raw);
  editing = true;
  td.classList.add('editing');
  td.textContent = '';
  td.appendChild(input);
  input.focus({ preventScroll: true });
  if (inputType === 'text') input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    editing = false;
    const next = inputType === 'text' ? input.value : inputToSql(inputType, input.value);
    renderTable();
    if (save && next !== original && !(original === NULL_DISPLAY && next === '')) {
      vscode.postMessage({ type: 'editCell', row: row, col: col, value: next });
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  if (inputType !== 'text') {
    input.addEventListener('change', () => finish(true));
  }
  input.addEventListener('blur', () => finish(true));
}

if (host) {
  host.addEventListener('click', (event) => {
    if (event.target.closest('input')) return;
    const expandBtn = event.target.closest('[data-view]');
    if (expandBtn) {
      const td = expandBtn.closest('td');
      if (!td || !td.hasAttribute('data-row')) return;
      const row = Number(td.getAttribute('data-row'));
      const col = Number(td.getAttribute('data-col'));
      selectCell(row, col);
      openViewer('cell', row, col);
      return;
    }
    const th = event.target.closest('th');
    if (th && host.contains(th)) {
      if (!th.hasAttribute('data-col')) return;
      const col = Number(th.getAttribute('data-col'));
      selectCell(-1, col);
      vscode.postMessage({ type: 'sortBy', col: col });
      return;
    }
    const td = event.target.closest('td');
    if (!td || !td.hasAttribute('data-row')) return;
    const row = Number(td.getAttribute('data-row'));
    const col = Number(td.getAttribute('data-col'));
    if (selected.row === row && selected.col === col) {
      startEdit(td, row, col);
      return;
    }
    selectCell(row, col);
  });
  host.addEventListener('contextmenu', (event) => {
    const td = event.target.closest('td');
    if (!td || !td.hasAttribute('data-row')) return;
    event.preventDefault();
    if (editing) return;
    selectCell(Number(td.getAttribute('data-row')), Number(td.getAttribute('data-col')));
    showCtxMenu(event.clientX, event.clientY);
  });
  host.addEventListener('dblclick', (event) => {
    if (event.target.closest('input')) return;
    if (event.target.closest('[data-view]')) return;
    const td = event.target.closest('td');
    if (!td || !td.hasAttribute('data-row')) return;
    startEdit(td, Number(td.getAttribute('data-row')), Number(td.getAttribute('data-col')));
  });
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    if (sqlBox && sqlBox.contains(event.target)) {
      event.preventDefault();
      runEditorSql();
      return;
    }
  }
  if (event.key === 'Escape' && viewer.open) {
    closeViewer();
    return;
  }
  if (event.key === 'Escape' && ctxMenu && !ctxMenu.hidden) {
    hideCtxMenu();
    return;
  }
  if (event.key === 'Escape' && infoPop && !infoPop.hidden) {
    setInfoOpen(false);
    return;
  }
  if (event.target && event.target.classList && event.target.classList.contains('param-input')) {
    return;
  }
  if (editing || busy || viewer.open) return;
  if (event.key === 'Enter' && selected.row >= 0 && selected.col >= 0) {
    const td = host && host.querySelector('td.selected');
    if (td) startEdit(td, selected.row, selected.col);
  }
  if (event.key === 'Delete' && selected.row >= 0 && btnDelete && !btnDelete.disabled) {
    vscode.postMessage({ type: 'deleteRow', row: selected.row });
  }
});

if (btnInfo && infoPop) {
  btnInfo.addEventListener('click', (event) => {
    event.stopPropagation();
    setInfoOpen(infoPop.hidden);
  });
  document.addEventListener('click', (event) => {
    if (infoPop.hidden) return;
    const wrap = btnInfo.closest('.info-wrap');
    if (wrap && wrap.contains(event.target)) return;
    setInfoOpen(false);
  });
}
if (btnSqlToggle) {
  btnSqlToggle.addEventListener('click', () => {
    setSqlOpen(!sqlBox || !sqlBox.classList.contains('open'));
  });
}
if (btnCopySql) {
  btnCopySql.addEventListener('click', (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: 'copySql' });
  });
}
if (btnRunSql) {
  btnRunSql.addEventListener('click', (event) => {
    event.stopPropagation();
    runEditorSql();
  });
}
if (btnEditSql) {
  btnEditSql.addEventListener('click', (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: 'editInEditor' });
  });
}
if (paramList) {
  paramList.addEventListener('input', () => {
    vscode.postMessage({ type: 'setParams', params: readParamValues() });
  });
}
if (btnNull) btnNull.addEventListener('click', () => {
  vscode.postMessage({ type: 'setNull', row: selected.row, col: selected.col });
});
if (btnDelete) btnDelete.addEventListener('click', () => {
  vscode.postMessage({ type: 'deleteRow', row: selected.row });
});
if (btnDuplicate) btnDuplicate.addEventListener('click', () => {
  vscode.postMessage({ type: 'duplicateRow', row: selected.row });
});
if (btnDetailed) {
  btnDetailed.addEventListener('click', () => {
    detailed = !detailed;
    document.body.classList.toggle('detailed', detailed);
    btnDetailed.setAttribute('aria-pressed', detailed ? 'true' : 'false');
    vscode.postMessage({ type: 'setDetailed', on: detailed });
  });
}
if (btnRename) btnRename.addEventListener('click', () => {
  vscode.postMessage({ type: 'renameColumn', col: selected.col });
});
if (ctxMenu) {
  ctxMenu.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute('data-act');
    hideCtxMenu();
    if (act === 'edit') {
      const td = host && host.querySelector('td.selected');
      if (td) startEdit(td, selected.row, selected.col);
      return;
    }
    if (act === 'null') {
      vscode.postMessage({ type: 'setNull', row: selected.row, col: selected.col });
      return;
    }
    if (act === 'duplicate') {
      vscode.postMessage({ type: 'duplicateRow', row: selected.row });
      return;
    }
    if (act === 'delete') {
      vscode.postMessage({ type: 'deleteRow', row: selected.row });
      return;
    }
    if (act === 'viewCell') {
      openViewer('cell', selected.row, selected.col);
      return;
    }
    if (act === 'viewRow') {
      openViewer('row', selected.row, selected.col);
      return;
    }
    if (act === 'copyCell') {
      postExport('copyExport', 'cell');
      return;
    }
    if (act === 'copyRow') {
      postExport('copyExport', 'row');
      return;
    }
  });
}
document.addEventListener('click', (event) => {
  if (ctxJustOpened || !ctxMenu || ctxMenu.hidden) return;
  if (ctxMenu.contains(event.target)) return;
  hideCtxMenu();
});
document.addEventListener('scroll', (event) => {
  hideCtxMenu();
  if (event.target && event.target.classList && event.target.classList.contains('table-wrap')) {
    writeSavedScroll(event.target);
  }
}, true);
if (viewerClose) viewerClose.addEventListener('click', closeViewer);
if (viewerToggle) {
  viewerToggle.addEventListener('click', () => {
    if (!viewer.open) return;
    viewer.mode = viewer.mode === 'cell' ? 'row' : 'cell';
    renderViewer();
  });
}
if (viewerCopy) {
  viewerCopy.addEventListener('click', () => {
    if (!viewer.open) return;
    postExport('copyExport', viewer.mode);
  });
}
if (cellViewer) {
  cellViewer.addEventListener('click', (event) => {
    if (event.target === cellViewer) closeViewer();
  });
}
if (btnRefresh) btnRefresh.addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});
if (exportScope) exportScope.addEventListener('change', updateToolbar);
if (btnCopy) btnCopy.addEventListener('click', () => postExport('copyExport'));
if (btnSave) btnSave.addEventListener('click', () => postExport('saveExport'));
if (btnPrev) btnPrev.addEventListener('click', () => {
  vscode.postMessage({ type: 'page', delta: -1 });
});
if (btnNext) btnNext.addEventListener('click', () => {
  vscode.postMessage({ type: 'page', delta: 1 });
});
if (pageSize) pageSize.addEventListener('change', () => {
  if (applyingView) return;
  vscode.postMessage({ type: 'pageSize', pageSize: Number(pageSize.value) });
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'busy') {
    busy = !!msg.busy;
    document.body.classList.toggle('busy', busy);
    updateToolbar();
    return;
  }
  if (msg.type === 'status') {
    setStatus(msg.message, msg.ok);
    return;
  }
    if (msg.type === 'sqlDraft') {
      applySqlDraft(msg);
      return;
    }
    if (msg.type === 'setResult') {
      applySetResult(msg);
      return;
    }
    if (msg.type === 'applied') {
    if (msg.action === 'setNull' || msg.action === 'editCell') {
      if (state.rows[msg.row]) state.rows[msg.row][msg.col] = msg.value;
    } else if (msg.action === 'deleteRow') {
      state.rows.splice(msg.row, 1);
      if (selected.row === msg.row) selected.row = -1;
      else if (selected.row > msg.row) selected.row -= 1;
      paintedRows = Math.min(paintedRows, state.rows.length);
    } else if (msg.action === 'renameColumn') {
      state.columns[msg.col] = msg.displayName;
      if (state.edit.columns[msg.col]) {
        state.edit.columns[msg.col].displayName = msg.displayName;
        state.edit.columns[msg.col].sourceColumn = msg.sourceColumn;
      }
    }
    renderTable(false);
    updateToolbar();
  }
});

  const boot = window.__BISQL_BOOTSTRAP__;
  if (boot) applySetResult(boot);
  else {
    renderTable();
    updateToolbar();
  }
  vscode.postMessage({ type: 'ready' });
})();
