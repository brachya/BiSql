  const vscode = acquireVsCodeApi();
  const els = {
    subtitle: document.getElementById('subtitle'),
    metrics: document.getElementById('metrics'),
    dbChips: document.getElementById('dbChips'),
    filters: document.getElementById('filters'),
    body: document.getElementById('body'),
    list: document.getElementById('list'),
    detail: document.getElementById('detail'),
    empty: document.getElementById('empty'),
    search: document.getElementById('search'),
    kindAll: document.getElementById('kindAll'),
    kindTables: document.getElementById('kindTables'),
    kindViews: document.getElementById('kindViews'),
    refreshBtn: document.getElementById('refreshBtn'),
    loginBtn: document.getElementById('loginBtn'),
    note: document.getElementById('note'),
    modeBrowse: document.getElementById('modeBrowse'),
    modeCompare: document.getElementById('modeCompare'),
    compareBar: document.getElementById('compareBar'),
    leftDb: document.getElementById('leftDb'),
    rightDb: document.getElementById('rightDb'),
    swapBtn: document.getElementById('swapBtn'),
    copyReportBtn: document.getElementById('copyReportBtn'),
    summary: document.getElementById('summary'),
    kindSeg: document.getElementById('kindSeg'),
    depthSeg: document.getElementById('depthSeg'),
    depthTable: document.getElementById('depthTable'),
    depthColumn: document.getElementById('depthColumn'),
    depthType: document.getElementById('depthType'),
    depthSize: document.getElementById('depthSize'),
    diffSeg: document.getElementById('diffSeg'),
    diffAll: document.getElementById('diffAll'),
    diffDiffs: document.getElementById('diffDiffs'),
    diffChanged: document.getElementById('diffChanged'),
    diffLeft: document.getElementById('diffLeft'),
    diffRight: document.getElementById('diffRight')
  };

  let tables = [];
  let engine = 'mssql';
  let defaultDb = '';
  let lastInit = null;
  let selectedKey = '';
  let dbFilter = '';
  let kind = 'all';
  let query = '';
  let noteTimer;
  let mode = 'browse';
  let diff = null;
  let diffFilter = 'diff';
  let depth = 'size';
  let selectedDiffKey = '';

  const DEPTH_RANK = { table: 1, column: 2, type: 3, size: 4, flags: 4, none: 9 };

  function depthRank(level) {
    return DEPTH_RANK[level] || 9;
  }

  function isChangeVisible(level) {
    return depthRank(level) <= depthRank(depth);
  }

  function effectiveStatus(table) {
    if (table.status === 'leftOnly' || table.status === 'rightOnly' || table.status === 'identical') {
      return table.status;
    }
    return isChangeVisible(table.changeLevel) ? 'changed' : 'identical';
  }

  function setKind(next) {
    kind = next;
    els.kindAll.setAttribute('aria-pressed', next === 'all' ? 'true' : 'false');
    els.kindTables.setAttribute('aria-pressed', next === 'tables' ? 'true' : 'false');
    els.kindViews.setAttribute('aria-pressed', next === 'views' ? 'true' : 'false');
    renderList();
  }

  els.kindAll.addEventListener('click', () => setKind('all'));
  els.kindTables.addEventListener('click', () => setKind('tables'));
  els.kindViews.addEventListener('click', () => setKind('views'));
  els.search.addEventListener('input', () => {
    query = els.search.value.trim().toLowerCase();
    if (mode === 'compare') renderCompare();
    else renderList();
  });
  els.refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  els.loginBtn.addEventListener('click', () => vscode.postMessage({ type: 'openLogin' }));
  els.modeBrowse.addEventListener('click', () => setMode('browse'));
  els.modeCompare.addEventListener('click', () => setMode('compare'));
  els.swapBtn.addEventListener('click', () => {
    const left = els.leftDb.value;
    els.leftDb.value = els.rightDb.value;
    els.rightDb.value = left;
    requestCompare();
  });
  els.leftDb.addEventListener('change', requestCompare);
  els.rightDb.addEventListener('change', requestCompare);
  els.copyReportBtn.addEventListener('click', () => {
    const left = els.leftDb.value;
    const right = els.rightDb.value;
    if (!left || !right || left === right) return;
    vscode.postMessage({
      type: 'copyReport',
      left,
      right,
      filter: diffFilter,
      query: els.search.value.trim(),
      depth
    });
  });
  els.diffAll.addEventListener('click', () => setDiffFilter('all'));
  els.diffDiffs.addEventListener('click', () => setDiffFilter('diff'));
  els.diffChanged.addEventListener('click', () => setDiffFilter('changed'));
  els.diffLeft.addEventListener('click', () => setDiffFilter('left'));
  els.diffRight.addEventListener('click', () => setDiffFilter('right'));
  els.depthTable.addEventListener('click', () => setDepth('table'));
  els.depthColumn.addEventListener('click', () => setDepth('column'));
  els.depthType.addEventListener('click', () => setDepth('type'));
  els.depthSize.addEventListener('click', () => setDepth('size'));

  function setMode(next) {
    mode = next;
    els.modeBrowse.setAttribute('aria-pressed', next === 'browse' ? 'true' : 'false');
    els.modeCompare.setAttribute('aria-pressed', next === 'compare' ? 'true' : 'false');
    els.compareBar.classList.toggle('hidden', next !== 'compare');
    els.summary.classList.toggle('hidden', next !== 'compare');
    els.kindSeg.classList.toggle('hidden', next === 'compare');
    els.depthSeg.classList.toggle('hidden', next !== 'compare');
    els.diffSeg.classList.toggle('hidden', next !== 'compare');
    els.dbChips.classList.toggle('hidden', next === 'compare');
    els.metrics.classList.toggle('hidden', next === 'compare');
    els.search.placeholder = next === 'compare' ? 'Search compared tables' : 'Search tables or columns';
    if (next === 'compare') {
      els.subtitle.textContent = 'Table = missing tables. Columns = missing columns. Type = varchar vs int. Size = varchar(8) vs varchar(7).';
      fillDbSelects();
      requestCompare();
    } else if (lastInit) {
      renderOverview(lastInit);
      renderList();
    }
  }

  function setDiffFilter(next) {
    diffFilter = next;
    els.diffAll.setAttribute('aria-pressed', next === 'all' ? 'true' : 'false');
    els.diffDiffs.setAttribute('aria-pressed', next === 'diff' ? 'true' : 'false');
    els.diffChanged.setAttribute('aria-pressed', next === 'changed' ? 'true' : 'false');
    els.diffLeft.setAttribute('aria-pressed', next === 'left' ? 'true' : 'false');
    els.diffRight.setAttribute('aria-pressed', next === 'right' ? 'true' : 'false');
    renderCompare();
  }

  function setDepth(next) {
    depth = next;
    els.depthTable.setAttribute('aria-pressed', next === 'table' ? 'true' : 'false');
    els.depthColumn.setAttribute('aria-pressed', next === 'column' ? 'true' : 'false');
    els.depthType.setAttribute('aria-pressed', next === 'type' ? 'true' : 'false');
    els.depthSize.setAttribute('aria-pressed', next === 'size' ? 'true' : 'false');
    renderCompare();
  }

  function dbNames() {
    return dbCounts().map((entry) => entry[0]);
  }

  function fillDbSelects() {
    const names = dbNames();
    const keepLeft = els.leftDb.value;
    const keepRight = els.rightDb.value;
    els.leftDb.replaceChildren();
    els.rightDb.replaceChildren();
    for (const name of names) {
      els.leftDb.appendChild(new Option(name, name));
      els.rightDb.appendChild(new Option(name, name));
    }
    const leftPick = names.find((name) => name === keepLeft)
      || names.find((name) => name.toLowerCase() === defaultDb.toLowerCase())
      || names[0]
      || '';
    const rightPick = names.find((name) => name === keepRight && name !== leftPick)
      || names.find((name) => name !== leftPick)
      || names[0]
      || '';
    els.leftDb.value = leftPick;
    els.rightDb.value = rightPick;
    els.copyReportBtn.disabled = names.length < 2;
    els.swapBtn.disabled = names.length < 2;
  }

  function requestCompare() {
    if (mode !== 'compare') return;
    const left = els.leftDb.value;
    const right = els.rightDb.value;
    if (!left || !right || left === right) {
      diff = null;
      renderCompare();
      return;
    }
    vscode.postMessage({ type: 'compare', left, right });
  }

  function showNote(text) {
    els.note.textContent = text;
    els.note.classList.add('show');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => els.note.classList.remove('show'), 1600);
  }

  function relativeTime(ms) {
    if (!ms) return 'never';
    const delta = Date.now() - ms;
    const minutes = Math.round(delta / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + ' hr ago';
    return Math.round(hours / 24) + ' days ago';
  }

  function displayName(table) {
    return engine === 'mysql' ? table.name : table.schema + '.' + table.name;
  }

  function kindIconSvg(isView) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'kind-icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (isView) {
      svg.innerHTML =
        '<rect x="1.8" y="2.2" width="9.6" height="8.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
        '<rect x="4.6" y="5.4" width="9.6" height="8.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/>';
    } else {
      svg.innerHTML =
        '<rect x="1.4" y="2.4" width="13.2" height="11.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
        '<path d="M1.4 5.8h13.2M5.8 5.8v7.8M10.2 5.8v7.8M1.4 9.3h13.2" fill="none" stroke="currentColor" stroke-width="1.1"/>';
    }
    return svg;
  }

  function kindIcon(isView) {
    const wrap = document.createElement('span');
    wrap.className = 'kind-wrap';
    wrap.title = isView ? 'View' : 'Table';
    wrap.appendChild(kindIconSvg(isView));
    return wrap;
  }

  function kindIcons(leftView, rightView, kindChanged) {
    if (kindChanged && leftView !== rightView) {
      const wrap = document.createElement('span');
      wrap.className = 'kind-wrap';
      wrap.title = 'Table and view';
      wrap.appendChild(kindIconSvg(false));
      wrap.appendChild(kindIconSvg(true));
      return wrap;
    }
    return kindIcon(!!(rightView || leftView));
  }

  function previewQualified(name) {
    if (!name) return;
    vscode.postMessage({ type: 'preview', qualifiedName: name });
  }

  function qualifiedForDiff(tableDiff) {
    if (!diff) return '';
    const db = tableDiff.left ? diff.left : diff.right;
    return (tables.find((t) => {
      if (t.database.toLowerCase() !== db.toLowerCase()) return false;
      const match = engine === 'mysql' ? t.name : t.schema + '.' + t.name;
      return match.toLowerCase() === tableDiff.key;
    }) || {}).qualifiedName || '';
  }

  function groupKey(table) {
    return engine === 'postgres' ? table.schema : table.database;
  }

  function dbCounts() {
    const map = new Map();
    for (const table of tables) {
      const key = groupKey(table);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function matches(table) {
    if (dbFilter && groupKey(table).toLowerCase() !== dbFilter) return false;
    if (kind === 'tables' && table.isView) return false;
    if (kind === 'views' && !table.isView) return false;
    if (!query) return true;
    if (table.name.toLowerCase().includes(query)) return true;
    if (table.qualifiedName.toLowerCase().includes(query)) return true;
    return table.columns.some((col) => col.name.toLowerCase().includes(query));
  }

  function filtered() {
    return tables.filter(matches);
  }

  function metric(parent, n, label) {
    const wrap = document.createElement('div');
    wrap.className = 'metric';
    const num = document.createElement('div');
    num.className = 'n';
    num.textContent = String(n);
    const lab = document.createElement('span');
    lab.className = 'l';
    lab.textContent = label;
    wrap.appendChild(num);
    wrap.appendChild(lab);
    parent.appendChild(wrap);
  }

  function renderOverview(msg) {
    const views = tables.filter((t) => t.isView).length;
    const tableCount = tables.length - views;
    const cols = tables.reduce((sum, t) => sum + t.columns.length, 0);
    const dbs = dbCounts();
    const groupNoun =
      engine === 'postgres'
        ? (dbs.length === 1 ? 'schema' : 'schemas')
        : (dbs.length === 1 ? 'database' : 'databases');
    els.metrics.replaceChildren();
    metric(els.metrics, tableCount, 'tables');
    metric(els.metrics, views, 'views');
    metric(els.metrics, dbs.length, groupNoun);
    metric(els.metrics, cols, 'columns');

    const engineLabel =
      msg.engine === 'mysql' ? 'MySQL' : msg.engine === 'postgres' ? 'PostgreSQL' : 'SQL Server';
    const host = msg.server || 'not connected';
    const age = relativeTime(msg.fetchedAt);
    const stale = msg.stale ? 'disk cache' : 'live fetch';
    els.subtitle.textContent = engineLabel + ' · ' + host + ' · ' + stale + ' · ' + age;

    els.dbChips.replaceChildren();
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip';
    all.textContent = engine === 'postgres' ? 'All schemas' : 'All databases';
    all.setAttribute('aria-pressed', dbFilter ? 'false' : 'true');
    all.addEventListener('click', () => {
      dbFilter = '';
      renderOverview(msg);
      renderList();
    });
    els.dbChips.appendChild(all);
    for (const [name, count] of dbs) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = name + ' · ' + count;
      chip.setAttribute('aria-pressed', dbFilter === name.toLowerCase() ? 'true' : 'false');
      chip.addEventListener('click', () => {
        dbFilter = name.toLowerCase();
        renderOverview(msg);
        renderList();
      });
      els.dbChips.appendChild(chip);
    }
  }

  function renderEmptyCache() {
    els.filters.classList.add('hidden');
    els.body.classList.add('hidden');
    els.compareBar.classList.add('hidden');
    els.summary.classList.add('hidden');
    els.depthSeg.classList.add('hidden');
    els.empty.classList.remove('hidden');
    els.empty.replaceChildren();
    const p = document.createElement('p');
    p.textContent = 'No schema in cache yet. Connect once to load tables. After that, this page works offline.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = 'Open login';
    btn.addEventListener('click', () => vscode.postMessage({ type: 'openLogin' }));
    els.empty.appendChild(p);
    els.empty.appendChild(btn);
  }

  function renderList() {
    const rows = filtered();
    els.list.replaceChildren();
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '16px';
      p.textContent = 'No tables match.';
      els.list.appendChild(p);
      if (!rows.some((t) => t.qualifiedName === selectedKey)) {
        renderDetail(undefined);
      }
      return;
    }
    if (!rows.some((t) => t.qualifiedName === selectedKey)) {
      selectedKey = rows[0].qualifiedName;
    }
    let lastGroup = '';
    for (const table of rows) {
      const groupName = table.database;
      if (groupName !== lastGroup) {
        lastGroup = groupName;
        const g = document.createElement('div');
        g.className = 'group';
        g.textContent = groupName;
        els.list.appendChild(g);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item';
      btn.dataset.key = table.qualifiedName;
      btn.setAttribute('aria-selected', table.qualifiedName === selectedKey ? 'true' : 'false');
      btn.appendChild(kindIcon(table.isView));
      btn.title = 'Double-click to preview rows';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = displayName(table);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = String(table.columns.length);
      btn.appendChild(name);
      btn.appendChild(meta);
      btn.addEventListener('click', () => {
        selectedKey = table.qualifiedName;
        for (const el of els.list.querySelectorAll('.item')) {
          el.setAttribute('aria-selected', el.dataset.key === selectedKey ? 'true' : 'false');
        }
        renderDetail(table);
      });
      btn.addEventListener('dblclick', () => previewQualified(table.qualifiedName));
      els.list.appendChild(btn);
    }
    renderDetail(tables.find((t) => t.qualifiedName === selectedKey));
  }

  function renderDetail(table) {
    els.detail.replaceChildren();
    if (!table) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Select a table.';
      els.detail.appendChild(p);
      return;
    }
    const head = document.createElement('div');
    head.className = 'detail-head';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title-row';
    title.appendChild(kindIcon(table.isView));
    title.title = 'Double-click to preview rows';
    title.addEventListener('dblclick', () => previewQualified(table.qualifiedName));
    const h2 = document.createElement('h2');
    h2.textContent = displayName(table);
    title.appendChild(h2);
    const q = document.createElement('p');
    q.className = 'qualified';
    q.textContent = table.qualifiedName;
    left.appendChild(title);
    left.appendChild(q);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary';
    copy.textContent = 'Copy name';
    copy.addEventListener('click', () => {
      vscode.postMessage({ type: 'copy', text: table.qualifiedName });
    });
    head.appendChild(left);
    head.appendChild(copy);
    els.detail.appendChild(head);

    const flags = document.createElement('p');
    flags.className = 'flags';
    const pk = table.columns.filter((c) => c.isPrimaryKey).length;
    flags.textContent =
      (table.isView ? 'View' : 'Table') +
      ' · ' + table.columns.length + ' columns' +
      (pk ? ' · ' + pk + ' primary key' + (pk === 1 ? '' : 's') : '');
    els.detail.appendChild(flags);

    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['', 'Column', 'Type', 'Null']) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const col of table.columns) {
      const tr = document.createElement('tr');
      const pkCell = document.createElement('td');
      pkCell.className = 'pk';
      pkCell.textContent = col.isPrimaryKey ? 'PK' : '';
      const name = document.createElement('td');
      name.className = 'code';
      name.textContent = col.name;
      const extra = [];
      if (col.isIdentity) extra.push('identity');
      if (col.isComputed) extra.push('computed');
      if (extra.length) {
        const hint = document.createElement('div');
        hint.className = 'muted';
        hint.textContent = extra.join(' · ');
        name.appendChild(hint);
      }
      const type = document.createElement('td');
      type.className = 'code muted';
      type.textContent = col.typeDisplay;
      const nul = document.createElement('td');
      nul.className = col.isNullable ? 'muted' : '';
      nul.textContent = col.isNullable ? 'YES' : 'NO';
      tr.appendChild(pkCell);
      tr.appendChild(name);
      tr.appendChild(type);
      tr.appendChild(nul);
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    els.detail.appendChild(tbl);
  }

  function statusLabel(status) {
    if (status === 'identical') return 'same';
    if (status === 'changed') return 'changed';
    if (status === 'leftOnly') return 'only left';
    return 'only right';
  }

  function changeLevelLabel(level) {
    if (level === 'table') return 'table';
    if (level === 'column') return 'columns';
    if (level === 'type') return 'type';
    if (level === 'flags') return 'flags';
    return 'size';
  }

  function compareTag(table) {
    const status = effectiveStatus(table);
    if (status !== 'changed') return statusLabel(status);
    return changeLevelLabel(table.changeLevel);
  }

  function columnLine(col) {
    if (!col) return '—';
    const bits = [col.typeDisplay];
    if (col.isPrimaryKey) bits.push('PK');
    bits.push(col.isNullable ? 'NULL' : 'NOT NULL');
    if (col.isIdentity) bits.push('identity');
    if (col.isComputed) bits.push('computed');
    return bits.join(' · ');
  }

  function diffMatches(table) {
    const status = effectiveStatus(table);
    if (diffFilter === 'diff' && status === 'identical') return false;
    if (diffFilter === 'changed' && status !== 'changed') return false;
    if (diffFilter === 'left' && status !== 'leftOnly') return false;
    if (diffFilter === 'right' && status !== 'rightOnly') return false;
    if (diffFilter === 'identical' && status !== 'identical') return false;
    if (!query) return true;
    if (table.displayName.toLowerCase().includes(query)) return true;
    return table.columns.some((col) => col.name.toLowerCase().includes(query));
  }

  function countsAtDepth() {
    const counts = { identical: 0, changed: 0, leftOnly: 0, rightOnly: 0 };
    if (!diff) return counts;
    for (const table of diff.tables) {
      counts[effectiveStatus(table)] += 1;
    }
    return counts;
  }

  function renderSummary() {
    els.summary.replaceChildren();
    if (!diff) return;
    const counts = countsAtDepth();
    const items = [
      ['all', String(diff.tables.length), 'objects'],
      ['changed', String(counts.changed), 'different'],
      ['left', String(counts.leftOnly), 'only left'],
      ['right', String(counts.rightOnly), 'only right'],
      ['diff', String(counts.changed + counts.leftOnly + counts.rightOnly), 'differences'],
      ['identical', String(counts.identical), 'identical']
    ];
    for (const [key, n, label] of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', diffFilter === key ? 'true' : 'false');
      const num = document.createElement('span');
      num.className = 'n';
      num.textContent = n;
      const lab = document.createElement('span');
      lab.className = 'l';
      lab.textContent = label;
      btn.appendChild(num);
      btn.appendChild(lab);
      btn.addEventListener('click', () => setDiffFilter(key));
      els.summary.appendChild(btn);
    }
  }

  function renderCompare() {
    renderSummary();
    els.list.replaceChildren();
    const names = dbNames();
    if (names.length < 2) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '16px';
      p.textContent = 'Load at least two databases in Login, then refresh.';
      els.list.appendChild(p);
      els.detail.replaceChildren();
      const d = document.createElement('p');
      d.className = 'muted';
      d.textContent = 'Compare needs two cached databases.';
      els.detail.appendChild(d);
      return;
    }
    if (!diff || els.leftDb.value === els.rightDb.value) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '16px';
      p.textContent = 'Pick two different databases.';
      els.list.appendChild(p);
      els.detail.replaceChildren();
      return;
    }
    const rows = diff.tables.filter(diffMatches);
    const groupOrder = ['leftOnly', 'rightOnly', 'table', 'column', 'type', 'size', 'flags', 'identical'];
    const labels = {
      leftOnly: 'Only in ' + diff.left,
      rightOnly: 'Only in ' + diff.right,
      table: 'Table / view',
      column: 'Columns',
      type: 'Type',
      size: 'Size',
      flags: 'Flags',
      identical: 'Identical'
    };
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '16px';
      p.textContent = 'No tables match.';
      els.list.appendChild(p);
      renderCompareDetail(undefined);
      return;
    }
    if (!rows.some((row) => row.key === selectedDiffKey)) {
      selectedDiffKey = rows[0].key;
    }
    function groupKey(table) {
      const status = effectiveStatus(table);
      if (status !== 'changed') return status;
      return table.changeLevel || 'size';
    }
    for (const key of groupOrder) {
      const groupRows = rows.filter((row) => groupKey(row) === key);
      if (groupRows.length === 0) continue;
      const g = document.createElement('div');
      g.className = 'group';
      g.textContent = labels[key] + ' · ' + groupRows.length;
      els.list.appendChild(g);
      for (const table of groupRows) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'item';
        btn.dataset.key = table.key;
        btn.setAttribute('aria-selected', table.key === selectedDiffKey ? 'true' : 'false');
        btn.appendChild(kindIcons(
          table.left && table.left.isView,
          table.right && table.right.isView,
          table.kindChanged
        ));
        btn.title = 'Double-click to preview rows';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = table.displayName;
        const meta = document.createElement('span');
        meta.className = 'meta tag';
        meta.textContent = compareTag(table);
        btn.appendChild(name);
        btn.appendChild(meta);
        btn.addEventListener('click', () => {
          selectedDiffKey = table.key;
          for (const el of els.list.querySelectorAll('.item')) {
            el.setAttribute('aria-selected', el.dataset.key === selectedDiffKey ? 'true' : 'false');
          }
          renderCompareDetail(table);
        });
        btn.addEventListener('dblclick', () => previewQualified(qualifiedForDiff(table)));
        els.list.appendChild(btn);
      }
    }
    renderCompareDetail(diff.tables.find((row) => row.key === selectedDiffKey));
  }

  function renderCompareDetail(table) {
    els.detail.replaceChildren();
    if (!diff || !table) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Select a table.';
      els.detail.appendChild(p);
      return;
    }
    const head = document.createElement('div');
    head.className = 'detail-head';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title-row';
    title.appendChild(kindIcons(
      table.left && table.left.isView,
      table.right && table.right.isView,
      table.kindChanged
    ));
    title.title = 'Double-click to preview rows';
    title.addEventListener('dblclick', () => previewQualified(qualifiedForDiff(table)));
    const h2 = document.createElement('h2');
    h2.textContent = table.displayName;
    title.appendChild(h2);
    const q = document.createElement('p');
    q.className = 'qualified';
    q.textContent = diff.left + '  →  ' + diff.right;
    left.appendChild(title);
    left.appendChild(q);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary';
    copy.textContent = 'Copy name';
    copy.addEventListener('click', () => {
      vscode.postMessage({ type: 'copy', text: table.displayName });
    });
    head.appendChild(left);
    head.appendChild(copy);
    els.detail.appendChild(head);

    const flags = document.createElement('p');
    flags.className = 'flags';
    const shownStatus = effectiveStatus(table);
    const parts = [shownStatus === 'changed' ? changeLevelLabel(table.changeLevel) : statusLabel(shownStatus)];
    if (table.kindChanged) {
      parts.push(
        (table.left && table.left.isView ? 'view' : 'table') +
        ' vs ' +
        (table.right && table.right.isView ? 'view' : 'table')
      );
    }
    if (table.left) parts.push(table.left.columnCount + ' cols left');
    if (table.right) parts.push(table.right.columnCount + ' cols right');
    flags.textContent = parts.join(' · ');
    els.detail.appendChild(flags);

    if (shownStatus === 'identical') {
      const p = document.createElement('p');
      p.className = 'muted';
      if (table.status === 'changed') {
        p.textContent = 'Same at this depth. Go deeper to see type or size changes.';
      } else {
        p.textContent = 'Same columns in both databases.';
      }
      els.detail.appendChild(p);
    }

    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['', 'Column', diff.left, diff.right]) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    const showAsDiff = shownStatus !== 'identical';
    const showCols = showAsDiff
      ? table.columns.filter((col) => col.status !== 'identical' && isChangeVisible(col.changeLevel))
      : table.columns;
    if (showCols.length === 0) {
      return;
    }
    for (const col of showCols) {
      const tr = document.createElement('tr');
      const colDiff = showAsDiff && isChangeVisible(col.changeLevel);
      if (colDiff && col.status === 'leftOnly') tr.className = 'diff-left';
      else if (colDiff && col.status === 'rightOnly') tr.className = 'diff-right';
      else if (colDiff && col.status === 'changed') tr.className = 'diff-changed';
      const mark = document.createElement('td');
      mark.className = 'mark';
      mark.textContent = !colDiff ? '' : col.status === 'leftOnly' ? '−' : col.status === 'rightOnly' ? '+' : col.status === 'changed' ? '~' : '';
      const name = document.createElement('td');
      name.className = 'code';
      name.textContent = col.name;
      if (colDiff && col.changes.length) {
        const hint = document.createElement('div');
        hint.className = 'muted';
        hint.textContent = col.changes.join(' · ');
        name.appendChild(hint);
      }
      const leftCell = document.createElement('td');
      leftCell.className = 'code' + (col.left ? '' : ' muted');
      leftCell.textContent = columnLine(col.left);
      const rightCell = document.createElement('td');
      rightCell.className = 'code' + (col.right ? '' : ' muted');
      rightCell.textContent = columnLine(col.right);
      tr.appendChild(mark);
      tr.appendChild(name);
      tr.appendChild(leftCell);
      tr.appendChild(rightCell);
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    els.detail.appendChild(tbl);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      engine = msg.engine;
      defaultDb = msg.database || '';
      lastInit = msg;
      tables = msg.tables || [];
      tables.sort((a, b) => {
        const db = a.database.localeCompare(b.database);
        if (db) return db;
        const schema = a.schema.localeCompare(b.schema);
        if (schema) return schema;
        return a.name.localeCompare(b.name);
      });
      if (tables.length === 0) {
        els.metrics.replaceChildren();
        els.dbChips.replaceChildren();
        renderEmptyCache();
        return;
      }
      els.empty.classList.add('hidden');
      els.filters.classList.remove('hidden');
      els.body.classList.remove('hidden');
      if (dbFilter && !tables.some((t) => groupKey(t).toLowerCase() === dbFilter)) {
        dbFilter = '';
      }
      if (mode === 'compare') {
        els.compareBar.classList.remove('hidden');
        els.summary.classList.remove('hidden');
        els.kindSeg.classList.add('hidden');
        els.depthSeg.classList.remove('hidden');
        els.diffSeg.classList.remove('hidden');
        els.dbChips.classList.add('hidden');
        els.metrics.classList.add('hidden');
        els.subtitle.textContent = 'Table = missing tables. Columns = missing columns. Type = varchar vs int. Size = varchar(8) vs varchar(7).';
        fillDbSelects();
        requestCompare();
      } else {
        renderOverview(msg);
        renderList();
      }
    } else if (msg.type === 'diff') {
      diff = msg.diff;
      renderCompare();
    } else if (msg.type === 'status') {
      els.refreshBtn.disabled = !!msg.busy;
      if (msg.message) showNote(msg.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
