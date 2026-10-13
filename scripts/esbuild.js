'use strict';

const path = require('path');
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const mcpOnly = process.argv.includes('--mcp-only');
const root = path.join(__dirname, '..');

const azureAliases = {
    '@azure/identity': path.join(__dirname, 'azure-stubs/identity.js'),
    '@azure/core-auth': path.join(__dirname, 'azure-stubs/core-auth.js'),
    '@azure/keyvault-keys': path.join(__dirname, 'azure-stubs/keyvault-keys.js')
};

async function buildExtension() {
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
        alias: azureAliases
    });

    if (watch) {
        await ctx.watch();
        return ctx;
    }

    await ctx.rebuild();
    await ctx.dispose();
    return undefined;
}

async function buildMcp() {
    // ponytail: vscode stub keeps sqlExtractor editor imports out of the CLI bundle.
    // Upgrade path: split token analysis from sqlExtractor.ts.
    await esbuild.build({
        entryPoints: [path.join(root, 'src/mcpCli/main.ts')],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: path.join(root, 'npm/bisql-mcp/dist/index.cjs'),
        banner: { js: '#!/usr/bin/env node' },
        logLevel: 'info',
        alias: {
            ...azureAliases,
            vscode: path.join(__dirname, 'vscode-stub.js')
        }
    });
}

async function main() {
    if (mcpOnly) {
        await buildMcp();
        return;
    }

    const extensionCtx = await buildExtension();
    await buildMcp();

    if (extensionCtx) {
        // watch mode: extension watcher stays open; MCP is built once at start.
        return;
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
