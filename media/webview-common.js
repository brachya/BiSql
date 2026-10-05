(function (root) {
  /** Max database rows or chips drawn at once in login / filter pickers. */
  var DB_LIST_WINDOW = 50;

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

  function sameName(left, right) {
    return String(left).toLowerCase() === String(right).toLowerCase();
  }

  function uniqueNames(names) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (!name) continue;
      var key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  /**
   * Decide which chips and list rows to paint for a large database picker.
   *
   * @param {{ allNames: string[], selectedNames: string[], defaultName: string, search: string }} input
   */
  function planDbPickerView(input) {
    var search = (input.search || '').trim();
    var searchLower = search.toLowerCase();
    var defaultName = (input.defaultName || '').trim();
    var allNames = uniqueNames(input.allNames || []);
    var selectedNames = uniqueNames(input.selectedNames || []);

    var selectedKeys = new Set(selectedNames.map(function (n) {
      return n.toLowerCase();
    }));
    if (defaultName) {
      selectedKeys.add(defaultName.toLowerCase());
    }

    var chipsOrdered = [];
    if (defaultName) {
      chipsOrdered.push(defaultName);
    }
    for (var s = 0; s < selectedNames.length; s++) {
      var sel = selectedNames[s];
      if (defaultName && sameName(sel, defaultName)) continue;
      chipsOrdered.push(sel);
    }
    chipsOrdered = uniqueNames(chipsOrdered);

    var chipsFiltered = searchLower
      ? chipsOrdered.filter(function (name) {
          return name.toLowerCase().includes(searchLower);
        })
      : chipsOrdered;

    var chipsVisible = chipsFiltered;
    var chipsSummary = null;
    if (!search && chipsOrdered.length > DB_LIST_WINDOW) {
      chipsVisible = [];
      chipsSummary = chipsOrdered.length + ' selected. Type to search.';
    } else if (search && chipsFiltered.length > DB_LIST_WINDOW) {
      chipsVisible = chipsFiltered.slice(0, DB_LIST_WINDOW);
      chipsSummary =
        chipsFiltered.length + ' chips match. ' + (chipsFiltered.length - DB_LIST_WINDOW) + ' more not shown.';
    }

    var unselected = allNames.filter(function (name) {
      return !selectedKeys.has(name.toLowerCase());
    });
    var unselectedMatches = searchLower
      ? unselected.filter(function (name) {
          return name.toLowerCase().includes(searchLower);
        })
      : unselected;

    var listRows = unselectedMatches;
    var listOmitted = 0;
    var listHint = null;

    if (!search && unselected.length > DB_LIST_WINDOW) {
      listRows = [];
      listHint =
        unselected.length + ' more on the server. Type a name to search and add.';
    } else if (search && unselectedMatches.length > DB_LIST_WINDOW) {
      listRows = unselectedMatches.slice(0, DB_LIST_WINDOW);
      listOmitted = unselectedMatches.length - DB_LIST_WINDOW;
    }

    var exactInAll = Boolean(
      search && allNames.some(function (name) {
        return sameName(name, search);
      })
    );

    var selectAllAllowed =
      search.length > 0 &&
      unselectedMatches.length > 0 &&
      unselectedMatches.length <= DB_LIST_WINDOW;

    return {
      chipsVisible: chipsVisible,
      chipsSummary: chipsSummary,
      chipsTotal: chipsOrdered.length,
      listRows: listRows,
      listOmitted: listOmitted,
      listHint: listHint,
      exactInAll: exactInAll,
      unselectedMatches: unselectedMatches,
      selectAllAllowed: selectAllAllowed
    };
  }

  /**
   * Pretty-print a JSON object or array. Numbers are copied as written.
   * Keep this in step with prettyJsonText in src/sql/cellDocument.ts.
   * Returns undefined when the text is not a JSON object or array.
   */
  function prettyJsonText(value) {
    var src = String(value || '').trim();
    var isObject = src.charAt(0) === '{' && src.charAt(src.length - 1) === '}';
    var isArray = src.charAt(0) === '[' && src.charAt(src.length - 1) === ']';
    if (!isObject && !isArray) return undefined;
    var i = 0;
    var out = [];
    function peek() { return src.charAt(i); }
    function skip() {
      while (i < src.length && (src.charAt(i) === ' ' || src.charAt(i) === '\n' || src.charAt(i) === '\r' || src.charAt(i) === '\t')) i += 1;
    }
    function readString() {
      var start = i;
      if (src.charAt(i) !== '"') throw new Error('json');
      i += 1;
      while (i < src.length) {
        var ch = src.charAt(i);
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') { i += 1; return src.slice(start, i); }
        if (ch < ' ') throw new Error('json');
        i += 1;
      }
      throw new Error('json');
    }
    function readNumber() {
      var start = i;
      if (src.charAt(i) === '-') i += 1;
      if (src.charAt(i) === '0') i += 1;
      else if (src.charAt(i) >= '1' && src.charAt(i) <= '9') {
        while (src.charAt(i) >= '0' && src.charAt(i) <= '9') i += 1;
      } else throw new Error('json');
      if (src.charAt(i) === '.') {
        i += 1;
        if (!(src.charAt(i) >= '0' && src.charAt(i) <= '9')) throw new Error('json');
        while (src.charAt(i) >= '0' && src.charAt(i) <= '9') i += 1;
      }
      if (src.charAt(i) === 'e' || src.charAt(i) === 'E') {
        i += 1;
        if (src.charAt(i) === '+' || src.charAt(i) === '-') i += 1;
        if (!(src.charAt(i) >= '0' && src.charAt(i) <= '9')) throw new Error('json');
        while (src.charAt(i) >= '0' && src.charAt(i) <= '9') i += 1;
      }
      return src.slice(start, i);
    }
    function readLiteral(word) {
      if (src.slice(i, i + word.length) !== word) throw new Error('json');
      i += word.length;
      out.push(word);
    }
    function parseValue(indent) {
      skip();
      var ch = peek();
      if (ch === '{') { parseObject(indent); return; }
      if (ch === '[') { parseArray(indent); return; }
      if (ch === '"') { out.push(readString()); return; }
      if (ch === '-' || (ch >= '0' && ch <= '9')) { out.push(readNumber()); return; }
      if (ch === 't') { readLiteral('true'); return; }
      if (ch === 'f') { readLiteral('false'); return; }
      if (ch === 'n') { readLiteral('null'); return; }
      throw new Error('json');
    }
    function parseObject(indent) {
      i += 1;
      skip();
      if (peek() === '}') { i += 1; out.push('{}'); return; }
      out.push('{\n');
      for (;;) {
        out.push(repeatIndent(indent + 1));
        skip();
        out.push(readString());
        skip();
        if (peek() !== ':') throw new Error('json');
        i += 1;
        out.push(': ');
        parseValue(indent + 1);
        skip();
        if (peek() === ',') { i += 1; out.push(',\n'); skip(); continue; }
        if (peek() !== '}') throw new Error('json');
        i += 1;
        out.push('\n' + repeatIndent(indent) + '}');
        return;
      }
    }
    function parseArray(indent) {
      i += 1;
      skip();
      if (peek() === ']') { i += 1; out.push('[]'); return; }
      out.push('[\n');
      for (;;) {
        out.push(repeatIndent(indent + 1));
        parseValue(indent + 1);
        skip();
        if (peek() === ',') { i += 1; out.push(',\n'); skip(); continue; }
        if (peek() !== ']') throw new Error('json');
        i += 1;
        out.push('\n' + repeatIndent(indent) + ']');
        return;
      }
    }
    function repeatIndent(n) {
      var pad = '';
      for (var k = 0; k < n; k++) pad += '  ';
      return pad;
    }
    try {
      parseValue(0);
      skip();
      if (i !== src.length) return undefined;
      return out.join('');
    } catch (err) {
      return undefined;
    }
  }

  root.bisqlWebview = {
    DB_LIST_WINDOW: DB_LIST_WINDOW,
    engineLabel: engineLabel,
    initPage: initPage,
    sameName: sameName,
    uniqueNames: uniqueNames,
    planDbPickerView: planDbPickerView,
    prettyJsonText: prettyJsonText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
