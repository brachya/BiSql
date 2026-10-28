'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const { dateInputType, sqlToInput, inputToSql, commitInsertField } = require(path.join(root, 'media/date-cells.js'));

const outDir = path.join(os.tmpdir(), `bisql-date-cells-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/sql/sqlDates.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'sqlDates.js')
});

const { formatSqlDate } = require(path.join(outDir, 'sqlDates.js'));

function assert(name, actual, check) {
    const ok = typeof check === 'function' ? check(actual) : actual === check;
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', JSON.stringify(actual));
        console.error(
            ' expect:',
            typeof check === 'function' ? check.toString() : JSON.stringify(check)
        );
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

assert('date column uses date input', dateInputType('date', '2099-01-01'), 'date');
assert('datetime column uses datetime-local', dateInputType('datetime', ''), 'datetime-local');
assert('timestamp is datetime, not id', dateInputType('timestamp', ''), 'datetime-local');
assert('rowversion stays text', dateInputType('rowversion', ''), 'text');
assert('time column uses time input', dateInputType('time', '12:30:00'), 'time');
assert('plain date stays a date', sqlToInput('date', '2099-01-01'), '2099-01-01');
assert(
    'midnight datetime stays on that calendar day',
    sqlToInput('datetime-local', '2099-01-01'),
    '2099-01-01T00:00:00'
);
assert(
    'datetime picker drops fractions for display',
    sqlToInput('datetime-local', '2099-01-01 12:30:00.123'),
    '2099-01-01T12:30:00'
);

const shownFraction = sqlToInput('datetime-local', '2099-01-01 12:30:00.123');
assert(
    'unchanged datetime keeps fractional seconds',
    commitInsertField({
        raw: '2099-01-01 12:30:00.123',
        shown: shownFraction,
        current: shownFraction,
        fresh: false,
        wasNull: false,
        inputType: 'datetime-local'
    }),
    (result) => result.value === '2099-01-01 12:30:00.123'
);
assert(
    'unchanged date-only midnight keeps the original text',
    commitInsertField({
        raw: '2099-01-01',
        shown: '2099-01-01T00:00:00',
        current: '2099-01-01T00:00:00',
        fresh: false,
        wasNull: false,
        inputType: 'datetime-local'
    }),
    (result) => result.value === '2099-01-01'
);
assert(
    'a new blank field is omitted',
    commitInsertField({
        raw: '',
        shown: '',
        current: '',
        fresh: true,
        wasNull: false,
        inputType: 'text'
    }),
    (result) => result.omit === true
);
assert(
    'clearing a copied value omits the column',
    commitInsertField({
        raw: 'alice',
        shown: 'alice',
        current: '',
        fresh: false,
        wasNull: false,
        inputType: 'text'
    }),
    (result) => result.omit === true
);
assert(
    'an unchanged empty string stays an empty string',
    commitInsertField({
        raw: '',
        shown: '',
        current: '',
        fresh: false,
        wasNull: false,
        inputType: 'text'
    }),
    (result) => result.value === ''
);
assert(
    'the NULL box stores NULL',
    commitInsertField({
        raw: 'alice',
        shown: 'alice',
        current: 'alice',
        nullChecked: true,
        fresh: false,
        wasNull: false,
        inputType: 'text'
    }),
    (result) => result.value === null
);

const roundTrip = inputToSql(
    'datetime-local',
    sqlToInput('datetime-local', '2099-01-01 12:30:00')
);
assert('datetime round-trips through datetime-local', roundTrip, '2099-01-01 12:30:00');

assert(
    'time round-trips',
    inputToSql('time', sqlToInput('time', '12:30:00')),
    '12:30:00'
);
assert(
    'pg timestamptz offset is stripped for the picker',
    sqlToInput('datetime-local', '2099-01-01 12:30:00+00'),
    '2099-01-01T12:30:00'
);

const iso = '2098-12-31T22:00:00.000Z';
const leaked = new Date(iso);
const localDate =
    leaked.getFullYear() +
    '-' +
    pad2(leaked.getMonth() + 1) +
    '-' +
    pad2(leaked.getDate());
assert('leftover ISO date uses local calendar', sqlToInput('date', iso), localDate);

assert(
    'UTC midnight Date prints as a date',
    formatSqlDate(new Date(Date.UTC(2099, 0, 1))),
    '2099-01-01'
);
assert(
    'UTC Date with time keeps the clock',
    formatSqlDate(new Date(Date.UTC(2099, 0, 1, 12, 30, 0))),
    '2099-01-01 12:30:00'
);

fs.rmSync(outDir, { recursive: true, force: true });
