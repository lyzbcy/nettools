# 🌐 捞鱼的网络工具

> macOS 网络自诊断、自修复工具。DNS / 代理 / WiFi 体检 / 网速测试 / 公网连通守护 / 公司内网 VPN 与梯子共存。

灵感来自 Windows 上的「360 断网急救箱」，但用 macOS 原生命令实现——没有 Winsock/LSP 这些 Windows 专属的网络栈，一切靠 `networksetup` / `scutil` / `route` / `dscacheutil` 等系统工具。

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🚀 一键智能诊断 | 8 项体检：本机网络、默认路由、公网连通、DNS、网页访问、系统代理、hosts、防火墙。只读检查，不改配置 |
| 🛡️ 公网连通守护 | 每 30 秒检查公网，断了自动按 DNS→代理→DHCP 顺序对症修复。安装免密授权后可无人值守（保活远程连接） |
| 🧹 修复工具箱 | 清 DNS 缓存 / 换公共 DNS / 临时关闭失效代理 / 续租 DHCP，每个都有"撤销" |
| 📶 WiFi 体检 | 信号强度 RSSI、噪声、信噪比、信道、速率、安全协议 |
| ⚡ 网速测试 | Cloudflare 测速源 |
| 🔒 公司 VPN 共存 | 与梯子同时用：精确路由 + 分域 DNS + 代理直连，互不抢流量（需配置） |
| 🔐 免密授权 | setuid root 助手，一次安装永久免密，守护可真正无人值守 |

## 📦 安装

### 方式一：下载成品（推荐普通用户）

到 [Releases](../../releases) 下载 `捞鱼的网络工具.app`，拖到「应用程序」即可。

首次打开如果被 Gatekeeper 拦截：右键 → 打开，或在「系统设置 → 隐私与安全性」点「仍要打开」。

### 方式二：自己编译（推荐开发者）

```bash
git clone <repo-url>
cd 网络工具
./build.sh
open 捞鱼的网络工具.app
```

需要：macOS 11+ / Apple Silicon (arm64) / Xcode Command Line Tools。

## ⚙️ 配置公司 VPN（可选）

VPN 共存功能需要填写你公司的内网信息。app 首次启动会在以下位置创建空配置：

```
~/Library/Application Support/local.zeen.nettools/config.json
```

编辑它，填入你公司的值（参考 `config.example.json`）：

```json
{
  "company": {
    "name": "你的公司名",
    "intranetCIDR": "如 10.0.0.0/8",
    "intranetDNS": ["内网DNS1", "内网DNS2"],
    "resolverDomain": "如 corp.example.com",
    "internalHost": "如 gitlab.corp.example.com",
    "internalProbeIP": "如 10.0.0.5"
  },
  "vpn": {
    "enabled": true,
    "configName": "Tunnelblick 里的配置名",
    "clientAppPath": "/Applications/Tunnelblick.app"
  }
}
```

不知道这些值？问你的网络管理员，或在公司 VPN 连接时用 `dig` / `ifconfig` / `netstat -rn` 自查。

**这个配置文件只在你的本地，不进 git**——开源代码里不含任何公司内部信息。

## 🔐 免密授权（推荐开启）

默认每次网络修复都会弹系统密码框。如果你要用「公网连通守护」（无人值守），强烈建议安装免密授权：

1. 打开 app → 修复工具页 → 「🔐 免密授权」卡片
2. 点「安装免密授权」→ 输一次开机密码
3. 之后所有操作和守护都不再弹密码

原理：app 安装一个 setuid root 的助手二进制（`/usr/local/bin/netrepair-helper`），它只接受固定的 7 个网络修复动作（白名单），不接受任意命令。可随时卸载。

## 🏗️ 架构

```
NetRepair (Swift + WKWebView 壳)
    ├─ index.html (前端 UI，单文件)
    └─ 调用 Swift action ←→ JS 桥接
            ↓ 特权操作
netrepair-helper (setuid root 二进制，固定白名单)
```

详见 [`doc/`](doc/) 目录。

## 🔒 安全说明

- 免密助手只认固定的 7 个 action（flush-dns / set-dns / clear-proxy / restore-proxy / renew-dhcp / vpn-coexist / vpn-coexist-reset），拒绝任意命令
- 参数严格校验（IP / 网卡名正则），防注入
- 可随时卸载，恢复弹密码模式
- 不存储任何密码

## 📄 License

MIT — 自由使用、修改、分发。

## 💖 关于作者

由 [捞鱼](https://lyzbcy.github.io/) 制作 · 捞鱼工作室 · 「一个弱小但有梦想的开发者」

如果帮到了你，欢迎[请喝杯奶茶](https://lyzbcy.github.io/) 🧋
