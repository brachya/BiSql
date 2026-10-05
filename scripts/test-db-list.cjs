'use strict';

const assert = require('assert');
const path = require('path');
const vm = require('vm');

const commonPath = path.join(__dirname, '..', 'media', 'webview-common.js');
const commonSrc = require('fs').readFileSync(commonPath, 'utf8');
const sandbox = { globalThis: {} };
vm.runInNewContext(commonSrc, sandbox);
const api = sandbox.globalThis.bisqlWebview;

function plan(input) {
  return api.planDbPickerView(input);
}

const many = [];
for (let i = 0; i < 120; i++) {
  many.push('db_' + String(i).padStart(3, '0'));
}

assert.strictEqual(api.DB_LIST_WINDOW, 50);

const emptySearch = plan({
  allNames: many,
  selectedNames: ['db_001', 'db_002'],
  defaultName: 'db_001',
  search: ''
});
assert.strictEqual(emptySearch.chipsSummary, null);
assert.strictEqual(emptySearch.chipsVisible.length, 2);
assert.strictEqual(emptySearch.listRows.length, 0);
assert.ok(emptySearch.listHint && emptySearch.listHint.includes('on the server'));

const manySelected = plan({
  allNames: many,
  selectedNames: many.slice(0, 60),
  defaultName: 'db_000',
  search: ''
});
assert.ok(manySelected.chipsSummary && manySelected.chipsSummary.includes('60 selected'));

const filtered = plan({
  allNames: many,
  selectedNames: ['db_000'],
  defaultName: 'db_000',
  search: 'db_'
});
assert.ok(filtered.unselectedMatches.length > 50);
assert.strictEqual(filtered.listRows.length, 50);
assert.ok(filtered.listOmitted > 0);
assert.strictEqual(filtered.selectAllAllowed, false);

const narrow = plan({
  allNames: ['alpha', 'beta', 'gamma'],
  selectedNames: ['alpha'],
  defaultName: 'alpha',
  search: 'a'
});
assert.strictEqual(narrow.selectAllAllowed, true);
assert.strictEqual(narrow.unselectedMatches.length, 2);
assert.ok(narrow.unselectedMatches.includes('beta'));
assert.ok(narrow.unselectedMatches.includes('gamma'));

console.log('test-db-list.cjs ok');
