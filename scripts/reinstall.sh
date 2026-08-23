#!/usr/bin/env bash
# Build the extension VSIX and install/update it in Cursor.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXT_ID="local.bisql"
OLD_EXT_ID="local.sql-python-validator"

if ! command -v cursor >/dev/null 2>&1; then
  echo "ERROR: 'cursor' CLI not found."
  echo "In Cursor: Command Palette → \"Shell Command: Install 'cursor' command in PATH\""
  exit 1
fi

echo "==> Compiling TypeScript…"
npm run compile

echo "==> Packaging VSIX…"
rm -f ./*.vsix

# Patch os.cpus() if the environment reports 0 CPUs (breaks vsce secret scan).
node --require "$ROOT/scripts/patch-cpus.cjs" \
  ./node_modules/@vscode/vsce/vsce \
  package \
  --allow-missing-repository \
  --allow-package-all-secrets

VSIX="$(ls -1t ./*.vsix | head -1)"
if [[ -z "$VSIX" || ! -f "$VSIX" ]]; then
  echo "ERROR: No .vsix was produced."
  exit 1
fi

echo "==> Removing previous install (if any): $EXT_ID"
# Ignore failure when it is not installed yet.
cursor --uninstall-extension "$EXT_ID" >/dev/null 2>&1 || true
cursor --uninstall-extension "$OLD_EXT_ID" >/dev/null 2>&1 || true

echo "==> Installing into Cursor: $VSIX"
if ! cursor --install-extension "$VSIX" --force; then
  echo
  echo "Install failed. If Cursor said to restart first:"
  echo "  1. Fully quit Cursor (Cmd+Q)"
  echo "  2. Run again: npm run reinstall"
  echo "  3. Or: Extensions → … → Install from VSIX → $VSIX"
  exit 1
fi

echo
echo "Done. Reload Cursor to finish:"
echo "  Cmd+Shift+P → Developer: Reload Window"
echo
echo "Then open: BiSql: Open Connection / Login"
