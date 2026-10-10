# 捞鱼的网络工具

面向 Mac / Windows 的网络诊断、修复与可选保活工具，使用星星布丁原创图标。

**5.0.0 目前为候选版本，尚未正式交付。** 已有发布页的 4.x 包不是本次新版；最终下载入口会在安装、更新及软件中心验收完成后公布。

## 网络保活

- 默认关闭；启用后立即检查，随后按你选择的间隔检查，默认 30 分钟，可设 1–1440 分钟。
- 检查发现故障后，只执行对应的安全修复动作。没有授权会如实提示，不反复弹密码框。
- 本轮修复超过 5 分钟仍失败，默认无动作，等下一次定期检查。
- 自动重启需单独确认开启。重启前复查网络，提供 60 秒取消提醒；休眠、关闭保活、网络恢复或取消都会使过期任务失效。
- 进程清理未确认时停止后续操作；不确定是否已发出重启请求时保留防循环保护。

## 平台与功能

Mac 分 Apple Silicon / Intel 两个包，基于 Electron 44，最低 macOS 13；Windows 为 Windows 10+ x64。界面和保活运行在同一个主进程架构，系统网络动作分别通过 Swift 和固定 PowerShell 接口执行。

支持连接读取、八项诊断、DNS/失效本机代理/DHCP 修复与恢复、WiFi 信息、公网延迟、下载测速及公司 VPN 配置。正常代理和静态 IP 会保留；系统不给出的无线指标会明确说明。Mac VPN 连接使用 Tunnelblick，Windows 连接使用已存在的原生 VPN 名称。

设置、公司配置、日志独立于安装目录；日志可以复制和清空，并经过脱敏。反馈有预览，仅点击发送才提交。更新按上海日期每日首次检查，可手动重试，下载后校验原始 SHA-256，助手交接后才退出旧版，确认新版启动前保留旧程序。

## 开发与验收

先读 [SKILL.md](SKILL.md) 和 [docs/agent.md](docs/agent.md)。真实完成范围见 [交付进度](docs/roadmap.md)；打包、实际平台运行、升级及公开发行分别验收。

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test test/*.test.cjs
node scripts/package.cjs darwin arm64
node scripts/package.cjs darwin x64
node scripts/package.cjs win32 x64
```

打包需要固定 Electron 运行时、Pillow 和本地反馈通道配置；反馈凭据不得进入源码或日志。Mac 构建需要系统 Swift 工具链，Windows 安装器由 NSIS 和离线 WPF 前端组成。候选构建目录使用 `.noindex`，避免被系统误识别成正式安装。

Windows 原生授权、缓存刷新与撤销的实际证据见 [CI 38068374519](https://github.com/lyzbcy/nettools/actions/runs/38068374519)。这不代替完整桌面安装和自身升级验收。

旧 4.x 用户需先手动安装一次新版本。旧“超级守护”不会自动开启新的重启选项。历史说明保留于 `doc/README-4.x-history.md`。

捞鱼工作室制作 · [个人主页](https://lyzbcy.github.io/) · MIT License
