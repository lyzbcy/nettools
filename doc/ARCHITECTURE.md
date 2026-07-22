# ARCHITECTURE · v4.2 架构与桥接协议

## 总览

```text
NetRepair.swift（AppKit + WKWebView + 系统命令）
        ↕  netrepair message handler / reqId
index.html（界面、按钮、守护状态机、结果展示）
```

Swift 源码位于 `src/NetRepair.swift`，不再是不可维护的黑盒。`build.sh` 使用系统 Swift 编译器生成 app 内的 arm64 二进制并重签。

## JS ↔ Swift 协议

请求：

```javascript
window.webkit.messageHandlers.netrepair.postMessage({
  action,
  args: args || {},
  reqId
});
```

回调：

```javascript
window.__handleResult({ reqId, ok, data, error });
```

前端对普通只读操作设置 35 秒超时，对需要系统授权的操作设置 150 秒超时。超时会清理 pending 项，避免 Promise 永久悬挂。

## action 清单

| action | 是否改配置 | 作用 |
|---|---:|---|
| `get-status` | 否 | 当前默认接口、网络服务、IP、网关、系统版本 |
| `network-check` | 否 | 综合检查链路、IP、DNS、HTTPS、系统代理端口 |
| `diagnose` | 否 | 输出面向用户的诊断项目与针对性建议 |
| `wifi-info` | 否 | 解析 `system_profiler ... -json` 获取真实 WiFi 指标 |
| `ping-test` | 否 | 三个公共节点的丢包和延迟；仅作为延迟工具，不单独判定断网 |
| `speedtest` | 否 | Cloudflare 25MB 实际下载测速 |
| `vpn-status` | 否 | VPN 路由、半世界路由、公司 DNS、系统 GitLab 解析、Tailscale、代理绕过 |
| `flush-dns` | 是 | 刷新 DNS 缓存 |
| `set-dns` | 是 | 按当前物理接口映射到正确网络服务后设置/恢复 DNS |
| `clear-proxy` | 是 | 备份后临时关闭当前网络服务的系统代理，不动 Git/npm |
| `restore-proxy` | 是 | 恢复上一次代理备份 |
| `renew-dhcp` | 是 | 只给当前物理接口续租 DHCP，不切 WiFi 电源 |
| `vpn-connect` | 是 | 让 Tunnelblick 连接 `<VPN配置名>` |
| `vpn-coexist` | 是 | 精确路由 + `<公司域名>` 分域 DNS + 代理直连 |
| `vpn-coexist-reset` | 是 | 恢复共存前的 DNS/代理绕过，移除 resolver 文件 |

## 综合网络检查

`network-check` 不再把 ping 当作唯一真相：

1. 默认接口是否有 IP；
2. IP 层能否通过 ping 或固定 IP HTTP 访问；
3. 本机能否解析公共域名；
4. 系统代理是否已配置且端口有监听；
5. HTTPS 是否能通过可用代理或直连打开。

如果本机 DNS 失败、但代理能正常打开 HTTPS，网络状态仍为 `ok`，诊断仅给出 DNS 提醒。这对应用户当前“梯子远端代解析”的真实情况。

## 公网守护

守护仅在 App 运行期间生效，每 30 秒调用一次 `network-check`：

| issue | 自动尝试 |
|---|---|
| `dns` | 刷新 DNS 缓存 |
| `stale-proxy` | 备份后临时关闭失效代理 |
| `no-route` | 当前物理接口续租 DHCP |
| `http` | 刷新 DNS 后重试 |
| `no-link` | 不猜网卡、不自动改配置，提示检查物理连接 |

每次修复后重新跑完整检查。连续三轮失败则停止。管理员授权由 macOS 弹窗完成。

## VPN 共存

`vpn-coexist` 的顺序不可随意更改：

1. 从 VPN 半世界路由或公司 DNS 路由中取得真实 VPN 网关；
2. 先补 `<内网CIDR>` 和两个公司 DNS 的精确 VPN 路由；
3. 再删除 `0.0.0.0/1`、`128.0.0.0/1`，释放公网与梯子；
4. 写入 `/etc/resolver/<公司域名>`，只让 `<公司域名>` 查询公司 DNS；
5. 当前网络服务的代理绕过列表加入 `*.<公司域名>` 与 `<内网域名>`；
6. 若检测到旧版遗留的“全局公司 DNS”，恢复自动 DNS；
7. 刷新缓存并验证路由、系统解析、半世界路由和代理直连四项。

共存前的 DNS 与代理绕过列表保存在：

```text
~/Library/Application Support/local.zeen.nettools/coexist-backup.json
```

代理备份保存在同目录的 `proxy-backup.json`。
