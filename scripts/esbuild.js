'use strict';

const path = require('path');
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const root = path.join(__dirname, '..');

async function main() {
    const ctx = await esbuild.context({
        entryPoints: [path.join(root, 'src/extension.ts')],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: path.join(root, 'out/extension.js'),
        external: ['vscode'],
        logLevel: 'info',
        alias: {
            '@azure/identity': path.join(__dirname, 'azure-stubs/identity.js'),
            '@azure/core-auth': path.join(__dirname, 'azure-stubs/core-auth.js'),
            '@azure/keyvault-keys': path.join(__dirname, 'azure-stubs/keyvault-keys.js')
        }
    });

    if (watch) {
        await ctx.watch();
        return;
    }

    await ctx.rebuild();
    await ctx.dispose();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
