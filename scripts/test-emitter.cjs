'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-emitter-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
    entryPoints: [path.join(root, 'src/db/emitter.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'emitter.js')
});

const { Emitter } = require(path.join(outDir, 'emitter.js'));

function assert(name, actual, expected) {
    if (actual !== expected) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', actual);
        console.error(' expect:', expected);
        process.exitCode = 1;
        return;
    }
    console.log(`PASS ${name}`);
}

const emitter = new Emitter();
const seen = [];
emitter.event(() => {
    throw new Error('listener failed');
});
emitter.event((value) => {
    seen.push(value);
});

const errors = [];
const write = process.stderr.write;
process.stderr.write = (chunk, ...rest) => {
    errors.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
};
console.error = (...args) => {
    errors.push(args.map(String).join(' '));
};

emitter.fire('ok');
process.stderr.write = write;

assert('later listener still runs', seen.join(','), 'ok');
assert('thrown listener is reported', errors.some((line) => line.includes('listener failed')), true);

if (process.exitCode) {
    process.exit(1);
}
console.log('All emitter tests passed.');
