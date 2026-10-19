#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../native"
mkdir -p bin
for helper in keyboard pointer still; do
  make -C "$helper" "omabox-$helper"
  install -m755 "$helper/omabox-$helper" "bin/agent-desktop-$helper"
done
