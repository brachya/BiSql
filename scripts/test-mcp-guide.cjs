'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `bisql-mcp-guide-${process.pid}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const vscodeStub = path.join(outDir, 'vscode.js');
fs.writeFileSync(vscodeStub, 'module.exports = {};\n');

esbuild.buildSync({
    entryPoints: [
        path.join(root, 'src/mcp/guide.ts'),
        path.join(root, 'src/mcp/icon.ts'),
        path.join(root, 'src/mcp/identity.ts')
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outdir: outDir,
    alias: { vscode: vscodeStub },
    external: ['@modelcontextprotocol/server']
});

const { GUIDE_MARKDOWN, GUIDE_URI, MCP_INSTRUCTIONS } = require(path.join(outDir, 'guide.js'));
const { MCP_SERVER_NAME } = require(path.join(outDir, 'identity.js'));
const {
    isPublicIconPath,
    pngIconFromBytes,
    pngIconFromUrl,
    svgIconFromText,
    loadExtensionPngIcon,
    loadExtensionSvgIcon
} = require(path.join(outDir, 'icon.js'));

function assert(name, actual, check) {
    const ok =
        typeof check === 'function'
            ? check(actual)
            : JSON.stringify(actual) === JSON.stringify(check);
    if (!ok) {
        console.error(`FAIL ${name}`);
        console.error(' actual:', actual);
        process.exitCode = 1;
        return;
    }
    console.log(`ok  ${name}`);
}

assert('server name is BiSql', MCP_SERVER_NAME, 'BiSql');
assert('guide uri', GUIDE_URI, 'bisql://docs/guide');
assert('instructions mention resource', MCP_INSTRUCTIONS.includes(GUIDE_URI), true);
assert('guide lists run_sql', GUIDE_MARKDOWN.includes('bisql_run_sql'), true);
assert('guide lists compare', GUIDE_MARKDOWN.includes('bisql_compare_schema'), true);
assert('public icon path', isPublicIconPath('/icon.png'), true);
assert('public favicon path', isPublicIconPath('/favicon.ico'), true);
assert('mcp path stays private', isPublicIconPath('/mcp'), false);

const png = loadExtensionPngIcon(root);
assert('extension icon exists', Buffer.isBuffer(png) && png.length > 0, true);
const pngData = pngIconFromBytes(png);
assert('png data uri', pngData.src.startsWith('data:image/png;base64,'), true);
assert('png data mime', pngData.mimeType, 'image/png');
const pngIcon = pngIconFromUrl('http://127.0.0.1:9/icon.png');
assert('png url', pngIcon.src, 'http://127.0.0.1:9/icon.png');
assert('png mime', pngIcon.mimeType, 'image/png');
const svg = loadExtensionSvgIcon(root);
assert('svg icon exists', typeof svg === 'string' && svg.includes('<svg'), true);
const svgIcon = svgIconFromText(svg);
assert('svg data uri', svgIcon.src.startsWith('data:image/svg+xml;base64,'), true);
assert('svg mime', svgIcon.mimeType, 'image/svg+xml');

const pluginLogo = path.join(root, 'cursor-plugins/bisql/assets/logo.png');
const pluginJson = path.join(root, 'cursor-plugins/bisql/.cursor-plugin/plugin.json');
assert('plugin logo copied', fs.existsSync(pluginLogo), true);
assert(
    'plugin manifest logo',
    JSON.parse(fs.readFileSync(pluginJson, 'utf8')).logo,
    'assets/logo.png'
);

if (process.exitCode) {
    process.exit(process.exitCode);
}
console.log('all mcp guide tests passed');
