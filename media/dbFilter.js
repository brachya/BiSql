(function () {
  const webviewApi = globalThis.bisqlWebview || {};
  const vscode = webviewApi.initPage ? webviewApi.initPage() : acquireVsCodeApi();
  const els = {
    connection: document.getElementById('filterConnection'),
    badge: document.getElementById('filterBadge'),
    dbSearch: document.getElementById('dbSearch'),
    dbChips: document.getElementById('dbChips'),
    dbList: document.getElementById('dbList'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    clearFilterBtn: document.getElementById('clearFilterBtn'),
    saveBtn: document.getElementById('saveBtn'),
    cancelBtn: document.getElementById('cancelBtn'),
    status: document.getElementById('status')
  };

  let allNames = [];
  let visibleNames = [];
  let defaultDatabase = '';

  function sameName(left, right) {
    if (webviewApi.sameName) return webviewApi.sameName(left, right);
    return String(left).toLowerCase() === String(right).toLowerCase();
  }

  function addUnique(list, name) {
    if (!name || list.some((item) => sameName(item, name))) return;
    list.push(name);
  }

  function planView() {
    if (!webviewApi.planDbPickerView) {
      return {
        chipsVisible: visibleNames,
        chipsSummary: null,
        listRows: [],
        listOmitted: 0,
        listHint: null,
        selectAllAllowed: false,
        unselectedMatches: []
      };
    }
    return webviewApi.planDbPickerView({
      allNames: allNames,
      selectedNames: visibleNames,
      defaultName: defaultDatabase,
      search: els.dbSearch.value
    });
  }

  function ensureDefaultVisible() {
    const trimmed = (defaultDatabase || '').trim();
    if (trimmed && !visibleNames.some((name) => sameName(name, trimmed))) {
      visibleNames.unshift(trimmed);
    }
  }

  function hideFromSidebar(name) {
    if (defaultDatabase && sameName(name, defaultDatabase)) return;
    visibleNames = visibleNames.filter((item) => !sameName(item, name));
    render();
  }

  function showInSidebar(name) {
    addUnique(visibleNames, name);
    ensureDefaultVisible();
    render();
  }

  function renderChips(plan) {
    els.dbChips.innerHTML = '';
    if (plan.chipsSummary) {
      const hint = document.createElement('div');
      hint.className = 'db-chips-hint';
      hint.textContent = plan.chipsSummary;
      els.dbChips.appendChild(hint);
    }
    for (const name of plan.chipsVisible) {
      const isDefault = defaultDatabase && sameName(name, defaultDatabase);
      const chip = document.createElement('span');
      chip.className = 'db-chip' + (isDefault ? ' is-default' : '');
      const label = document.createElement('span');
      label.className = 'db-chip-label';
      label.textContent = name;
      label.title = isDefault ? 'Default database (always shown)' : name;
      chip.appendChild(label);
      if (!isDefault) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'db-chip-remove';
        remove.setAttribute('aria-label', 'Hide ' + name);
        remove.textContent = '×';
        remove.addEventListener('click', () => hideFromSidebar(name));
        chip.appendChild(remove);
      }
      els.dbChips.appendChild(chip);
    }
  }

  function renderList(plan) {
    els.dbList.innerHTML = '';
    if (allNames.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'db-empty';
      empty.textContent = 'No databases on this connection yet. Refresh schema or pick databases in login.';
      els.dbList.appendChild(empty);
      return;
    }
    if (plan.listHint) {
      const empty = document.createElement('div');
      empty.className = 'db-empty';
      empty.textContent = plan.listHint;
      els.dbList.appendChild(empty);
    }
    for (const name of plan.listRows) {
      const row = document.createElement('div');
      row.className = 'db-row';
      const label = document.createElement('label');
      label.className = 'db-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = name;
      input.addEventListener('change', () => {
        if (input.checked) showInSidebar(name);
      });
      const span = document.createElement('span');
      span.className = 'db-name';
      span.textContent = name;
      label.appendChild(input);
      label.appendChild(span);
      row.appendChild(label);
      els.dbList.appendChild(row);
    }
    if (plan.listOmitted > 0) {
      const more = document.createElement('div');
      more.className = 'db-empty';
      more.textContent = plan.listOmitted + ' more matches. Narrow your search.';
      els.dbList.appendChild(more);
    }
    if (els.dbList.childNodes.length === 0 && !plan.listHint) {
      const empty = document.createElement('div');
      empty.className = 'db-empty';
      empty.textContent = 'Every database is shown in the sidebar.';
      els.dbList.appendChild(empty);
    }
  }

  function render() {
    ensureDefaultVisible();
    const plan = planView();
    renderChips(plan);
    renderList(plan);
    els.selectAllBtn.disabled = !plan.selectAllAllowed;
    const shown = visibleNames.length;
    els.badge.textContent =
      shown === allNames.length
        ? 'Showing all ' + allNames.length + ' databases'
        : shown + ' of ' + allNames.length + ' shown in sidebar';
  }

  function showAllMatches() {
    const plan = planView();
    if (!plan.selectAllAllowed) return;
    for (const name of plan.unselectedMatches) {
      addUnique(visibleNames, name);
    }
    ensureDefaultVisible();
    render();
  }

  function showAllDatabases() {
    visibleNames = allNames.slice();
    ensureDefaultVisible();
    els.dbSearch.value = '';
    render();
  }

  els.dbSearch.addEventListener('input', render);
  els.selectAllBtn.addEventListener('click', showAllMatches);
  els.clearFilterBtn.addEventListener('click', showAllDatabases);
  els.saveBtn.addEventListener('click', () => {
    ensureDefaultVisible();
    vscode.postMessage({ type: 'save', visible: visibleNames.slice() });
  });
  els.cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      allNames = Array.isArray(msg.allNames) ? msg.allNames.slice() : [];
      defaultDatabase = msg.defaultDatabase || '';
      if (els.connection) {
        els.connection.textContent = msg.connectionName ? 'Connection: ' + msg.connectionName : '';
      }
      visibleNames = Array.isArray(msg.visibleNames) ? msg.visibleNames.slice() : allNames.slice();
      ensureDefaultVisible();
      els.dbSearch.value = '';
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
