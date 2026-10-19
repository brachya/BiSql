/**
 * One-off: count guessed vs declared relations on a cached schema snapshot.
 * Usage: npx esbuild scripts/countGuesses.ts --bundle --platform=node --outfile=out/countGuesses.js
 *        node out/countGuesses.js /path/to/schema-*.json mysql
 */
import fs from 'node:fs';
import { SchemaCache, SerializedSnapshot } from '../src/db/schemaCache';
import { DbEngine } from '../src/db/engines';
import { buildTableRelations } from '../src/sql/tableRelations';

const path = process.argv[2];
const engine = (process.argv[3] || 'mysql') as DbEngine;
if (!path) {
    console.error('Usage: node countGuesses.js <schema.json> [engine]');
    process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(path, 'utf8')) as SerializedSnapshot;
const cache = SchemaCache.deserialize(snapshot, engine);
const bundles = buildTableRelations(cache.tables);

let declared = 0;
let guessed = 0;
let tablesWithLinks = 0;
const byDb = new Map<string, { declared: number; guessed: number }>();

for (const table of cache.tables) {
    const bundle = bundles.get(table.qualifiedName.toLowerCase());
    if (!bundle) continue;
    const d = bundle.outgoing.filter((r) => !r.guessed).length;
    const g = bundle.outgoing.filter((r) => r.guessed).length;
    if (d + g + bundle.incoming.length === 0) continue;
    tablesWithLinks += 1;
    declared += d;
    guessed += g;
    const bucket = byDb.get(table.database) ?? { declared: 0, guessed: 0 };
    bucket.declared += d;
    bucket.guessed += g;
    byDb.set(table.database, bucket);
}

console.log(`Tables in cache: ${cache.tables.length}`);
console.log(`Tables with any relation: ${tablesWithLinks}`);
console.log(`Outgoing declared: ${declared}, guessed: ${guessed}`);
for (const [db, counts] of [...byDb.entries()].sort()) {
    console.log(`  ${db}: declared ${counts.declared}, guessed ${counts.guessed}`);
}
