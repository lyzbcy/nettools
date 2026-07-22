# TECH-STACK · v4.2 技术栈与系统能力

## 技术栈

| 层 | 技术 |
|---|---|
| 原生执行层 | Swift 6、AppKit、Foundation、WebKit |
| UI | 单文件 HTML / CSS / JavaScript |
| 打包 | macOS `.app` 单包，arm64，最低目标 macOS 11 |
| 构建 | `xcrun swiftc` + ad-hoc `codesign` |
| 第三方运行依赖 | 无；VPN 功能需要用户安装 Tunnelblick |

## 关键系统命令

- 网络身份：`route -n get`、`ipconfig getifaddr`、`networksetup -listnetworkserviceorder`
- DNS：`dscacheutil`、`dig`、`/etc/resolver/<公司域名>`
- 代理：`scutil --proxy`、`networksetup -get/-set*proxy*`、`nc -z`
- 路由：`netstat -rn`、`route add/delete`
- WiFi：`system_profiler SPAirPortDataType -json`
- 公网验证：`ping` + `curl`；HTTPS 成功优先于 ICMP 结果
- VPN：Tunnelblick AppleScript + 路由/解析验证

## 网络服务名与设备名

`networksetup` 修改 DNS/代理时需要网络服务名（例如 `Wi-Fi`），不是设备名（例如 `en0`）。v4.2 会通过 `networksetup -listnetworkserviceorder` 把当前默认接口映射到正确服务，修复了旧版传 `en0` 导致设置失败的问题。

## 权限模型

只读诊断直接执行。DNS、代理、DHCP、路由和 resolver 文件变更统一通过 macOS `do shell script ... with administrator privileges` 请求授权。

守护没有常驻 root helper；因此它只在 App 运行期间工作，遇到需要系统权限的修复会显示授权窗口。这是当前版本明确、真实的能力边界。

## 构建与测试

```bash
./build.sh
./捞鱼的网络工具.app/Contents/MacOS/NetRepair --self-test
./捞鱼的网络工具.app/Contents/MacOS/NetRepair --self-test-action=speedtest
```

`--self-test` 不包含写操作。涉及 VPN 共存的最终验证必须满足：Tunnelblick 已连接公司 VPN，并由用户主动点击 App 内按钮。
