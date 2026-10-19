  const vscode = (typeof globalThis !== 'undefined' && globalThis.bisqlWebview)
    ? globalThis.bisqlWebview.initPage()
    : acquireVsCodeApi();
  const engineLabelFn = (typeof globalThis !== 'undefined' && globalThis.bisqlWebview)
    ? globalThis.bisqlWebview.engineLabel
    : function (kind) { return kind; };
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
    sidebarBtn: document.getElementById('sidebarBtn'),
    note: document.getElementById('note'),
    modeBrowse: document.getElementById('modeBrowse'),
    modeMap: document.getElementById('modeMap'),
    modeCompare: document.getElementById('modeCompare'),
    compareBar: document.getElementById('compareBar'),
    leftDb: document.getElementById('leftDb'),
    rightDb: document.getElementById('rightDb'),
    swapBtn: document.getElementById('swapBtn'),
    copyReportBtn: document.getElementById('copyReportBtn'),
    summary: document.getElementById('summary'),
    kindSeg: document.getElementById('kindSeg'),
    mapSeg: document.getElementById('mapSeg'),
    mapConnectedBtn: document.getElementById('mapConnectedBtn'),
    mapFocusOnlyBtn: document.getElementById('mapFocusOnlyBtn'),
    mapFitBtn: document.getElementById('mapFitBtn'),
    mapZoomOutBtn: document.getElementById('mapZoomOutBtn'),
    mapZoomInBtn: document.getElementById('mapZoomInBtn'),
    mapResetBtn: document.getElementById('mapResetBtn'),
    mapView: document.getElementById('mapView'),
    mapStage: document.getElementById('mapStage'),
    mapWorld: document.getElementById('mapWorld'),
    mapEdges: document.getElementById('mapEdges'),
    mapNodes: document.getElementById('mapNodes'),
    mapInspector: document.getElementById('mapInspector'),
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
  let relationExpandLeft = false;
  let relationExpandRight = false;
  let mapConnectedOnly = true;
  let mapFocusOnly = false;
  let mapPanX = 32;
  let mapPanY = 32;
  let mapZoom = 1;
  let mapLayoutDb = '';
  const mapPositions = new Map();
  const mapExpandedCards = new Set();

  const RELATION_SIDE_CAP = 8;
  const MAP_CARD_WIDTH = 236;
  const MAP_COL_LIMIT = 6;
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
    else if (mode === 'map') {
      if (!query) {
        selectedKey = '';
      } else {
        const hit = mapSearchHit();
        if (hit) {
          const shown = mapVisibleTables().some(
            (table) => table.qualifiedName.toLowerCase() === hit.qualifiedName.toLowerCase()
          );
          if (!shown && mapConnectedOnly) {
            mapConnectedOnly = false;
            if (els.mapConnectedBtn) els.mapConnectedBtn.setAttribute('aria-pressed', 'false');
            mapLayoutDb = '';
          }
          selectedKey = hit.qualifiedName;
        }
      }
      renderMap(false);
      if (query && selectedKey) centerMapOnTable(selectedKey);
    } else renderList();
  });
  els.refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  els.loginBtn.addEventListener('click', () => vscode.postMessage({ type: 'openLogin' }));
  if (els.sidebarBtn) {
    els.sidebarBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSidebar' }));
  }
  els.modeBrowse.addEventListener('click', () => setMode('browse'));
  if (els.modeMap) {
    els.modeMap.addEventListener('click', () => setMode('map'));
  }
  els.modeCompare.addEventListener('click', () => setMode('compare'));
  if (els.mapConnectedBtn) {
    els.mapConnectedBtn.addEventListener('click', () => {
      mapConnectedOnly = !mapConnectedOnly;
      els.mapConnectedBtn.setAttribute('aria-pressed', mapConnectedOnly ? 'true' : 'false');
      mapLayoutDb = '';
      renderMap(true);
    });
  }
  if (els.mapFocusOnlyBtn) {
    els.mapFocusOnlyBtn.addEventListener('click', () => {
      mapFocusOnly = !mapFocusOnly;
      els.mapFocusOnlyBtn.setAttribute('aria-pressed', mapFocusOnly ? 'true' : 'false');
      mapLayoutDb = '';
      renderMap(true);
    });
  }
  if (els.mapFitBtn) {
    els.mapFitBtn.addEventListener('click', () => fitMapToScreen());
  }
  if (els.mapZoomInBtn) {
    els.mapZoomInBtn.addEventListener('click', () => zoomMapBy(1.2));
  }
  if (els.mapZoomOutBtn) {
    els.mapZoomOutBtn.addEventListener('click', () => zoomMapBy(1 / 1.2));
  }
  if (els.mapResetBtn) {
    els.mapResetBtn.addEventListener('click', () => {
      mapPositions.clear();
      mapLayoutDb = '';
      renderMap(true);
    });
  }
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
    if (els.modeMap) {
      els.modeMap.setAttribute('aria-pressed', next === 'map' ? 'true' : 'false');
    }
    els.modeCompare.setAttribute('aria-pressed', next === 'compare' ? 'true' : 'false');
    els.compareBar.classList.toggle('hidden', next !== 'compare');
    els.summary.classList.toggle('hidden', next !== 'compare');
    els.kindSeg.classList.toggle('hidden', next !== 'browse');
    if (els.mapSeg) {
      els.mapSeg.classList.toggle('hidden', next !== 'map');
    }
    els.depthSeg.classList.toggle('hidden', next !== 'compare');
    els.diffSeg.classList.toggle('hidden', next !== 'compare');
    els.dbChips.classList.toggle('hidden', next === 'compare');
    els.metrics.classList.toggle('hidden', next === 'compare');
    els.body.classList.toggle('hidden', next === 'map');
    if (els.mapView) {
      els.mapView.classList.toggle('hidden', next !== 'map');
    }
    els.search.placeholder =
      next === 'compare'
        ? 'Search compared tables'
        : next === 'map'
          ? 'Jump to a table or column…'
          : 'Search tables or columns';
    if (next === 'compare') {
      els.subtitle.textContent = 'Table = missing tables. Columns = missing columns. Type = varchar vs int. Size = varchar(8) vs varchar(7).';
      fillDbSelects();
      requestCompare();
    } else if (next === 'map') {
      ensureMapDbFilter();
      if (lastInit) renderOverview(lastInit);
      renderMap(true);
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
    if (engine === 'mysql') return table.name;
    if (engine === 'bigquery') return table.database + '.' + table.schema + '.' + table.name;
    return table.schema + '.' + table.name;
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

  function selectAndScroll(name) {
    if (!name) return;
    const hit =
      tables.find((t) => t.qualifiedName === name) ||
      tables.find((t) => t.qualifiedName.toLowerCase() === name.toLowerCase());
    if (!hit) return;
    selectedKey = hit.qualifiedName;
    relationExpandLeft = false;
    relationExpandRight = false;
    dbFilter = '';
    if (mode !== 'browse') setMode('browse');
    else renderList();
    const el = els.list.querySelector('.item[aria-selected="true"]');
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function relationBundle(table) {
    if (!table || !lastInit || !lastInit.relations) return null;
    return lastInit.relations[table.qualifiedName.toLowerCase()] || null;
  }

  function relationMapping(relation) {
    if (relation.fromColumns.length === 1 && relation.toColumns.length === 1) {
      return relation.fromColumns[0] + ' → ' + relation.toColumns[0];
    }
    return relation.fromColumns.join(', ') + ' → ' + relation.toColumns.join(', ');
  }

  function isSelfRelation(relation) {
    return relation.fromTable.toLowerCase() === relation.toTable.toLowerCase();
  }

  function tableTitle(qualifiedName) {
    const hit =
      tables.find((t) => t.qualifiedName === qualifiedName) ||
      tables.find((t) => t.qualifiedName.toLowerCase() === qualifiedName.toLowerCase());
    return hit ? displayName(hit) : qualifiedName;
  }

  function outgoingForColumn(table, columnName) {
    const bundle = relationBundle(table);
    if (!bundle) return [];
    const key = columnName.toLowerCase();
    return bundle.outgoing.filter((rel) =>
      rel.fromColumns.some((name) => name.toLowerCase() === key)
    );
  }

  function relationCard(relation, focusName, direction) {
    const card = document.createElement('div');
    card.className = 'rel-card' + (relation.guessed ? ' rel-card-guessed' : '');
    const title = document.createElement('div');
    title.className = 'rel-card-title';
    title.textContent = tableTitle(focusName);
    card.appendChild(title);
    const map = document.createElement('div');
    map.className = 'rel-card-map code';
    map.textContent =
      direction === 'incoming'
        ? relation.fromColumns.join(', ') + ' → ' + relation.toColumns.join(', ')
        : relationMapping(relation);
    card.appendChild(map);
    const tags = document.createElement('div');
    tags.className = 'rel-card-tags';
    if (relation.guessed) {
      const g = document.createElement('span');
      g.className = 'rel-tag rel-tag-guessed';
      g.title = 'Guessed from the column name. Not declared in the database.';
      g.textContent = 'guessed';
      tags.appendChild(g);
    }
    if (isSelfRelation(relation)) {
      const s = document.createElement('span');
      s.className = 'rel-tag';
      s.textContent = 'self';
      tags.appendChild(s);
    }
    if (tags.childNodes.length) card.appendChild(tags);
    return card;
  }

  function renderRelationSide(parent, label, relations, pickFocus, expanded, setExpanded, incoming) {
    const col = document.createElement('div');
    col.className = 'rel-col';
    const h = document.createElement('h3');
    h.textContent = label;
    col.appendChild(h);
    if (relations.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted rel-empty';
      empty.textContent = 'None';
      col.appendChild(empty);
      parent.appendChild(col);
      return;
    }
    const show = expanded ? relations : relations.slice(0, RELATION_SIDE_CAP);
    for (const relation of show) {
      const focusName = pickFocus(relation);
      const cached = incoming || relation.toCached;
      const card = relationCard(relation, focusName, label === 'Referenced by' ? 'incoming' : 'outgoing');
      if (cached) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rel-card-btn';
        btn.appendChild(card);
        btn.addEventListener('click', () => selectAndScroll(focusName));
        col.appendChild(btn);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'rel-card-static';
        wrap.appendChild(card);
        const note = document.createElement('span');
        note.className = 'rel-not-cached';
        note.textContent = 'not cached';
        wrap.appendChild(note);
        col.appendChild(wrap);
      }
    }
    if (relations.length > RELATION_SIDE_CAP) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'secondary rel-more';
      more.textContent = expanded
        ? 'Show fewer'
        : '+' + (relations.length - RELATION_SIDE_CAP) + ' more';
      more.addEventListener('click', () => {
        setExpanded(!expanded);
        renderDetail(tables.find((t) => t.qualifiedName === selectedKey));
      });
      col.appendChild(more);
    }
    parent.appendChild(col);
  }

  function renderRelationMap(table) {
    const bundle = relationBundle(table);
    if (!bundle || (bundle.outgoing.length === 0 && bundle.incoming.length === 0)) {
      return null;
    }
    const wrap = document.createElement('section');
    wrap.className = 'rel-map';
    renderRelationSide(
      wrap,
      'Points to',
      bundle.outgoing,
      (rel) => rel.toTable,
      relationExpandLeft,
      (v) => {
        relationExpandLeft = v;
      },
      false
    );
    const center = document.createElement('div');
    center.className = 'rel-col rel-col-focus';
    const h = document.createElement('h3');
    h.textContent = 'Selected';
    center.appendChild(h);
    const card = document.createElement('div');
    card.className = 'rel-card rel-card-focus';
    const title = document.createElement('div');
    title.className = 'rel-card-title';
    title.textContent = displayName(table);
    card.appendChild(title);
    const keys = document.createElement('ul');
    keys.className = 'rel-key-list';
    for (const col of table.columns) {
      const rels = outgoingForColumn(table, col.name);
      if (!col.isPrimaryKey && rels.length === 0) continue;
      const li = document.createElement('li');
      const bits = [];
      if (col.isPrimaryKey) bits.push('PK');
      if (rels.some((r) => !r.guessed)) bits.push('FK');
      else if (rels.some((r) => r.guessed)) bits.push('FK?');
      li.textContent = col.name + (bits.length ? ' · ' + bits.join(' · ') : '');
      keys.appendChild(li);
    }
    if (keys.childNodes.length) card.appendChild(keys);
    center.appendChild(card);
    wrap.appendChild(center);
    renderRelationSide(
      wrap,
      'Referenced by',
      bundle.incoming,
      (rel) => rel.fromTable,
      relationExpandRight,
      (v) => {
        relationExpandRight = v;
      },
      true
    );
    return wrap;
  }

  function qualifiedForDiff(tableDiff) {
    if (!diff) return '';
    const db = tableDiff.left ? diff.left : diff.right;
    return (tables.find((t) => {
      if (t.database.toLowerCase() !== db.toLowerCase()) return false;
      const match =
        engine === 'mysql'
          ? t.name
          : engine === 'bigquery'
            ? t.database + '.' + t.schema + '.' + t.name
            : t.schema + '.' + t.name;
      return match.toLowerCase() === tableDiff.key;
    }) || {}).qualifiedName || '';
  }

  function groupKey(table) {
    if (engine === 'bigquery') return table.database + '.' + table.schema;
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
        : engine === 'bigquery'
          ? (dbs.length === 1 ? 'dataset' : 'datasets')
          : (dbs.length === 1 ? 'database' : 'databases');
    els.metrics.replaceChildren();
    metric(els.metrics, tableCount, 'tables');
    metric(els.metrics, views, 'views');
    metric(els.metrics, dbs.length, groupNoun);
    metric(els.metrics, cols, 'columns');

    const age = relativeTime(msg.fetchedAt);
    const stale = msg.stale ? 'disk cache' : 'live fetch';
    els.subtitle.textContent = 'Compare and search cached schema · ' + stale + ' · ' + age;

    els.dbChips.replaceChildren();
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip';
    all.textContent =
      engine === 'postgres' ? 'All schemas' : engine === 'bigquery' ? 'All datasets' : 'All databases';
    all.setAttribute('aria-pressed', dbFilter ? 'false' : 'true');
    all.addEventListener('click', () => {
      dbFilter = '';
      mapLayoutDb = '';
      renderOverview(msg);
      if (mode === 'map') renderMap(true);
      else renderList();
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
        mapLayoutDb = '';
        renderOverview(msg);
        if (mode === 'map') renderMap(true);
        else renderList();
      });
      els.dbChips.appendChild(chip);
    }
  }

  function renderEmptyCache() {
    els.filters.classList.add('hidden');
    els.body.classList.add('hidden');
    if (els.mapView) els.mapView.classList.add('hidden');
    els.compareBar.classList.add('hidden');
    els.summary.classList.add('hidden');
    els.depthSeg.classList.add('hidden');
    if (els.mapSeg) els.mapSeg.classList.add('hidden');
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
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'secondary';
    reveal.textContent = 'Reveal in sidebar';
    reveal.addEventListener('click', () => {
      vscode.postMessage({ type: 'revealInSidebar', qualifiedName: table.qualifiedName });
    });
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    actions.appendChild(copy);
    actions.appendChild(reveal);
    head.appendChild(left);
    head.appendChild(actions);
    els.detail.appendChild(head);

    const flags = document.createElement('p');
    flags.className = 'flags';
    const pk = table.columns.filter((c) => c.isPrimaryKey).length;
    const bundle = relationBundle(table);
    const declaredFk = bundle ? bundle.outgoing.filter((r) => !r.guessed).length : 0;
    const guessedFk = bundle ? bundle.outgoing.filter((r) => r.guessed).length : 0;
    const incomingCount = bundle ? bundle.incoming.length : 0;
    const flagParts = [
      table.isView ? 'View' : 'Table',
      table.columns.length + ' columns'
    ];
    if (pk) flagParts.push(pk + ' primary key' + (pk === 1 ? '' : 's'));
    const fkTotal = declaredFk + guessedFk;
    if (fkTotal) {
      let fkLine = fkTotal + ' foreign key' + (fkTotal === 1 ? '' : 's');
      if (guessedFk) fkLine += ' (' + guessedFk + ' guessed)';
      flagParts.push(fkLine);
    }
    if (incomingCount) {
      flagParts.push('referenced by ' + incomingCount);
    }
    flags.textContent = flagParts.join(' · ');
    els.detail.appendChild(flags);

    if (lastInit && lastInit.foreignKeysLoaded === false) {
      const hint = document.createElement('p');
      hint.className = 'muted rel-hint';
      hint.textContent = 'Refresh to load foreign keys.';
      els.detail.appendChild(hint);
    }
    if (engine === 'bigquery') {
      const hint = document.createElement('p');
      hint.className = 'muted rel-hint';
      hint.textContent =
        'BigQuery tables have no keys in the cache, so relations are not shown.';
      els.detail.appendChild(hint);
    }

    const relMap = renderRelationMap(table);
    if (relMap) els.detail.appendChild(relMap);

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
      const colRels = outgoingForColumn(table, col.name);
      const hasDeclared = colRels.some((r) => !r.guessed);
      const hasGuessed = colRels.some((r) => r.guessed);
      const pkCell = document.createElement('td');
      pkCell.className = 'pk';
      const keyBits = [];
      if (col.isPrimaryKey) keyBits.push('PK');
      if (hasDeclared) keyBits.push('FK');
      else if (hasGuessed) keyBits.push('FK?');
      pkCell.textContent = keyBits.join(' · ');
      const name = document.createElement('td');
      name.className = 'code';
      name.textContent = col.name;
      for (const rel of colRels) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'rel-chip' + (rel.guessed ? ' rel-chip-guessed' : '');
        chip.textContent = '→ ' + rel.toTable + '.' + rel.toColumns.join(',');
        if (rel.guessed) {
          chip.title = 'Guessed from the column name. Not declared in the database.';
        }
        if (rel.toCached) {
          chip.addEventListener('click', () => selectAndScroll(rel.toTable));
        } else {
          chip.disabled = true;
        }
        name.appendChild(chip);
      }
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

  function ensureMapDbFilter() {
    if (dbFilter && tables.some((t) => groupKey(t).toLowerCase() === dbFilter)) {
      return;
    }
    const dbs = dbCounts();
    if (dbs.length === 0) return;
    const def = dbs.find((entry) => entry[0].toLowerCase() === defaultDb.toLowerCase());
    dbFilter = (def ? def[0] : dbs[0][0]).toLowerCase();
  }

  function mapDatabaseTables() {
    ensureMapDbFilter();
    return tables.filter((t) => !dbFilter || groupKey(t).toLowerCase() === dbFilter);
  }

  function hasRelationInSet(table, allowedSet) {
    const bundle = relationBundle(table);
    if (!bundle) return false;
    for (const rel of bundle.outgoing) {
      if (allowedSet.has(rel.toTable.toLowerCase())) return true;
    }
    for (const rel of bundle.incoming) {
      if (allowedSet.has(rel.fromTable.toLowerCase())) return true;
    }
    return false;
  }

  function mapVisibleTables() {
    const dbTables = mapDatabaseTables().filter((t) => !t.isView);
    const dbSet = new Set(dbTables.map((t) => t.qualifiedName.toLowerCase()));
    const connected = dbTables.filter((t) => hasRelationInSet(t, dbSet));
    const isolatedCount = dbTables.length - connected.length;
    if (els.mapConnectedBtn) {
      els.mapConnectedBtn.textContent =
        isolatedCount > 0
          ? mapConnectedOnly
            ? 'Connected (' + connected.length + ') · +' + isolatedCount + ' isolated'
            : 'All tables (' + dbTables.length + ')'
          : 'Connected (' + connected.length + ')';
    }
    let pool = mapConnectedOnly && connected.length > 0 ? connected : dbTables;
    if (mapFocusOnly && selectedKey) {
      const selLower = selectedKey.toLowerCase();
      const focusTable = pool.find((t) => t.qualifiedName.toLowerCase() === selLower);
      if (focusTable) {
        const neighbors = new Set([selLower]);
        const bundle = relationBundle(focusTable);
        if (bundle) {
          for (const rel of bundle.outgoing) neighbors.add(rel.toTable.toLowerCase());
          for (const rel of bundle.incoming) neighbors.add(rel.fromTable.toLowerCase());
        }
        pool = pool.filter((t) => neighbors.has(t.qualifiedName.toLowerCase()));
      }
    }
    return pool;
  }

  function estimateCardHeight(table) {
    const expanded = mapExpandedCards.has(table.qualifiedName.toLowerCase());
    const shownCols = expanded ? table.columns.length : Math.min(table.columns.length, MAP_COL_LIMIT);
    const extraBtn = table.columns.length > MAP_COL_LIMIT ? 24 : 0;
    return 44 + shownCols * 24 + extraBtn;
  }

  // Fruchterman-Reingold: a link is a spring, every pair of tables repels.
  // ponytail: all-pairs repulsion is O(n²) per pass. Fine for a few hundred tables.
  // Upgrade path is a spatial grid if one database map grows into the thousands.
  function forceDirectedPositions(nodes, edges) {
    const n = nodes.length;
    if (n === 0) return;
    if (n === 1) {
      nodes[0].x = 0;
      nodes[0].y = 0;
      return;
    }
    const area = n * 340 * 220;
    const k = Math.sqrt(area / n);
    const startR = k * Math.sqrt(n) * 0.5;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      nodes[i].x = Math.cos(angle) * startR;
      nodes[i].y = Math.sin(angle) * startR * 0.65;
      nodes[i].dx = 0;
      nodes[i].dy = 0;
    }
    const iterations = n > 160 ? 48 : 80;
    let temperature = k;
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < n; i++) {
        nodes[i].dx = 0;
        nodes[i].dy = 0;
      }
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.hypot(dx, dy);
          if (dist < 0.01) {
            dx = 0.01;
            dy = 0;
            dist = 0.01;
          }
          const force = (k * k) / dist;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.dx += fx;
          a.dy += fy;
          b.dx -= fx;
          b.dy -= fy;
        }
      }
      for (let e = 0; e < edges.length; e++) {
        const a = nodes[edges[e][0]];
        const b = nodes[edges[e][1]];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) dist = 0.01;
        const force = (dist * dist) / k;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.dx -= fx;
        a.dy -= fy;
        b.dx += fx;
        b.dy += fy;
      }
      for (let i = 0; i < n; i++) {
        const node = nodes[i];
        node.dx -= node.x * 0.04;
        node.dy -= node.y * 0.04;
        const dist = Math.hypot(node.dx, node.dy);
        if (dist < 0.01) continue;
        const step = Math.min(dist, temperature);
        node.x += (node.dx / dist) * step;
        node.y += (node.dy / dist) * step;
      }
      temperature *= 0.92;
    }
    const gapX = 56;
    const gapY = 40;
    for (let pass = 0; pass < 60; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          const overlapX = (a.w + b.w) / 2 + gapX - Math.abs(a.x - b.x);
          const overlapY = (a.h + b.h) / 2 + gapY - Math.abs(a.y - b.y);
          if (overlapX <= 0 || overlapY <= 0) continue;
          moved = true;
          if (overlapX < overlapY) {
            const push = overlapX / 2 + 0.5;
            const sign = a.x <= b.x ? -1 : 1;
            a.x += sign * push;
            b.x -= sign * push;
          } else {
            const push = overlapY / 2 + 0.5;
            const sign = a.y <= b.y ? -1 : 1;
            a.y += sign * push;
            b.y -= sign * push;
          }
        }
      }
      if (!moved) break;
    }
  }

  // Same gaps as the force layout. Used when a card grows and the old positions overlap.
  function separateCenters(nodes) {
    const gapX = 56;
    const gapY = 40;
    for (let pass = 0; pass < 60; pass++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const overlapX = (a.w + b.w) / 2 + gapX - Math.abs(a.x - b.x);
          const overlapY = (a.h + b.h) / 2 + gapY - Math.abs(a.y - b.y);
          if (overlapX <= 0 || overlapY <= 0) continue;
          moved = true;
          if (overlapX < overlapY) {
            const push = overlapX / 2 + 0.5;
            const sign = a.x <= b.x ? -1 : 1;
            a.x += sign * push;
            b.x -= sign * push;
          } else {
            const push = overlapY / 2 + 0.5;
            const sign = a.y <= b.y ? -1 : 1;
            a.y += sign * push;
            b.y -= sign * push;
          }
        }
      }
      if (!moved) break;
    }
  }

  function separateStoredCards(tables) {
    const nodes = [];
    for (const table of tables) {
      const key = table.qualifiedName.toLowerCase();
      const pos = mapPositions.get(key);
      if (!pos) continue;
      const w = MAP_CARD_WIDTH;
      const h = estimateCardHeight(table);
      nodes.push({ key: key, x: pos.x + w / 2, y: pos.y + h / 2, w: w, h: h });
    }
    separateCenters(nodes);
    for (const node of nodes) {
      mapPositions.set(node.key, {
        x: Math.round(node.x - node.w / 2),
        y: Math.round(node.y - node.h / 2)
      });
    }
  }

  function layoutMapTables(visible) {
    const visibleSet = new Set(visible.map((t) => t.qualifiedName.toLowerCase()));
    const connected = [];
    const isolated = [];

    for (const table of visible) {
      const key = table.qualifiedName.toLowerCase();
      const bundle = relationBundle(table);
      let links = 0;
      if (bundle) {
        for (const rel of bundle.outgoing) {
          const to = rel.toTable.toLowerCase();
          if (to !== key && visibleSet.has(to)) links++;
        }
        for (const rel of bundle.incoming) {
          const from = rel.fromTable.toLowerCase();
          if (from !== key && visibleSet.has(from)) links++;
        }
      }
      if (links > 0) connected.push(table);
      else isolated.push(table);
    }
    isolated.sort((a, b) => a.name.localeCompare(b.name));

    const missingConnected = connected.filter(
      (table) => !mapPositions.has(table.qualifiedName.toLowerCase())
    );
    if (missingConnected.length === connected.length && connected.length > 0) {
      const indexByKey = new Map();
      const nodes = connected.map((table, index) => {
        indexByKey.set(table.qualifiedName.toLowerCase(), index);
        return { x: 0, y: 0, w: MAP_CARD_WIDTH, h: estimateCardHeight(table) };
      });
      const seenEdge = new Set();
      const edges = [];
      for (const table of connected) {
        const fromKey = table.qualifiedName.toLowerCase();
        const bundle = relationBundle(table);
        if (!bundle) continue;
        for (const rel of bundle.outgoing) {
          const toKey = rel.toTable.toLowerCase();
          if (!indexByKey.has(toKey) || toKey === fromKey) continue;
          const a = indexByKey.get(fromKey);
          const b = indexByKey.get(toKey);
          const id = Math.min(a, b) + ':' + Math.max(a, b);
          if (seenEdge.has(id)) continue;
          seenEdge.add(id);
          edges.push([a, b]);
        }
      }
      forceDirectedPositions(nodes, edges);
      let minX = Infinity;
      let minY = Infinity;
      for (const node of nodes) {
        const left = node.x - node.w / 2;
        const top = node.y - node.h / 2;
        if (left < minX) minX = left;
        if (top < minY) minY = top;
      }
      for (let i = 0; i < connected.length; i++) {
        const node = nodes[i];
        mapPositions.set(connected[i].qualifiedName.toLowerCase(), {
          x: Math.round(node.x - node.w / 2 - minX + 40),
          y: Math.round(node.y - node.h / 2 - minY + 40)
        });
      }
    } else if (missingConnected.length > 0) {
      let maxX = 40;
      for (const table of connected) {
        const pos = mapPositions.get(table.qualifiedName.toLowerCase());
        if (pos && pos.x + MAP_CARD_WIDTH > maxX) maxX = pos.x + MAP_CARD_WIDTH;
      }
      let y = 40;
      for (const table of missingConnected) {
        mapPositions.set(table.qualifiedName.toLowerCase(), { x: maxX + 80, y });
        y += estimateCardHeight(table) + 26;
      }
    }

    let boundRight = 40;
    let boundBottom = 40;
    for (const table of connected) {
      const pos = mapPositions.get(table.qualifiedName.toLowerCase());
      if (!pos) continue;
      const right = pos.x + MAP_CARD_WIDTH;
      const bottom = pos.y + estimateCardHeight(table);
      if (right > boundRight) boundRight = right;
      if (bottom > boundBottom) boundBottom = bottom;
    }
    const originX = connected.length > 0 ? boundRight + 120 : 40;
    const wrapAt = Math.max(boundBottom, 720);
    let x = originX;
    let y = 40;
    for (const table of isolated) {
      const key = table.qualifiedName.toLowerCase();
      if (mapPositions.has(key)) continue;
      const h = estimateCardHeight(table);
      if (connected.length > 0 && y > 40 && y + h > wrapAt) {
        x += 310;
        y = 40;
      }
      mapPositions.set(key, { x, y });
      y += h + 26;
    }
  }

  function applyMapTransform() {
    if (!els.mapWorld) return;
    els.mapWorld.style.transform =
      'translate(' + mapPanX + 'px, ' + mapPanY + 'px) scale(' + mapZoom + ')';
  }

  function fitMapToScreen() {
    if (!els.mapStage) return;
    const cards = els.mapNodes ? els.mapNodes.querySelectorAll('.map-card') : [];
    if (!cards.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of cards) {
      const key = (el.dataset.key || '').toLowerCase();
      const pos = mapPositions.get(key);
      if (!pos) continue;
      const w = el.offsetWidth || MAP_CARD_WIDTH;
      const h = el.offsetHeight || 160;
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + w > maxX) maxX = pos.x + w;
      if (pos.y + h > maxY) maxY = pos.y + h;
    }
    if (!Number.isFinite(minX)) return;
    const rect = els.mapStage.getBoundingClientRect();
    const stageW = Math.max(rect.width, 320);
    const stageH = Math.max(rect.height, 240);
    const pad = 48;
    const contentW = Math.max(maxX - minX, 200);
    const contentH = Math.max(maxY - minY, 160);
    const scaleX = (stageW - pad * 2) / contentW;
    const scaleY = (stageH - pad * 2) / contentH;
    mapZoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.25), 1.15);
    mapPanX = Math.round((stageW - contentW * mapZoom) / 2 - minX * mapZoom);
    mapPanY = Math.round((stageH - contentH * mapZoom) / 2 - minY * mapZoom);
    applyMapTransform();
  }

  function centerMapOnTable(qualifiedName) {
    if (!els.mapStage || !qualifiedName) return;
    const key = qualifiedName.toLowerCase();
    const pos = mapPositions.get(key);
    if (!pos) return;
    const rect = els.mapStage.getBoundingClientRect();
    const cardEl = els.mapNodes.querySelector(
      '.map-card[data-key-lower="' + CSS.escape(key) + '"]'
    );
    const w = cardEl ? cardEl.offsetWidth : MAP_CARD_WIDTH;
    const h = cardEl ? cardEl.offsetHeight : 160;
    mapPanX = Math.round(rect.width / 2 - (pos.x + w / 2) * mapZoom);
    mapPanY = Math.round(rect.height / 2 - (pos.y + h / 2) * mapZoom);
    applyMapTransform();
  }

  function zoomMapBy(factor, clientX, clientY) {
    if (!els.mapStage) return;
    const rect = els.mapStage.getBoundingClientRect();
    const cx = clientX !== undefined ? clientX - rect.left : rect.width / 2;
    const cy = clientY !== undefined ? clientY - rect.top : rect.height / 2;
    const nextZoom = Math.min(Math.max(mapZoom * factor, 0.2), 2.2);
    const ratio = nextZoom / mapZoom;
    mapPanX = Math.round(cx - (cx - mapPanX) * ratio);
    mapPanY = Math.round(cy - (cy - mapPanY) * ratio);
    mapZoom = nextZoom;
    applyMapTransform();
  }

  function columnMatchesQuery(column) {
    return !!query && column.name.toLowerCase().includes(query);
  }

  function tableMatchesQuery(table) {
    if (!query || !table) return false;
    if (table.name.toLowerCase().includes(query)) return true;
    if (table.qualifiedName.toLowerCase().includes(query)) return true;
    return table.columns.some(columnMatchesQuery);
  }

  function mapSearchKeys() {
    if (!query) return null;
    const keys = new Set();
    for (const table of mapDatabaseTables()) {
      if (table.isView || !tableMatchesQuery(table)) continue;
      keys.add(table.qualifiedName.toLowerCase());
    }
    return keys;
  }

  function mapSearchHit() {
    const pool = mapDatabaseTables().filter((table) => !table.isView);
    let columnHit = null;
    for (const table of pool) {
      const name = table.name.toLowerCase();
      const qualified = table.qualifiedName.toLowerCase();
      if (name.includes(query) || qualified.includes(query)) return table;
      if (!columnHit && table.columns.some(columnMatchesQuery)) columnHit = table;
    }
    return columnHit;
  }

  function mapColumnsForCard(table) {
    const expanded = mapExpandedCards.has(table.qualifiedName.toLowerCase());
    if (expanded || table.columns.length <= MAP_COL_LIMIT) {
      return { shown: table.columns, hiddenCount: 0 };
    }
    const hits = [];
    const keyCols = [];
    const otherCols = [];
    for (const col of table.columns) {
      if (columnMatchesQuery(col)) {
        hits.push(col);
        continue;
      }
      const rels = outgoingForColumn(table, col.name);
      const isTarget = incomingTouchesColumn(table, col.name);
      if (col.isPrimaryKey || rels.length > 0 || isTarget) keyCols.push(col);
      else otherCols.push(col);
    }
    const limit = Math.max(MAP_COL_LIMIT, hits.length);
    const shown = hits.concat(keyCols, otherCols).slice(0, limit);
    return { shown, hiddenCount: Math.max(0, table.columns.length - shown.length) };
  }

  function incomingTouchesColumn(table, columnName) {
    const bundle = relationBundle(table);
    if (!bundle) return false;
    const lower = columnName.toLowerCase();
    return bundle.incoming.some((rel) =>
      rel.toColumns.some((c) => c.toLowerCase() === lower)
    );
  }

  function renderMapEdges(visible) {
    if (!els.mapEdges || !els.mapNodes) return;
    els.mapEdges.replaceChildren();
    const visibleSet = new Set(visible.map((t) => t.qualifiedName.toLowerCase()));
    const selLower = (selectedKey || '').toLowerCase();
    const searchKeys = mapSearchKeys();
    const cardEls = new Map();
    for (const el of els.mapNodes.querySelectorAll('.map-card')) {
      cardEls.set(el.dataset.keyLower, el);
    }

    for (const table of visible) {
      const fromKey = table.qualifiedName.toLowerCase();
      const bundle = relationBundle(table);
      if (!bundle) continue;
      const fromCard = cardEls.get(fromKey);
      const fromPos = mapPositions.get(fromKey);
      if (!fromCard || !fromPos) continue;

      for (const rel of bundle.outgoing) {
        const toKey = rel.toTable.toLowerCase();
        if (!visibleSet.has(toKey) || fromKey === toKey) continue;
        const toCard = cardEls.get(toKey);
        const toPos = mapPositions.get(toKey);
        if (!toCard || !toPos) continue;

        const fromW = fromCard.offsetWidth || MAP_CARD_WIDTH;
        const toW = toCard.offsetWidth || MAP_CARD_WIDTH;
        const fromColName = (rel.fromColumns[0] || '').toLowerCase();
        const toColName = (rel.toColumns[0] || '').toLowerCase();
        const fromRow = fromCard.querySelector(
          '.map-col-row[data-col="' + CSS.escape(fromColName) + '"]'
        );
        const toRow = toCard.querySelector(
          '.map-col-row[data-col="' + CSS.escape(toColName) + '"]'
        );
        const fromY =
          fromPos.y +
          (fromRow ? fromRow.offsetTop + fromRow.offsetHeight / 2 : 22);
        const toY =
          toPos.y +
          (toRow ? toRow.offsetTop + toRow.offsetHeight / 2 : 22);

        const leftToRight = fromPos.x + fromW / 2 <= toPos.x + toW / 2;
        const x1 = leftToRight ? fromPos.x + fromW : fromPos.x;
        const x2 = leftToRight ? toPos.x : toPos.x + toW;
        const dx = Math.max(Math.abs(x2 - x1) * 0.45, 44);
        const c1x = leftToRight ? x1 + dx : x1 - dx;
        const c2x = leftToRight ? x2 - dx : x2 + dx;

        const isActive = searchKeys
          ? searchKeys.has(fromKey) || searchKeys.has(toKey)
          : selLower && (fromKey === selLower || toKey === selLower);
        const isDim = searchKeys
          ? !isActive
          : selLower && !isActive;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute(
          'd',
          'M ' + x1 + ' ' + fromY + ' C ' + c1x + ' ' + fromY + ', ' + c2x + ' ' + toY + ', ' + x2 + ' ' + toY
        );
        let cls = 'map-edge';
        if (rel.guessed) cls += ' map-edge-guessed';
        if (isActive) cls += ' map-edge-active';
        else if (isDim) cls += ' map-edge-dim';
        path.setAttribute('class', cls);
        els.mapEdges.appendChild(path);

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(x2));
        dot.setAttribute('cy', String(toY));
        dot.setAttribute('r', isActive ? '4' : '3');
        dot.setAttribute(
          'class',
          'map-edge-dot' + (isActive ? ' map-edge-dot-active' : isDim ? ' map-edge-dot-dim' : '')
        );
        els.mapEdges.appendChild(dot);
      }
    }
  }

  function applyMapSelectionState() {
    if (!els.mapNodes) return;
    const searchKeys = mapSearchKeys();
    const selLower = (selectedKey || '').toLowerCase();
    const activeNeighbors = new Set();
    if (!searchKeys && selLower) {
      activeNeighbors.add(selLower);
      const selTable = tables.find((t) => t.qualifiedName.toLowerCase() === selLower);
      const bundle = relationBundle(selTable);
      if (bundle) {
        for (const r of bundle.outgoing) activeNeighbors.add(r.toTable.toLowerCase());
        for (const r of bundle.incoming) activeNeighbors.add(r.fromTable.toLowerCase());
      }
    }
    for (const card of els.mapNodes.querySelectorAll('.map-card')) {
      const key = card.dataset.keyLower;
      if (searchKeys) {
        const hit = searchKeys.has(key);
        card.classList.toggle('map-card-selected', hit);
        card.classList.toggle('map-card-neighbor', false);
        card.classList.toggle('map-card-dim', !hit);
        continue;
      }
      card.classList.toggle('map-card-selected', !!selLower && key === selLower);
      card.classList.toggle(
        'map-card-neighbor',
        !!selLower && key !== selLower && activeNeighbors.has(key)
      );
      card.classList.toggle(
        'map-card-dim',
        !!selLower && !activeNeighbors.has(key)
      );
    }
    renderMapEdges(mapVisibleTables());
    renderMapInspector();
  }

  function renderMapInspector() {
    if (!els.mapInspector) return;
    const selLower = (selectedKey || '').toLowerCase();
    const table = tables.find((t) => t.qualifiedName.toLowerCase() === selLower);
    if (!table) {
      els.mapInspector.classList.add('hidden');
      els.mapInspector.replaceChildren();
      return;
    }
    els.mapInspector.classList.remove('hidden');
    els.mapInspector.replaceChildren();

    const head = document.createElement('div');
    head.className = 'map-insp-head';
    const title = document.createElement('strong');
    title.textContent = displayName(table);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'secondary map-insp-btn';
    closeBtn.textContent = 'Clear focus';
    closeBtn.addEventListener('click', () => {
      selectedKey = '';
      applyMapSelectionState();
    });
    head.appendChild(title);
    head.appendChild(closeBtn);
    els.mapInspector.appendChild(head);

    const sub = document.createElement('div');
    sub.className = 'code muted map-insp-sub';
    sub.textContent = table.qualifiedName;
    els.mapInspector.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'map-insp-actions';
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'secondary map-insp-btn';
    previewBtn.textContent = 'Preview rows';
    previewBtn.addEventListener('click', () => previewQualified(table.qualifiedName));
    const browseBtn = document.createElement('button');
    browseBtn.type = 'button';
    browseBtn.className = 'secondary map-insp-btn';
    browseBtn.textContent = 'Open in Browse';
    browseBtn.addEventListener('click', () => selectAndScroll(table.qualifiedName));
    actions.appendChild(previewBtn);
    actions.appendChild(browseBtn);
    els.mapInspector.appendChild(actions);

    const bundle = relationBundle(table);
    if (bundle && (bundle.outgoing.length > 0 || bundle.incoming.length > 0)) {
      if (bundle.outgoing.length > 0) {
        const h = document.createElement('div');
        h.className = 'map-insp-sec';
        h.textContent = 'Points to (' + bundle.outgoing.length + ')';
        els.mapInspector.appendChild(h);
        for (const rel of bundle.outgoing) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'map-insp-link';
          item.textContent =
            tableTitle(rel.toTable) +
            ' · ' +
            rel.fromColumns.join(',') +
            ' → ' +
            rel.toColumns.join(',') +
            (rel.guessed ? ' (guessed)' : '');
          item.addEventListener('click', () => focusTableOnMap(rel.toTable));
          els.mapInspector.appendChild(item);
        }
      }
      if (bundle.incoming.length > 0) {
        const h = document.createElement('div');
        h.className = 'map-insp-sec';
        h.textContent = 'Referenced by (' + bundle.incoming.length + ')';
        els.mapInspector.appendChild(h);
        for (const rel of bundle.incoming) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'map-insp-link';
          item.textContent =
            tableTitle(rel.fromTable) +
            ' · ' +
            rel.fromColumns.join(',') +
            ' → ' +
            rel.toColumns.join(',') +
            (rel.guessed ? ' (guessed)' : '');
          item.addEventListener('click', () => focusTableOnMap(rel.fromTable));
          els.mapInspector.appendChild(item);
        }
      }
    } else {
      const none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'No relations in cache for this table.';
      els.mapInspector.appendChild(none);
    }
  }

  function focusTableOnMap(qualifiedName) {
    const hit =
      tables.find((t) => t.qualifiedName === qualifiedName) ||
      tables.find((t) => t.qualifiedName.toLowerCase() === qualifiedName.toLowerCase());
    if (!hit) return;
    const targetDb = groupKey(hit).toLowerCase();
    const dbChanged = dbFilter !== targetDb;
    dbFilter = targetDb;
    selectedKey = hit.qualifiedName;
    if (dbChanged || mapFocusOnly) {
      mapLayoutDb = '';
      if (lastInit) renderOverview(lastInit);
      renderMap(true);
    } else {
      const visible = mapVisibleTables();
      if (!visible.some((t) => t.qualifiedName.toLowerCase() === hit.qualifiedName.toLowerCase())) {
        mapConnectedOnly = false;
        if (els.mapConnectedBtn) els.mapConnectedBtn.setAttribute('aria-pressed', 'false');
        mapLayoutDb = '';
        renderMap(true);
      } else {
        applyMapSelectionState();
      }
    }
    centerMapOnTable(hit.qualifiedName);
  }

  function buildMapCard(table, pos) {
    const key = table.qualifiedName.toLowerCase();
    const card = document.createElement('div');
    card.className = 'map-card';
    card.dataset.key = table.qualifiedName;
    card.dataset.keyLower = key;
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';

      const header = document.createElement('div');
      header.className = 'map-card-head';
      header.title = 'Click to focus · Drag to move · Double-click to preview rows';
      const title = document.createElement('span');
      title.className = 'map-card-name';
      title.textContent = displayName(table);
      const badge = document.createElement('span');
      badge.className = 'map-card-count';
      const bundle = relationBundle(table);
      const deg = bundle ? bundle.outgoing.length + bundle.incoming.length : 0;
      badge.textContent = deg > 0 ? deg + ' link' + (deg === 1 ? '' : 's') : String(table.columns.length);
      header.appendChild(title);
      header.appendChild(badge);
      card.appendChild(header);

      const colList = document.createElement('div');
      colList.className = 'map-card-cols';
      const { shown, hiddenCount } = mapColumnsForCard(table);
      for (const col of shown) {
        const row = document.createElement('div');
        row.className = 'map-col-row' + (columnMatchesQuery(col) ? ' map-col-hit' : '');
        row.dataset.col = col.name.toLowerCase();
        const rels = outgoingForColumn(table, col.name);
        const hasDeclared = rels.some((r) => !r.guessed);
        const hasGuessed = rels.some((r) => r.guessed);
        const tag = document.createElement('span');
        tag.className = 'map-col-key';
        if (col.isPrimaryKey && (hasDeclared || hasGuessed)) tag.textContent = 'PK·FK';
        else if (col.isPrimaryKey) tag.textContent = 'PK';
        else if (hasDeclared) tag.textContent = 'FK';
        else if (hasGuessed) tag.textContent = 'FK?';
        else tag.textContent = '';

        const cname = document.createElement('span');
        cname.className = 'map-col-name code';
        cname.textContent = col.name;

        const ctype = document.createElement('span');
        ctype.className = 'map-col-type code muted';
        ctype.textContent = col.typeDisplay;

        row.appendChild(tag);
        row.appendChild(cname);
        row.appendChild(ctype);
        colList.appendChild(row);
      }
      if (hiddenCount > 0 || mapExpandedCards.has(key)) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'map-col-more';
        moreBtn.textContent = mapExpandedCards.has(key)
          ? 'Show fewer columns'
          : '+' + hiddenCount + ' more column' + (hiddenCount === 1 ? '' : 's');
        moreBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (mapExpandedCards.has(key)) mapExpandedCards.delete(key);
          else mapExpandedCards.add(key);
          separateStoredCards(mapVisibleTables());
          renderMap(false);
        });
        colList.appendChild(moreBtn);
      }
      card.appendChild(colList);

    bindCardDragAndClick(card, table);
    return card;
  }

  function renderMap(shouldFit) {
    if (!els.mapNodes || !els.mapEdges) return;
    const visible = mapVisibleTables();
    const layoutKey = dbFilter + '|' + (mapConnectedOnly ? '1' : '0') + '|' + (mapFocusOnly ? selectedKey : '');
    if (mapLayoutDb !== layoutKey) {
      mapPositions.clear();
      layoutMapTables(visible);
      mapLayoutDb = layoutKey;
    } else {
      layoutMapTables(visible);
    }

    els.mapNodes.replaceChildren();
    if (visible.length === 0) {
      els.mapEdges.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'map-empty muted';
      empty.textContent =
        engine === 'bigquery'
          ? 'BigQuery tables have no keys in the cache, so relations are not shown.'
          : 'No tables to display in this database.';
      els.mapNodes.appendChild(empty);
      return;
    }

    for (const table of visible) {
      const key = table.qualifiedName.toLowerCase();
      const pos = mapPositions.get(key) || { x: 40, y: 40 };
      els.mapNodes.appendChild(buildMapCard(table, pos));
    }

    requestAnimationFrame(() => {
      applyMapSelectionState();
      if (shouldFit) fitMapToScreen();
      else applyMapTransform();
    });
  }

  function bindCardDragAndClick(card, table) {
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let moved = false;
    const key = table.qualifiedName.toLowerCase();

    card.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('button')) return;
      ev.stopPropagation();
      startX = ev.clientX;
      startY = ev.clientY;
      const pos = mapPositions.get(key) || { x: 0, y: 0 };
      origX = pos.x;
      origY = pos.y;
      moved = false;
      card.setPointerCapture(ev.pointerId);

      function onMove(moveEv) {
        const dx = (moveEv.clientX - startX) / mapZoom;
        const dy = (moveEv.clientY - startY) / mapZoom;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        if (!moved) return;
        const nx = Math.round(origX + dx);
        const ny = Math.round(origY + dy);
        mapPositions.set(key, { x: nx, y: ny });
        card.style.left = nx + 'px';
        card.style.top = ny + 'px';
        renderMapEdges(mapVisibleTables());
      }

      function onUp(upEv) {
        card.removeEventListener('pointermove', onMove);
        card.removeEventListener('pointerup', onUp);
        card.removeEventListener('pointercancel', onUp);
        if (card.hasPointerCapture(upEv.pointerId)) {
          card.releasePointerCapture(upEv.pointerId);
        }
        if (!moved) {
          if (selectedKey && selectedKey.toLowerCase() === key) {
            selectedKey = '';
          } else {
            selectedKey = table.qualifiedName;
          }
          if (mapFocusOnly) renderMap(true);
          else applyMapSelectionState();
        }
      }

      card.addEventListener('pointermove', onMove);
      card.addEventListener('pointerup', onUp);
      card.addEventListener('pointercancel', onUp);
    });

    card.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      previewQualified(table.qualifiedName);
    });
  }

  if (els.mapStage) {
    let panStartX = 0;
    let panStartY = 0;
    let origPanX = 0;
    let origPanY = 0;
    let panMoved = false;

    els.mapStage.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('.map-card') || ev.target.closest('.map-legend')) {
        return;
      }
      panStartX = ev.clientX;
      panStartY = ev.clientY;
      origPanX = mapPanX;
      origPanY = mapPanY;
      panMoved = false;
      els.mapStage.setPointerCapture(ev.pointerId);

      function onMove(moveEv) {
        const dx = moveEv.clientX - panStartX;
        const dy = moveEv.clientY - panStartY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
        mapPanX = Math.round(origPanX + dx);
        mapPanY = Math.round(origPanY + dy);
        applyMapTransform();
      }

      function onUp(upEv) {
        els.mapStage.removeEventListener('pointermove', onMove);
        els.mapStage.removeEventListener('pointerup', onUp);
        els.mapStage.removeEventListener('pointercancel', onUp);
        if (els.mapStage.hasPointerCapture(upEv.pointerId)) {
          els.mapStage.releasePointerCapture(upEv.pointerId);
        }
        if (!panMoved && selectedKey) {
          selectedKey = '';
          if (mapFocusOnly) renderMap(true);
          else applyMapSelectionState();
        }
      }

      els.mapStage.addEventListener('pointermove', onMove);
      els.mapStage.addEventListener('pointerup', onUp);
      els.mapStage.addEventListener('pointercancel', onUp);
    });

    els.mapStage.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoomMapBy(factor, ev.clientX, ev.clientY);
      },
      { passive: false }
    );
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
      if (msg.initialDatabase) {
        dbFilter = msg.initialDatabase.toLowerCase();
        mapLayoutDb = '';
      }
      if (msg.initialMode) {
        setMode(msg.initialMode);
        if (msg.focusTable) {
          if (msg.initialMode === 'map') focusTableOnMap(msg.focusTable);
          else selectAndScroll(msg.focusTable);
        }
        return;
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
      } else if (mode === 'map') {
        els.body.classList.add('hidden');
        if (els.mapView) els.mapView.classList.remove('hidden');
        renderOverview(msg);
        renderMap(true);
        if (msg.focusTable) focusTableOnMap(msg.focusTable);
      } else {
        renderOverview(msg);
        renderList();
        if (msg.focusTable) selectAndScroll(msg.focusTable);
      }
    } else if (msg.type === 'openMap') {
      if (msg.database) {
        dbFilter = msg.database.toLowerCase();
        mapLayoutDb = '';
      }
      setMode('map');
      if (msg.focusTable) focusTableOnMap(msg.focusTable);
    } else if (msg.type === 'focus') {
      selectAndScroll(msg.qualifiedName);
    } else if (msg.type === 'diff') {
      diff = msg.diff;
      renderCompare();
    } else if (msg.type === 'status') {
      els.refreshBtn.disabled = !!msg.busy;
      if (msg.message) showNote(msg.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
