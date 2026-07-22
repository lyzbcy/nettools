#!/bin/bash
# 捞鱼的网络工具 · 安装脚本
# 双击此文件即可自动安装 app 到「应用程序」并首次启动
# 解决 macOS Gatekeeper 拦截未签名 app 的问题

set -e

# 切换到脚本所在目录（处理双击时的奇怪 CWD）
cd "$(dirname "$0")"

# 彩色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
echo_g(){ printf "${GREEN}$1${NC}\n"; }
echo_y(){ printf "${YELLOW}$1${NC}\n"; }
echo_r(){ printf "${RED}$1${NC}\n"; }

echo ""
echo "🌐 捞鱼的网络工具 · 安装程序"
echo "================================"
echo ""

# ① 找 app
APP_NAME="捞鱼的网络工具.app"
APP_SRC=""
# 脚本和 app 同目录
if [ -d "$APP_NAME" ]; then
    APP_SRC="$APP_NAME"
elif [ -d "../$APP_NAME" ]; then
    APP_SRC="../$APP_NAME"
fi

if [ -z "$APP_SRC" ]; then
    echo_r "✗ 找不到 $APP_NAME"
    echo_y "  请确保此脚本和 app 放在同一个文件夹里。"
    echo ""
    echo "按回车退出..."
    read
    exit 1
fi

echo_g "✓ 找到 app: $APP_SRC"

# ② 去隔离标记（关键：解决 Gatekeeper 拦截）
echo ""
echo "① 去除 macOS 隔离标记..."
xattr -cr "$APP_SRC" 2>/dev/null && echo_g "  ✓ 已清除" || echo_y "  (无隔离标记，跳过)"

# ③ 复制到应用程序
echo ""
echo "② 安装到应用程序文件夹..."
APP_DST="/Applications/$APP_NAME"
if [ -d "$APP_DST" ]; then
    echo_y "  应用程序里已有旧版，覆盖..."
    rm -rf "$APP_DST"
fi
cp -R "$APP_SRC" "$APP_DST"
echo_g "  ✓ 已安装到 $APP_DST"

# ④ 首次启动
echo ""
echo "③ 启动 app..."
open "$APP_DST"
echo_g "  ✓ 已启动！"
echo ""
echo "================================"
echo_g "✅ 安装完成！app 已在「应用程序」里。"
echo ""
echo_y "以后直接从启动台或应用程序打开即可。"
echo ""
echo "按回车关闭此窗口..."
read
