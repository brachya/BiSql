#!/usr/bin/env bash
# Package BiSql and publish it to Open VSX.
#
# Store the token once (macOS Keychain):
#   npx ovsx login brachya
# Then:
#   npm run publish:ovsx
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Packaging VSIX…"
rm -f ./*.vsix
npm run package

VSIX="$(ls -1t ./*.vsix | head -1)"
if [[ -z "$VSIX" || ! -f "$VSIX" ]]; then
  echo "ERROR: No .vsix was produced."
  exit 1
fi

echo "==> Publishing $VSIX to Open VSX…"
if [[ -n "${OVSX_PAT:-}" ]]; then
  npx --yes ovsx publish "$VSIX" --pat "$OVSX_PAT"
else
  npx --yes ovsx publish "$VSIX"
fi

echo
echo "Published. Check: https://open-vsx.org/extension/brachya/bisql"
echo "Cursor may take a few minutes to show the new version."
