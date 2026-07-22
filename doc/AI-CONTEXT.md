# AI-CONTEXT · 给 AI 的精简上下文

> 先读本文件，再按需读 `ARCHITECTURE.md`。事实依据优先级：真实只读检测 → `src/NetRepair.swift` → 文档 → 历史聊天结论。

## 使命

做好 macOS 网络维护：网络诊断与修复、公司 VPN 连接与梯子共存、公网连通守护；同时满足单包分享、星星布丁素材、捞鱼个人品牌和可维护文档。使命原文见上级 `初心与使命.md`。

## v4.3 当前架构（免密授权版）

- `src/NetRepair.swift`：主程序。WKWebView 壳 + JS 桥接 + 所有 action。特权操作优先走 helper，未装则 fallback 到 osascript 弹密码。
- `src/NetRepairHelper.swift`：**setuid root 助手**。固定 action 白名单（7 个特权操作），不接受任意命令。编译后由用户点「安装授权」装到 `/usr/local/bin/netrepair-helper`。
- `捞鱼的网络工具.app/Contents/Resources/index.html`：界面与前端状态机。
- `捞鱼的网络工具.app/Contents/Resources/netrepair-helper`：打包进 app 的 helper 二进制。
- `build.sh`：编译 helper + 主程序 + ad-hoc 签名。

## 免密授权机制（v4.3 核心）

用户痛点：每个特权操作（清 DNS/换 DNS/清代理/续租/VPN 共存）都弹一次密码框，守护每 30s 修复也会弹，无法无人值守。

方案：app 内「安装授权」按钮 → 一次性输密码 → 把 helper 二进制装到 `/usr/local/bin/` 并 setuid root → 之后所有特权操作免密。

- helper 只认固定 action（flush-dns/set-dns/clear-proxy/restore-proxy/renew-dhcp/vpn-coexist/vpn-coexist-reset），拒绝任意命令
- 参数严格校验（IP 格式、网卡名格式）
- macOS 默认忽略 shell 脚本的 setuid（`kern.sugid_scripts=0`），所以 helper 必须是编译二进制
- 可随时「卸载授权」恢复弹密码模式

## action 清单（18 个）

只读（无需密码）：`get-status` `network-check` `diagnose` `wifi-info` `ping-test` `speedtest` `vpn-status` `helper-status`
特权（走 helper 免密 / fallback osascript）：`flush-dns` `set-dns` `clear-proxy` `restore-proxy` `renew-dhcp` `vpn-connect` `vpn-coexist` `vpn-coexist-reset`
授权管理：`install-helper` `uninstall-helper`

## VPN 共存方案（分域 DNS，勿改）

`<内网域名>` 等公司域名是内网服务，正确 IP 是 <内网前缀>.x.x。但 Tailscale 的 MagicDNS（100.100.100.100）劫持 DNS 查询，把 <公司域名> 解析成错误的公网 IP（<公网错误IP>）。

解法：`vpnCoexist()` 写 `/etc/resolver/<公司域名>`（macOS 分域 DNS 机制），让 `*.<公司域名>` 只问公司 DNS（<公司DNS1>），其他域名继续走 Tailscale。两边互不打架，谁都不用关。

## 守护职责（只盯公网）

对应使命第三条。每 30s 综合 network-check，异常时对症修复（flush-dns/clear-proxy/renew-dhcp）。走 helper 免密，可无人值守保活远程连接。不盯 VPN 内网。

## 红线

1. 改 Swift 后必须 `./build.sh` 重新编译（helper 和主程序都要编译）
2. helper 必须是编译二进制，不能是脚本（内核忽略脚本 setuid）
3. helper 的 action 白名单不能放宽（安全约束）
4. VPN 共存的分域 DNS 方案不要改成写 hosts 或全局 DNS
5. 守护不要改成盯内网（使命第三条只要公网）
