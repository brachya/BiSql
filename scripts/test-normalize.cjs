'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-normalize-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/parser/normalizeSql.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'normalizeSql.js')
});

const { normalizeEmbeddedSql } = require(path.join(outDir, 'normalizeSql.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : actual === check;
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', JSON.stringify(actual));
        console.error(' expect:', typeof check === 'function' ? check.toString() : JSON.stringify(check));
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

const liveUnread = `
    SELECT count(*) as unread FROM physician_alerts_v WHERE note_effective_date >= DATE_SUB(convert_tz(now(),'UTC', 'US/Eastern'), INTERVAL {hours} HOUR) AND note_effective_date > '{last_read_tstamp}' {filter_clause}
`;
const liveNorm = normalizeEmbeddedSql(liveUnread);
assert('live unread does not compare to empty string', liveNorm, (sql) => !sql.includes("> ''") && !sql.includes(">''"));
assert('live unread uses NULL for quoted timestamp', liveNorm, (sql) => /note_effective_date\s*>\s*NULL/.test(sql));
assert('live unread drops filter fragment', liveNorm, (sql) => !sql.includes('filter_clause') && !/{filter_clause}/.test(sql));
assert('live unread binds INTERVAL hours', liveNorm, (sql) => /INTERVAL\s+NULL\s+HOUR/.test(sql));

const keepEmpty = `SELECT ifnull(npi, '') AS physician_npi, ifnull(concat(a, ', ', b), '') AS name FROM t`;
assert('keeps real empty string literals', normalizeEmbeddedSql(keepEmpty, false), keepEmpty);

const fragment = `SELECT 1 FROM t WHERE x >= DATE_SUB(now(), INTERVAL 1 HOUR) {access_filters}`;
assert('drops clause fragments after )', normalizeEmbeddedSql(fragment), (sql) => sql.includes('HOUR)') && !sql.includes('NULL') && !sql.includes('access_filters'));

const unquoted = `SELECT * FROM t WHERE id = {user_id}`;
assert('unquoted f-string value becomes NULL', normalizeEmbeddedSql(unquoted), 'SELECT * FROM t WHERE id = NULL');

const prefixed = `SELECT * FROM t WHERE code = 'id-{n}'`;
assert('quoted prefix+f-string becomes NULL', normalizeEmbeddedSql(prefixed), 'SELECT * FROM t WHERE code = NULL');

const optionalCols = `
        SELECT
            {"med_admin.performed_by_id AS nurse_id, ANY_VALUE(med_admin.performed_by_name) AS nurse_name," if group_by == "nurse" else ""}
            SUM({total_condition}) AS total,
            SUM(({total_condition}) AND ({missed_condition})) AS missed
        FROM med_admin
        WHERE
            TRUE
            {filters}
        GROUP BY {group_by_clause}
`;
const optionalNorm = normalizeEmbeddedSql(optionalCols);
assert('optional select cols do not sit against SUM', optionalNorm, (sql) => !/NULL\s+SUM\s*\(/.test(sql));
assert('optional select cols still bind SUM args', optionalNorm, (sql) => /SUM\s*\(\s*NULL\s*\)/.test(sql) && /SUM\s*\(\s*\(\s*NULL\s*\)\s+AND\s+\(\s*NULL\s*\)\s*\)/.test(sql));
assert('optional select cols drop WHERE fragment', optionalNorm, (sql) => /WHERE\s+TRUE\s+GROUP BY\s+NULL/.test(sql));
assert('lone select placeholder stays NULL', normalizeEmbeddedSql('SELECT {cols} FROM t'), 'SELECT NULL FROM t');

if (process.exitCode) {
    process.exit(1);
}
console.log('All normalize tests passed.');
