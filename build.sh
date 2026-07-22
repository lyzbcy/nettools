#!/bin/zsh
set -euo pipefail

ROOT_DIR="${0:A:h}"
APP_DIR="$ROOT_DIR/捞鱼的网络工具.app"
SOURCE_FILE="$ROOT_DIR/src/NetRepair.swift"
HELPER_SOURCE="$ROOT_DIR/src/NetRepairHelper.swift"
BIN_FILE="$APP_DIR/Contents/MacOS/NetRepair"
HELPER_FILE="$APP_DIR/Contents/Resources/netrepair-helper"

echo "==> 编译免密助手 netrepair-helper"
/usr/bin/xcrun swiftc \
  -O \
  -target arm64-apple-macos11 \
  "$HELPER_SOURCE" \
  -o "$HELPER_FILE"

echo "==> 编译主程序 NetRepair"
/usr/bin/xcrun swiftc \
  -O \
  -target arm64-apple-macos11 \
  -framework Cocoa \
  -framework WebKit \
  "$SOURCE_FILE" \
  -o "$BIN_FILE"

echo "==> 签名"
/usr/bin/xattr -cr "$APP_DIR"
/usr/bin/codesign --force --deep --sign - "$APP_DIR"
/usr/bin/codesign --verify --deep --strict "$APP_DIR"

echo "构建完成：$APP_DIR"
echo "  主程序：$BIN_FILE"
echo "  免密助手（打包在 Resources）：$HELPER_FILE"
echo ""
echo "用户首次使用需在 app 内点「安装授权」把 netrepair-helper 装到 /usr/local/bin 并设 setuid"
