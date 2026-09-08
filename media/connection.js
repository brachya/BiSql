(function () {
    const vscode = acquireVsCodeApi();
    const KIND_ICONS = {
      mssql: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><ellipse cx=\"12\" cy=\"5.5\" rx=\"7\" ry=\"2.4\"/><path d=\"M5 5.5v4.2c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4V5.5\"/><path d=\"M5 9.7v4.2c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4V9.7\"/><path d=\"M5 13.9v4.2c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4v-4.2\"/></svg>",
      mysql: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3.2 14.2c2.8-5.6 8.6-7.6 13.8-5 1.8.9 3 2.1 3.6 3.3-1.6-.1-2.8.1-3.8.5 1.8 1 2.8 2.4 2.8 4 0 .8-.4 1.5-1.1 1.9-1.5-2.2-4.4-3.3-8.2-3.3-2.5 0-4.4.6-5.7 1.6-.5-1.1-1.4-2.3-2.4-3zm8 1.1c2.9 0 5.1.7 6 2.1-.9 1.5-3.2 2.4-6.1 2.4-1.6 0-3-.2-4-.7.6-2.1 1.9-3.8 4.1-3.8zm-1.5 1.8a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9zM6.8 18c.6 1.2.3 2.3-.7 3.1.2-1.4-.3-2.2-1.3-2.9.7-.2 1.4 0 2-.2z\"/></svg>",
      postgres: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M8.1 6.4c2.3-2 6.6-2 8.6.5 1.1 1.4 1.1 3.2.1 4.4-.2 1.8-1.5 3.2-3.3 3.8v2.1c0 .8-.7 1.5-1.5 1.5s-1.5-.7-1.5-1.5v-2c-2.2-.6-3.8-2.2-4.2-4.4-1.3 1.1-2.3 2.4-3.1 3.8-.4.6-1.3.2-1.2-.5.4-2.5 2.2-4.5 4.4-5.3.5-.3 1.1-.5 1.7-.7zm8.5 1.1c1.4.3 2.6 1.4 2.6 2.8 0 1-.5 1.8-1.4 2.2.2-1.6-.2-3.2-1.2-4.4v-.6zM9.7 9.3a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3z\"/></svg>",
      supabase: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M13.4 2.1 4.4 14.6h7.2l-1.1 7.3 9.3-13.4h-7.2l.8-6.4z\"/></svg>",
      bigquery: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M12 2 4.5 6.5v11L12 22l7.5-4.5v-11L12 2zm0 2.3 5.5 3.3v8.8L12 19.7 6.5 16.4V7.6L12 4.3zM8 9h8v2H8V9zm0 4h8v2H8v-2z\"/></svg>"
    };
  
    const els = {
      kindMssql: document.getElementById('kindMssql'),
      kindMysql: document.getElementById('kindMysql'),
      kindPostgres: document.getElementById('kindPostgres'),
      kindSupabase: document.getElementById('kindSupabase'),
      kindBigquery: document.getElementById('kindBigquery'),
      bodyMssql: document.getElementById('bodyMssql'),
      bodyMysql: document.getElementById('bodyMysql'),
      bodyPostgres: document.getElementById('bodyPostgres'),
      bodySupabase: document.getElementById('bodySupabase'),
      bodyBigquery: document.getElementById('bodyBigquery'),
      connectionId: document.getElementById('connectionId'),
      connName: document.getElementById('connName'),
      connList: document.getElementById('connList'),
      addConnBtn: document.getElementById('addConnBtn'),
      pinWrap: document.getElementById('pinWrap'),
      pinToWorkspace: document.getElementById('pinToWorkspace'),
      mssqlServer: document.getElementById('mssqlServer'),
      mssqlPort: document.getElementById('mssqlPort'),
      mssqlUser: document.getElementById('mssqlUser'),
      mssqlPassword: document.getElementById('mssqlPassword'),
      mssqlEncrypt: document.getElementById('mssqlEncrypt'),
      mssqlTrust: document.getElementById('mssqlTrust'),
      mssqlPickerMount: document.getElementById('mssqlPickerMount'),
      mysqlServer: document.getElementById('mysqlServer'),
      mysqlPort: document.getElementById('mysqlPort'),
      mysqlUser: document.getElementById('mysqlUser'),
      mysqlPassword: document.getElementById('mysqlPassword'),
      mysqlEncrypt: document.getElementById('mysqlEncrypt'),
      mysqlTrust: document.getElementById('mysqlTrust'),
      mysqlPickerMount: document.getElementById('mysqlPickerMount'),
      pgServer: document.getElementById('pgServer'),
      pgPort: document.getElementById('pgPort'),
      pgDatabase: document.getElementById('pgDatabase'),
      pgUser: document.getElementById('pgUser'),
      pgPassword: document.getElementById('pgPassword'),
      pgEncrypt: document.getElementById('pgEncrypt'),
      pgTrust: document.getElementById('pgTrust'),
      pgLoadDbsBtn: document.getElementById('pgLoadDbsBtn'),
      pgDbList: document.getElementById('pgDbList'),
      sbUrl: document.getElementById('sbUrl'),
      sbSummary: document.getElementById('sbSummary'),
      sbPoolerHint: document.getElementById('sbPoolerHint'),
      sbPasswordWrap: document.getElementById('sbPasswordWrap'),
      sbPassword: document.getElementById('sbPassword'),
      sbServer: document.getElementById('sbServer'),
      sbPort: document.getElementById('sbPort'),
      sbUser: document.getElementById('sbUser'),
      sbDatabase: document.getElementById('sbDatabase'),
      sbTrust: document.getElementById('sbTrust'),
      bqProject: document.getElementById('bqProject'),
      bqLoadProjectsBtn: document.getElementById('bqLoadProjectsBtn'),
      bqProjectList: document.getElementById('bqProjectList'),
      bqPickerMount: document.getElementById('bqPickerMount'),
      dbPicker: document.getElementById('dbPicker'),
      database: document.getElementById('database'),
      dbSearch: document.getElementById('dbSearch'),
      dbList: document.getElementById('dbList'),
      dbSummary: document.getElementById('dbSummary'),
      loadDbsBtn: document.getElementById('loadDbsBtn'),
      selectAllDbsBtn: document.getElementById('selectAllDbsBtn'),
      enabled: document.getElementById('enabled'),
      clearPassword: document.getElementById('clearPassword'),
      clearPasswordWrap: document.getElementById('clearPasswordWrap'),
      pwdNote: document.getElementById('pwdNote'),
      badge: document.getElementById('badge'),
      status: document.getElementById('status'),
      saveBtn: document.getElementById('saveBtn'),
      testBtn: document.getElementById('testBtn'),
      browseBtn: document.getElementById('browseBtn'),
      form: document.getElementById('form')
    };
  
    let availableDatabases = [];
    let selectedDatabases = [];
    let pgNames = [];
    let bqProjects = [];
    let profiles = [];
    let selectedId = '';
  
    document.querySelectorAll('.pwd-wrap').forEach((wrap) => {
      const input = wrap.querySelector('input');
      const btn = wrap.querySelector('.pwd-toggle');
      const eye = wrap.querySelector('.icon-eye');
      const eyeOff = wrap.querySelector('.icon-eye-off');
      if (!input || !btn || !eye || !eyeOff) return;
      btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.hidden = show;
        eyeOff.hidden = !show;
        btn.title = show ? 'Hide password' : 'Show password';
        btn.setAttribute('aria-label', btn.title);
      });
    });
  
    function knownKind(kind) {
      return kind === 'mysql' || kind === 'postgres' || kind === 'supabase' || kind === 'bigquery'
        ? kind
        : 'mssql';
    }
  
    function getLoginKind() {
      if (els.kindMysql.checked) return 'mysql';
      if (els.kindPostgres.checked) return 'postgres';
      if (els.kindSupabase.checked) return 'supabase';
      if (els.kindBigquery.checked) return 'bigquery';
      return 'mssql';
    }
  
    function setLoginKind(kind) {
      const next = knownKind(kind);
      els.kindMssql.checked = next === 'mssql';
      els.kindMysql.checked = next === 'mysql';
      els.kindPostgres.checked = next === 'postgres';
      els.kindSupabase.checked = next === 'supabase';
      els.kindBigquery.checked = next === 'bigquery';
      applyKindUi();
    }
  
    function kindLabel(kind) {
      if (kind === 'mysql') return 'MySQL';
      if (kind === 'postgres') return 'PostgreSQL';
      if (kind === 'supabase') return 'Supabase';
      if (kind === 'bigquery') return 'BigQuery';
      return 'SQL Server';
    }
  
    function applyKindUi() {
      const kind = getLoginKind();
      els.bodyMssql.hidden = kind !== 'mssql';
      els.bodyMysql.hidden = kind !== 'mysql';
      els.bodyPostgres.hidden = kind !== 'postgres';
      els.bodySupabase.hidden = kind !== 'supabase';
      els.bodyBigquery.hidden = kind !== 'bigquery';
      if (kind === 'mssql') {
        els.mssqlPickerMount.appendChild(els.dbPicker);
        els.dbPicker.hidden = false;
      } else if (kind === 'mysql') {
        els.mysqlPickerMount.appendChild(els.dbPicker);
        els.dbPicker.hidden = false;
      } else if (kind === 'bigquery') {
        els.bqPickerMount.appendChild(els.dbPicker);
        els.dbPicker.hidden = false;
      } else {
        els.dbPicker.hidden = true;
      }
      els.loadDbsBtn.textContent = kind === 'bigquery' ? 'Load from project' : 'Load from server';
      els.dbSearch.placeholder = kind === 'bigquery'
        ? 'Search, type project.dataset, or other-project. then Load'
        : 'Search, type a name, or pick from the list';
      els.pwdNote.hidden = kind === 'bigquery';
      els.clearPasswordWrap.hidden = kind === 'bigquery';
      renderDbList();
      updateSbPreview();
      updatePanelHints();
    }
  
    function renderConnList() {
      els.connList.innerHTML = '';
      if (profiles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'db-empty';
        empty.textContent = 'No saved logins yet. Click Add, then fill the form.';
        els.connList.appendChild(empty);
        updatePanelHints();
        return;
      }
      for (const profile of profiles) {
        const row = document.createElement('div');
        row.className = 'conn-row' + (profile.id === selectedId ? ' is-selected' : '') + (profile.active ? ' is-active' : '');
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'conn-main';
        main.innerHTML = '<span class="kind-icon">' + (KIND_ICONS[profile.loginKind] || '') + '</span>';
        const meta = document.createElement('span');
        meta.className = 'conn-meta';
        const name = document.createElement('span');
        name.className = 'conn-name';
        name.textContent = profile.name;
        const host = document.createElement('span');
        host.className = 'conn-host';
        host.textContent = profile.server ? profile.server + (profile.database ? ' / ' + profile.database : '') : 'Not filled in';
        meta.appendChild(name);
        meta.appendChild(host);
        main.appendChild(meta);
        if (profile.active) {
          const pill = document.createElement('span');
          pill.className = 'conn-pill';
          pill.textContent = 'Active';
          main.appendChild(pill);
        }
        main.addEventListener('click', () => vscode.postMessage({ type: 'select', id: profile.id }));
        const actions = document.createElement('div');
        actions.className = 'conn-actions';
        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'secondary';
        renameBtn.textContent = 'Rename';
        renameBtn.addEventListener('click', () => vscode.postMessage({ type: 'rename', id: profile.id }));
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'secondary';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => vscode.postMessage({ type: 'delete', id: profile.id }));
        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        row.appendChild(main);
        row.appendChild(actions);
        els.connList.appendChild(row);
      }
      updatePanelHints();
    }
  
    function setHint(id, text) {
      const node = document.getElementById(id);
      if (node) node.textContent = text || '';
    }
  
    function hostHint(server, port) {
      const host = (server || '').trim();
      return host ? host + ':' + port : 'Host and port';
    }
  
    function updatePanelHints() {
      const kind = getLoginKind();
      setHint('connPanelHint', profiles.length === 0 ? 'None saved yet' : (profiles.length === 1 ? '1 saved' : profiles.length + ' saved'));
      setHint('typePanelHint', kindLabel(kind));
      setHint('optsPanelHint', els.enabled.checked ? 'Extension on' : 'Extension off');
      if (kind === 'mssql') {
        setHint('mssqlServerPanelHint', hostHint(els.mssqlServer.value, els.mssqlPort.value));
        setHint('mssqlDbPanelHint', els.dbSummary.textContent);
        setHint('mssqlAuthPanelHint', els.mssqlUser.value || 'Username and password');
        setHint('mssqlSecPanelHint', els.mssqlEncrypt.checked ? 'TLS on' : 'TLS off');
      } else if (kind === 'mysql') {
        setHint('mysqlServerPanelHint', hostHint(els.mysqlServer.value, els.mysqlPort.value));
        setHint('mysqlDbPanelHint', els.dbSummary.textContent);
        setHint('mysqlAuthPanelHint', els.mysqlUser.value || 'Username and password');
        setHint('mysqlSecPanelHint', els.mysqlEncrypt.checked ? 'TLS on' : 'TLS off');
      } else if (kind === 'postgres') {
        setHint('pgServerPanelHint', hostHint(els.pgServer.value, els.pgPort.value));
        setHint('pgDbPanelHint', els.pgDatabase.value.trim() || 'One database per connection');
        setHint('pgAuthPanelHint', els.pgUser.value || 'Username and password');
        setHint('pgSecPanelHint', els.pgEncrypt.checked ? 'TLS on' : 'TLS off');
      } else if (kind === 'bigquery') {
        setHint('bqProjectPanelHint', (els.bqProject.value || '').trim() || 'Google Cloud project id');
        setHint('bqDbPanelHint', els.dbSummary.textContent);
      } else {
        setHint('sbUrlPanelHint', els.sbServer.value || 'Paste the dashboard URL');
        setHint('sbAuthPanelHint', els.sbPasswordWrap.hidden ? 'Password is in the URL' : 'Database password');
      }
    }
  
    function setBusy(busy) {
      els.saveBtn.disabled = busy;
      els.testBtn.disabled = busy;
      els.loadDbsBtn.disabled = busy;
      els.selectAllDbsBtn.disabled = busy;
      els.pgLoadDbsBtn.disabled = busy;
      els.bqLoadProjectsBtn.disabled = busy;
      els.addConnBtn.disabled = busy;
      els.dbSearch.disabled = busy;
    }
  
    function showStatus(message, kind) {
      els.status.textContent = message;
      els.status.className = 'status show ' + kind;
    }
  
    function selectedSet() {
      return new Set(selectedDatabases.map((name) => name.toLowerCase()));
    }
  
    function defaultDatabaseName() {
      return (els.database.value || '').trim();
    }
  
    function sameName(left, right) {
      return left.toLowerCase() === right.toLowerCase();
    }
  
    function addUnique(list, name) {
      if (!name || list.some((item) => sameName(item, name))) return;
      list.push(name);
    }
  
    function allDbNames() {
      const names = [];
      for (const name of availableDatabases) addUnique(names, name);
      for (const name of selectedDatabases) addUnique(names, name);
      addUnique(names, defaultDatabaseName());
      return names;
    }
  
    function setDefaultDatabase(name) {
      const trimmed = (name || '').trim();
      els.database.value = trimmed;
      if (trimmed) {
        const rest = selectedDatabases.filter((item) => !sameName(item, trimmed));
        selectedDatabases = [trimmed, ...rest];
      }
      renderDbList();
    }
  
    function filteredDbNames() {
      const filter = (els.dbSearch.value || '').trim().toLowerCase();
      const names = allDbNames();
      return filter ? names.filter((name) => name.toLowerCase().includes(filter)) : names;
    }
  
    function renderDbList() {
      const chosen = selectedSet();
      const defaultDb = defaultDatabaseName();
      if (defaultDb) chosen.add(defaultDb.toLowerCase());
      const filter = (els.dbSearch.value || '').trim();
      const visible = filteredDbNames();
      const exact = filter && allDbNames().some((name) => sameName(name, filter));
      els.dbList.innerHTML = '';
      if (allDbNames().length === 0 && !filter) {
        const empty = document.createElement('div');
        empty.className = 'db-empty';
        empty.textContent = 'Type a database name, or load the list from the server.';
        els.dbList.appendChild(empty);
        updateDbSummary();
        return;
      }
      for (const name of visible) {
        els.dbList.appendChild(renderMultiRow(name, defaultDb, chosen));
      }
      if (filter && !exact) {
        els.dbList.appendChild(renderCustomRow(filter));
      }
      if (els.dbList.childNodes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'db-empty';
        empty.textContent = 'No databases match that search.';
        els.dbList.appendChild(empty);
      }
      updateDbSummary();
    }
  
    function renderMultiRow(name, defaultDb, chosen) {
      const isDefault = Boolean(defaultDb && sameName(name, defaultDb));
      const isSelected = chosen.has(name.toLowerCase());
      const row = document.createElement('div');
      row.className = 'db-row' + (isDefault ? ' is-default' : '') + (isSelected ? ' is-selected' : '');
      row.setAttribute('role', 'option');
      const label = document.createElement('label');
      label.className = 'db-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = name;
      input.checked = isSelected;
      input.disabled = isDefault;
      input.addEventListener('change', () => {
        syncSelectedFromCheckboxes();
        row.classList.toggle('is-selected', input.checked);
        updateDbSummary();
      });
      const span = document.createElement('span');
      span.className = 'db-name';
      span.textContent = name;
      label.appendChild(input);
      label.appendChild(span);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'db-default-btn';
      btn.textContent = 'Default';
      btn.setAttribute('aria-pressed', isDefault ? 'true' : 'false');
      btn.title = isDefault ? 'This is the default database' : 'Use as default';
      btn.addEventListener('click', () => setDefaultDatabase(name));
      row.appendChild(label);
      row.appendChild(btn);
      return row;
    }
  
    function renderCustomRow(name) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'db-row db-custom db-pick';
      const span = document.createElement('span');
      span.className = 'db-name';
      span.textContent = 'Use “' + name + '” as default';
      btn.appendChild(span);
      btn.addEventListener('click', () => applyTypedDatabase(name));
      return btn;
    }
  
    function applyTypedDatabase(name) {
      const trimmed = (name || '').trim();
      if (!trimmed) return;
      addUnique(availableDatabases, trimmed);
      setDefaultDatabase(trimmed);
      els.dbSearch.value = '';
      renderDbList();
    }
  
    function updateDbSummary() {
      const defaultDb = defaultDatabaseName();
      const names = selectedSet();
      if (defaultDb) names.add(defaultDb.toLowerCase());
      const count = names.size;
      if (!defaultDb) {
        els.dbSummary.textContent = count > 0 ? count + ' selected · pick a default' : 'No database selected';
        return;
      }
      els.dbSummary.textContent = count <= 1
        ? defaultDb + ' is the default'
        : count + ' selected · ' + defaultDb + ' is the default';
      updatePanelHints();
    }
  
    function syncSelectedFromCheckboxes() {
      const boxes = els.dbList.querySelectorAll('input[type="checkbox"]');
      const hiddenSelected = [];
      const visibleKeys = new Set();
      boxes.forEach((box) => visibleKeys.add(box.value.toLowerCase()));
      for (const name of selectedDatabases) {
        if (!visibleKeys.has(name.toLowerCase())) hiddenSelected.push(name);
      }
      selectedDatabases = hiddenSelected.slice();
      boxes.forEach((box) => {
        if (box.checked) addUnique(selectedDatabases, box.value);
      });
      const defaultDb = defaultDatabaseName();
      if (defaultDb && !selectedDatabases.some((name) => sameName(name, defaultDb))) {
        selectedDatabases.unshift(defaultDb);
      }
    }
  
    function previewPostgresUrl(raw) {
      const trimmed = (raw || '').trim();
      if (!trimmed) return null;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('mysql://') || lower.startsWith('mysql+')) {
        return { error: 'This is a MySQL URL. Choose MySQL.' };
      }
      let rest;
      if (lower.startsWith('postgresql://')) rest = trimmed.slice(13);
      else if (lower.startsWith('postgres://')) rest = trimmed.slice(11);
      else return { error: 'Use a postgres:// or postgresql:// URL from the Supabase dashboard.' };
      try {
        const parsed = new URL('http://' + rest);
        const host = decodeURIComponent(parsed.hostname);
        if (!host) return { error: 'The URL has no host.' };
        if (!host.toLowerCase().includes('supabase.')) {
          return { error: 'That host is not Supabase. Choose PostgreSQL.' };
        }
        return {
          host,
          port: parsed.port ? Number(parsed.port) : 5432,
          user: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
          database: decodeURIComponent(parsed.pathname.replace(/^[/]/, '')).split('/')[0] || '',
          sslMode: (parsed.searchParams.get('sslmode') || '').toLowerCase()
        };
      } catch {
        return { error: 'That URL could not be read. Check it and paste again.' };
      }
    }
  
    function updateSbPreview() {
      if (getLoginKind() !== 'supabase') return;
      const parsed = previewPostgresUrl(els.sbUrl.value);
      if (parsed && parsed.error) {
        els.sbSummary.hidden = false;
        els.sbSummary.textContent = parsed.error;
        els.sbPoolerHint.hidden = true;
        els.sbPasswordWrap.hidden = false;
        return;
      }
      if (parsed) {
        els.sbServer.value = parsed.host;
        els.sbPort.value = String(parsed.port);
        els.sbUser.value = parsed.user;
        els.sbDatabase.value = parsed.database;
        els.sbTrust.value = parsed.sslMode === 'verify-full' || parsed.sslMode === 'verify-ca' ? '0' : '1';
        els.sbSummary.hidden = false;
        els.sbSummary.innerHTML = '<code>' + parsed.user + '@' + parsed.host + ':' + parsed.port + '/' + (parsed.database || 'postgres') + '</code>';
        els.sbPoolerHint.hidden = !(parsed.host.toLowerCase().startsWith('db.') && parsed.host.toLowerCase().includes('supabase.'));
        els.sbPasswordWrap.hidden = Boolean(parsed.password);
        return;
      }
      if (els.sbServer.value) {
        els.sbSummary.hidden = false;
        els.sbSummary.innerHTML = '<code>' + (els.sbUser.value || 'user') + '@' + els.sbServer.value + ':' + (els.sbPort.value || '5432') + '/' + (els.sbDatabase.value || 'postgres') + '</code>';
        els.sbPoolerHint.hidden = !(els.sbServer.value.toLowerCase().startsWith('db.') && els.sbServer.value.toLowerCase().includes('supabase.'));
        els.sbPasswordWrap.hidden = false;
        return;
      }
      els.sbSummary.hidden = true;
      els.sbPoolerHint.hidden = true;
      els.sbPasswordWrap.hidden = false;
    }
  
    function renderPgList(names) {
      pgNames = names.slice();
      els.pgDbList.innerHTML = '';
      if (pgNames.length === 0) {
        els.pgDbList.hidden = true;
        return;
      }
      els.pgDbList.hidden = false;
      for (const name of pgNames) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'db-row db-pick' + (sameName(name, els.pgDatabase.value) ? ' is-default' : '');
        btn.textContent = name;
        btn.addEventListener('click', () => {
          els.pgDatabase.value = name;
          renderPgList(pgNames);
        });
        els.pgDbList.appendChild(btn);
      }
    }

    function renderBqProjectList(names) {
      bqProjects = names.slice();
      els.bqProjectList.innerHTML = '';
      if (bqProjects.length === 0) {
        els.bqProjectList.hidden = true;
        return;
      }
      els.bqProjectList.hidden = false;
      const home = (els.bqProject.value || '').trim();
      for (const name of bqProjects) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'db-row db-pick' + (home && sameName(name, home) ? ' is-default' : '');
        btn.textContent = name;
        btn.addEventListener('click', () => pickBqProject(name));
        els.bqProjectList.appendChild(btn);
      }
    }

    function pickBqProject(projectId) {
      const home = (els.bqProject.value || '').trim();
      if (!home) {
        els.bqProject.value = projectId;
        els.dbSearch.value = '';
        updatePanelHints();
        renderBqProjectList(bqProjects);
        requestDatabaseList();
        return;
      }
      if (sameName(home, projectId)) {
        els.dbSearch.value = '';
        requestDatabaseList();
        return;
      }
      els.dbSearch.value = projectId + '.';
      requestDatabaseList();
    }

    function requestDatabaseList() {
      const data = readForm();
      if (!data.server.trim()) {
        showStatus(
          data.loginKind === 'bigquery'
            ? 'Project is required to load the list.'
            : 'Server is required to load the list.',
          'err'
        );
        return;
      }
      setBusy(true);
      const extra = {};
      if (data.loginKind === 'bigquery') {
        const typed = (els.dbSearch.value || '').trim();
        const dot = typed.indexOf('.');
        if (dot > 0) extra.listProject = typed.slice(0, dot);
      }
      vscode.postMessage({ type: 'listDatabases', ...data, ...extra });
    }
  
    function readForm() {
      const kind = getLoginKind();
      const shared = {
        connectionId: els.connectionId.value,
        name: els.connName.value,
        pinToWorkspace: els.pinToWorkspace.checked,
        loginKind: kind,
        enabled: els.enabled.checked,
        clearPassword: els.clearPassword.checked,
        connectionUrl: ''
      };
      if (kind === 'supabase') {
        return {
          ...shared,
          connectionUrl: els.sbUrl.value,
          server: els.sbServer.value,
          database: els.sbDatabase.value,
          databases: els.sbDatabase.value.trim() ? [els.sbDatabase.value.trim()] : [],
          user: els.sbUser.value,
          password: els.sbPassword.value,
          port: Number(els.sbPort.value) || 5432,
          encrypt: true,
          trustServerCertificate: els.sbTrust.value !== '0'
        };
      }
      if (kind === 'bigquery') {
        const typed = (els.dbSearch.value || '').trim();
        if (!defaultDatabaseName() && typed) applyTypedDatabase(typed);
        syncSelectedFromCheckboxes();
        const database = els.database.value;
        let databases = selectedDatabases.slice();
        if (database.trim() && !databases.some((name) => name.toLowerCase() === database.trim().toLowerCase())) {
          databases = [database.trim(), ...databases];
        }
        return {
          ...shared,
          server: els.bqProject.value,
          database,
          databases,
          user: '',
          password: '',
          port: 0,
          encrypt: true,
          trustServerCertificate: false
        };
      }
      if (kind === 'postgres') {
        const database = els.pgDatabase.value.trim();
        return {
          ...shared,
          server: els.pgServer.value,
          database,
          databases: database ? [database] : [],
          user: els.pgUser.value,
          password: els.pgPassword.value,
          port: Number(els.pgPort.value) || 5432,
          encrypt: els.pgEncrypt.checked,
          trustServerCertificate: els.pgTrust.checked
        };
      }
      const typed = (els.dbSearch.value || '').trim();
      if (!defaultDatabaseName() && typed) applyTypedDatabase(typed);
      syncSelectedFromCheckboxes();
      const database = els.database.value;
      let databases = selectedDatabases.slice();
      if (database.trim() && !databases.some((name) => name.toLowerCase() === database.trim().toLowerCase())) {
        databases = [database.trim(), ...databases];
      }
      if (kind === 'mysql') {
        return {
          ...shared,
          server: els.mysqlServer.value,
          database,
          databases,
          user: els.mysqlUser.value,
          password: els.mysqlPassword.value,
          port: Number(els.mysqlPort.value) || 3306,
          encrypt: els.mysqlEncrypt.checked,
          trustServerCertificate: els.mysqlTrust.checked
        };
      }
      return {
        ...shared,
        server: els.mssqlServer.value,
        database,
        databases,
        user: els.mssqlUser.value,
        password: els.mssqlPassword.value,
        port: Number(els.mssqlPort.value) || 1433,
        encrypt: els.mssqlEncrypt.checked,
        trustServerCertificate: els.mssqlTrust.checked
      };
    }
  
    function clearKindFields() {
      els.mssqlServer.value = '';
      els.mssqlPort.value = '1433';
      els.mssqlUser.value = '';
      els.mssqlPassword.value = '';
      els.mssqlEncrypt.checked = true;
      els.mssqlTrust.checked = false;
      els.mysqlServer.value = '';
      els.mysqlPort.value = '3306';
      els.mysqlUser.value = '';
      els.mysqlPassword.value = '';
      els.mysqlEncrypt.checked = true;
      els.mysqlTrust.checked = false;
      els.pgServer.value = '';
      els.pgPort.value = '5432';
      els.pgDatabase.value = '';
      els.pgUser.value = '';
      els.pgPassword.value = '';
      els.pgEncrypt.checked = true;
      els.pgTrust.checked = false;
      els.sbUrl.value = '';
      els.sbServer.value = '';
      els.sbPort.value = '5432';
      els.sbUser.value = '';
      els.sbDatabase.value = '';
      els.sbPassword.value = '';
      els.sbTrust.value = '1';
      els.sbSummary.hidden = true;
      els.sbPoolerHint.hidden = true;
      els.sbPasswordWrap.hidden = false;
      els.bqProject.value = '';
    }
  
    function fillKindFields(c) {
      const kind = knownKind(c.loginKind);
      if (kind === 'mssql') {
        els.mssqlServer.value = c.server || '';
        els.mssqlPort.value = String(c.port || 1433);
        els.mssqlUser.value = c.user || '';
        els.mssqlPassword.value = c.password || '';
        els.mssqlEncrypt.checked = c.encrypt !== false;
        els.mssqlTrust.checked = !!c.trustServerCertificate;
      } else if (kind === 'mysql') {
        els.mysqlServer.value = c.server || '';
        els.mysqlPort.value = String(c.port || 3306);
        els.mysqlUser.value = c.user || '';
        els.mysqlPassword.value = c.password || '';
        els.mysqlEncrypt.checked = c.encrypt !== false;
        els.mysqlTrust.checked = !!c.trustServerCertificate;
      } else if (kind === 'postgres') {
        els.pgServer.value = c.server || '';
        els.pgPort.value = String(c.port || 5432);
        els.pgDatabase.value = c.database || '';
        els.pgUser.value = c.user || '';
        els.pgPassword.value = c.password || '';
        els.pgEncrypt.checked = c.encrypt !== false;
        els.pgTrust.checked = !!c.trustServerCertificate;
      } else if (kind === 'bigquery') {
        els.bqProject.value = c.server || '';
      } else {
        els.sbUrl.value = '';
        els.sbServer.value = c.server || '';
        els.sbPort.value = String(c.port || 5432);
        els.sbUser.value = c.user || '';
        els.sbDatabase.value = c.database || '';
        els.sbPassword.value = c.password || '';
        els.sbTrust.value = c.trustServerCertificate === false ? '0' : '1';
      }
    }
  
    function stateLabel(msg) {
      const map = {
        connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected',
        unconfigured: 'Not configured', disabled: 'Disabled', error: 'Error'
      };
      return map[msg] || msg;
    }
  
    function userChangedKind() {
      availableDatabases = [];
      selectedDatabases = [];
      els.dbSearch.value = '';
      els.database.value = '';
      pgNames = [];
      els.pgDbList.hidden = true;
      bqProjects = [];
      els.bqProjectList.innerHTML = '';
      els.bqProjectList.hidden = true;
      applyKindUi();
    }
  
    function requireReady(data) {
      if (data.loginKind === 'supabase') {
        if (!data.connectionUrl.trim() && !data.server.trim()) {
          showStatus('Paste a Supabase connection URL.', 'err');
          return false;
        }
        return true;
      }
      if (data.loginKind === 'bigquery') {
        if (!data.server.trim() || !data.database.trim()) {
          showStatus('Project and dataset are required.', 'err');
          return false;
        }
        return true;
      }
      if (!data.server.trim() || !data.database.trim()) {
        showStatus('Server and database are required.', 'err');
        return false;
      }
      return true;
    }
  
    els.kindMssql.addEventListener('change', userChangedKind);
    els.kindMysql.addEventListener('change', userChangedKind);
    els.kindPostgres.addEventListener('change', userChangedKind);
    els.kindSupabase.addEventListener('change', userChangedKind);
    els.kindBigquery.addEventListener('change', userChangedKind);
    els.form.addEventListener('input', updatePanelHints);
    els.form.addEventListener('change', updatePanelHints);
    els.addConnBtn.addEventListener('click', () => vscode.postMessage({ type: 'add' }));
    els.sbUrl.addEventListener('input', updateSbPreview);
    els.dbSearch.addEventListener('input', renderDbList);
    els.dbSearch.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const query = (els.dbSearch.value || '').trim();
      if (!query) return;
      const names = allDbNames();
      const exact = names.find((name) => sameName(name, query));
      const partial = names.find((name) => name.toLowerCase().includes(query.toLowerCase()));
      applyTypedDatabase(exact || partial || query);
    });
    els.loadDbsBtn.addEventListener('click', () => requestDatabaseList());
    els.bqLoadProjectsBtn.addEventListener('click', () => {
      setBusy(true);
      vscode.postMessage({ type: 'listProjects' });
    });
    els.pgLoadDbsBtn.addEventListener('click', () => {
      const data = readForm();
      if (!data.server.trim()) {
        showStatus('Server is required to load the list.', 'err');
        return;
      }
      setBusy(true);
      vscode.postMessage({ type: 'listDatabases', ...data });
    });
    els.selectAllDbsBtn.addEventListener('click', () => {
      const boxes = els.dbList.querySelectorAll('input[type="checkbox"]');
      boxes.forEach((box) => {
        box.checked = true;
        box.disabled = box.value && defaultDatabaseName() && sameName(box.value, defaultDatabaseName());
      });
      syncSelectedFromCheckboxes();
      renderDbList();
    });
  
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        const c = msg.config;
        const kind = knownKind(c.loginKind);
        profiles = Array.isArray(msg.profiles) ? msg.profiles : [];
        const nextId = msg.selectedId || c.connectionId || '';
        if (nextId !== selectedId) {
          availableDatabases = [];
          pgNames = [];
          bqProjects = [];
          els.dbSearch.value = '';
          els.pgDbList.innerHTML = '';
          els.pgDbList.hidden = true;
          els.bqProjectList.innerHTML = '';
          els.bqProjectList.hidden = true;
          els.status.className = 'status';
          els.status.textContent = '';
        }
        selectedId = nextId;
        els.connectionId.value = selectedId;
        els.connName.value = c.name || '';
        els.pinWrap.hidden = !msg.canPinWorkspace;
        els.pinToWorkspace.checked = !!msg.pinToWorkspace;
        setLoginKind(kind);
        clearKindFields();
        fillKindFields(c);
        els.database.value = c.database || '';
        selectedDatabases = Array.isArray(c.databases) && c.databases.length
          ? c.databases.slice()
          : (c.database ? [c.database] : []);
        if (availableDatabases.length === 0) availableDatabases = selectedDatabases.slice();
        else for (const name of selectedDatabases) addUnique(availableDatabases, name);
        els.enabled.checked = c.enabled !== false;
        els.clearPassword.checked = false;
        els.pwdNote.textContent = c.hasStoredPassword
          ? 'Saved in the OS keychain for this login. Use the eye icon to show or hide it.'
          : 'Will be saved in the OS keychain for this login.';
        renderConnList();
        applyKindUi();
        const typePanel = document.getElementById('typePanel');
        if (typePanel) typePanel.open = !c.server;
        let badge = (c.name || kindLabel(kind)) + ' · ' + stateLabel(msg.state);
        if (selectedDatabases.length > 1) badge += ' · ' + selectedDatabases.length + ' DBs';
        if (msg.tableCount > 0) {
          badge += ' · ' + msg.tableCount + ' tables' + (msg.stale ? ' (cached)' : '');
          els.browseBtn.hidden = false;
        } else {
          els.browseBtn.hidden = true;
        }
        if (msg.state === 'error' && msg.lastError) badge += ' — ' + msg.lastError;
        els.badge.textContent = badge;
        setBusy(false);
      } else if (msg.type === 'status') {
        setBusy(!!msg.busy);
        showStatus(msg.message, msg.busy ? 'busy' : (msg.ok ? 'ok' : 'err'));
      } else if (msg.type === 'saved') {
        setBusy(false);
        showStatus(msg.message, msg.ok ? 'ok' : 'err');
      } else if (msg.type === 'databases') {
        setBusy(false);
        if (msg.ok) {
          if (getLoginKind() === 'postgres') {
            renderPgList(msg.databases);
            if (!els.pgDatabase.value.trim() && msg.databases.length === 1) {
              els.pgDatabase.value = msg.databases[0];
              renderPgList(msg.databases);
            }
          } else if (getLoginKind() === 'bigquery') {
            for (const name of msg.databases) addUnique(availableDatabases, name);
            const defaultDb = defaultDatabaseName();
            if (!defaultDb && availableDatabases.length === 1) setDefaultDatabase(availableDatabases[0]);
            else renderDbList();
          } else {
            availableDatabases = msg.databases.slice();
            const defaultDb = defaultDatabaseName();
            if (!defaultDb && availableDatabases.length === 1) setDefaultDatabase(availableDatabases[0]);
            else renderDbList();
          }
        }
        showStatus(msg.message, msg.ok ? 'ok' : 'err');
      } else if (msg.type === 'projects') {
        setBusy(false);
        if (msg.ok) renderBqProjectList(msg.projects);
        showStatus(msg.message, msg.ok ? 'ok' : 'err');
      }
    });
  
    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = readForm();
      if (!requireReady(data)) return;
      setBusy(true);
      vscode.postMessage({ type: 'save', ...data });
    });
    els.testBtn.addEventListener('click', () => {
      const data = readForm();
      if (!requireReady(data)) return;
      setBusy(true);
      vscode.postMessage({ type: 'test', ...data });
    });
    els.browseBtn.addEventListener('click', () => vscode.postMessage({ type: 'browseSchema' }));
    applyKindUi();
    vscode.postMessage({ type: 'ready' });
  
})();
