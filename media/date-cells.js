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

  const dateCells = { dateInputType: dateInputType, sqlToInput: sqlToInput, inputToSql: inputToSql };
  if (typeof module === 'object' && module.exports) {
    module.exports = dateCells;
  }
  root.bisqlDateCells = dateCells;
})(typeof globalThis !== 'undefined' ? globalThis : this);
