'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bisql-explorer-db-filter-'));

esbuild.buildSync({
  entryPoints: [path.join(root, 'src/ui/explorerDbFilter.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(outDir, 'explorerDbFilter.js'),
  external: ['vscode']
});

const {
  normalizeSidebarFilterVisible,
  pruneExplorerDbFilter,
  removeExplorerDbFilterForProfile,
  sidebarDatabaseNames
} = require(path.join(outDir, 'explorerDbFilter.js'));

const all = ['app', 'staging', 'other'];
const normalized = normalizeSidebarFilterVisible(
  ['staging', 'unknown', 'staging', 'extra'],
  all,
  'app'
);
assert.deepStrictEqual(normalized.sort(), ['app', 'staging'].sort());

const pruned = pruneExplorerDbFilter('p1', all, 'app', {
  p1: ['app', 'removed', 'staging']
});
assert.deepStrictEqual(pruned.p1.sort(), ['app', 'staging'].sort());

const removed = removeExplorerDbFilterForProfile({ p1: ['app'], p2: ['x'] }, 'p1');
assert.strictEqual(removed.p1, undefined);
assert.deepStrictEqual(removed.p2, ['x']);

assert.deepStrictEqual(
  sidebarDatabaseNames('p1', 'app', all, { p1: ['staging'] }).sort(),
  ['app', 'staging'].sort()
);

fs.rmSync(outDir, { recursive: true, force: true });
console.log('test-explorer-db-filter.cjs ok');
