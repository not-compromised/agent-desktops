#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
/usr/bin/python3 -m unittest discover -s app/test
/usr/bin/python3 -m unittest discover -s test
while IFS= read -r file; do
  node --check "$file"
done < <(find app mcp shared -type f \( -name '*.js' -o -name '*.mjs' \))
bash -n bin/agent-desktop bin/agent-desktops scripts/check.sh
desktop-file-validate app/agent-desktops.desktop
npm audit --omit=dev
