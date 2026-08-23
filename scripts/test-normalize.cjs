'use strict';

const { normalizeEmbeddedSql } = require('../out/parser/normalizeSql');

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

if (process.exitCode) {
    process.exit(1);
}
console.log('All normalize tests passed.');
