(function (root) {
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function localYmd(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function dateInputType(typeName, value) {
    const t = String(typeName || '').toLowerCase();
    if (/^rowversion$/.test(t)) return 'text';
    if (/datetime|timestamp/.test(t)) return 'datetime-local';
    if (t === 'date' || /(^|[\s(])date(\s|\(|$)/.test(t)) return 'date';
    if (t === 'time' || t === 'timetz' || /(^|[\s(])time(\s|\(|$)/.test(t)) return 'time';
    const v = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
    if (/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) return 'time';
    if (/^\d{4}-\d{2}-\d{2}[ tT]\d{2}:\d{2}/.test(v)) return 'datetime-local';
    return 'text';
  }

  function sqlToInput(inputType, value) {
    if (!value) return '';
    const v = String(value).trim();
    if (inputType === 'date') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      const parsed = new Date(v);
      if (!isNaN(parsed.getTime())) return localYmd(parsed);
      return v.slice(0, 10);
    }
    if (inputType === 'time') {
      const match = v.match(/(\d{2}:\d{2}(:\d{2}(\.\d+)?)?)/);
      return match ? match[1] : v;
    }
    if (inputType === 'datetime-local') {
      // Date-only is midnight on that calendar day. new Date('YYYY-MM-DD')
      // reads it as UTC and moves the clock into the local timezone.
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T00:00:00';
      let s = v.replace(' ', 'T');
      s = s.replace(/\.\d+/, '');
      s = s.replace(/Z$/i, '');
      s = s.replace(/[+-]\d{2}(:?\d{2})?$/, '');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s + ':00';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return s;
      const parsed = new Date(v);
      if (!isNaN(parsed.getTime())) {
        return localYmd(parsed) + 'T' + pad2(parsed.getHours()) + ':' +
          pad2(parsed.getMinutes()) + ':' + pad2(parsed.getSeconds());
      }
      return s;
    }
    return v;
  }

  function inputToSql(inputType, value) {
    if (!value) return '';
    const v = String(value).trim();
    if (inputType === 'date') return v.slice(0, 10);
    if (inputType === 'time') {
      if (/^\d{2}:\d{2}$/.test(v)) return v + ':00';
      return v;
    }
    if (inputType === 'datetime-local') {
      const s = v.replace('T', ' ');
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s + ':00';
      return s;
    }
    return v;
  }

  /**
   * Value to send for one insert-form field.
   * A blank field is omitted so a column default can run.
   * An unchanged field keeps the original cell text. The datetime picker
   * drops fractional seconds, and a date-only midnight must not be rewritten.
   * Returns `{ omit: true }` or `{ value: string | null }` (`null` is SQL NULL).
   */
  function commitInsertField(field) {
    if (field && field.nullChecked) return { value: null };
    const current = String((field && field.current) || '');
    const shown = String((field && field.shown) || '');
    const raw = String((field && field.raw) || '');
    if (current === shown) {
      if (field && (field.fresh || field.wasNull)) return { omit: true };
      return { value: raw };
    }
    const inputType = (field && field.inputType) || 'text';
    const sql = inputType === 'text' || inputType === 'textarea'
      ? current
      : inputToSql(inputType, current);
    if (sql === '') return { omit: true };
    return { value: sql };
  }

  const dateCells = {
    dateInputType: dateInputType,
    sqlToInput: sqlToInput,
    inputToSql: inputToSql,
    commitInsertField: commitInsertField
  };
  if (typeof module === 'object' && module.exports) {
    module.exports = dateCells;
  }
  root.bisqlDateCells = dateCells;
})(typeof globalThis !== 'undefined' ? globalThis : this);
