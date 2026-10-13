#!/bin/zsh
set -euo pipefail
ROOT_DIR="${0:A:h}"
ARCH="${1:-arm64}"
if [[ "$ARCH" != arm64 && "$ARCH" != x86_64 ]]; then
  print -u2 '架构只接受 arm64 或 x86_64'
  exit 1
fi
OUT="$ROOT_DIR/build/native"
/bin/mkdir -p "$OUT"
/usr/bin/xcrun swiftc -parse-as-library -O -D HELPER -target "$ARCH-apple-macos11" "$ROOT_DIR/src/NetRepairHelper.swift" -o "$OUT/netrepair-helper"
/usr/bin/xcrun swiftc -parse-as-library -O -target "$ARCH-apple-macos11" "$ROOT_DIR/src/NetRepairHelper.swift" "$ROOT_DIR/src/NetRepair.swift" -o "$OUT/NetRepair"
/usr/bin/codesign --force --sign - "$OUT/netrepair-helper"
/usr/bin/codesign --force --sign - "$OUT/NetRepair"
/usr/bin/codesign --verify --strict "$OUT/netrepair-helper"
/usr/bin/codesign --verify --strict "$OUT/NetRepair"
HELPER_HASH=$(/usr/bin/shasum -a 256 "$OUT/netrepair-helper" | /usr/bin/cut -d ' ' -f 1)
ENGINE_HASH=$(/usr/bin/shasum -a 256 "$OUT/NetRepair" | /usr/bin/cut -d ' ' -f 1)
/usr/bin/printf '{"version":"5.0.2","helperHash":"%s","engineHash":"%s"}\n' "$HELPER_HASH" "$ENGINE_HASH" > "$OUT/native-manifest.json"
print "原生执行层构建完成：$OUT ($ARCH)"
