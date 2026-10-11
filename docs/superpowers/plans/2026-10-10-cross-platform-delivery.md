# 双平台网络工具与保活 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking. 子代理只修改各任务明确列出的文件；包构建、平台运行和公开发布分别验收。

**Goal:** 交付遵守共享软件规范的 Mac / Windows 网络工具，可选择检查间隔，自动修复，5 分钟仍失败默认不处理，明确选择后才重启。

**Architecture:** Electron 主进程负责保活、设置、日志、反馈与更新。Darwin 调用已加固的 Swift 原生执行层；Windows 调用固定动作 PowerShell 与预授权后台任务。渲染界面只使用白名单 IPC，不加载远端脚本。

**Tech Stack:** Electron、Node CommonJS、原生 HTML/CSS/JavaScript、Swift、Windows PowerShell、Node test、Python 包核验。

## 1. 保活核心与设置

Files: `src/core/watchdog.cjs`, `src/core/settings.cjs`, `test/watchdog.test.cjs`, `test/settings.test.cjs`。

- [x] 用可注入的时钟和平台方法编写行为测试并确认失败：
  ```js
  const guard = new Watchdog({check, repair, restart, clock, settings});
  await guard.start();
  assert.equal(guard.snapshot().intervalMinutes, 30);
  clock.advance(300000);
  assert.equal(restartCalls, 0); // 默认永不自动重启
  ```
- [x] 实现 `start/stop/updateSettings/checkNow/cancelRestart/suspend/resume/snapshot`；单飞运行、会话 generation、命令取消、5 分钟上限、60 秒可取消重启提醒和最后一次网络复查。
- [x] 测试网络恢复、长操作超时、到期边界、取消与设置变化、休眠恢复、并发检查以及一次启动最多重启一次。所有测试使用虚拟时钟，不实际重启电脑。
- [x] 设置由严格 schema 限定 `enabled=false, intervalMinutes=30, restartOnTimeout=false, launchAtLogin=false`；旧超级守护不得开启新重启选项；原子写盘、备份损坏文件并恢复安全默认值。
- [x] 运行 Node 完整核心测试，提交本任务，独立检查需求和实现质量。

## 2. 原生执行层

Files: `src/NetRepair.swift`, `src/NetRepairHelper.swift`, `src/platform/darwin.cjs`, `src/platform/windows.cjs`, `src/platform/windows-network.ps1`, `src/platform/windows-authorization.ps1`, `test/platform.test.cjs`, `test/native-security.test.cjs`。

- [x] 先测试非法 IP/CIDR/域名、注入字符、任意 action、授权缺失、代理仍正常监听和静态 IP 场景。
- [x] Mac 增加 stdin JSON 的 `--rpc` 调用入口，返回单个结构化结果；修复 helper 验证与命令结果、备份恢复真实性、授权版本检查。所有写操作仅在 UI 明确触发或已经启用的守护中执行。
- [x] Windows 实现固定 action `get-status/network-check/diagnose/wifi-info/ping-test/speedtest/flush-dns/set-dns/clear-proxy/restore-proxy/renew-dhcp/helper-status/install-helper/uninstall-helper/vpn-status/vpn-coexist/vpn-coexist-reset`。参数由 JSON 传递，不插入命令文本；使用 `execFile` 及 AbortSignal 超时保护。
- [x] Windows 无人值守授权使用受保护目录的固定任务脚本和安装用户限定的任务权限；固定动作不接受任意程序/路径。安装、撤销有版本和权限检查。守护未授权时记录权限失败而不弹 UAC 循环。
- [x] Mac `build.sh` 编译、自检只读 action；Windows 的真实执行由 Windows 环境或 CI 验证，未验证项明确保留。
- [x] 独立安全审查后提交。

## 3. 桌面界面、日志和反馈

Files: `src/main.cjs`, `src/preload.cjs`, `src/core/log.cjs`, `src/core/feedback.cjs`, `ui/index.html`, `ui/app.js`, `ui/app.css`, `test/ipc.test.cjs`, `test/log-feedback.test.cjs`, `scripts/ui-smoke.cjs`。

- [x] 先测试未知 IPC 被拒绝、只允许本地来源、日志脱敏/轮转和反馈长度/分类约束。
- [x] 增加主题一致的窗口标题栏、托盘和退出；关闭到托盘时守护继续，明确退出停止；实际 UI 订阅主进程状态，不能在浏览器定时器中实现守护。
- [x] 守护设置支持常用间隔和整数自定义，默认不重启，明确开启确认、重启提醒和取消按钮；显示下次检查与本轮修复计时。
- [x] 展示真实网络状态、诊断、WiFi/测速、修复及撤销。一级日志与“遇到问题反馈”入口，附加日志可选和预览；提交时才发送规范指定的反馈通道。
- [x] 测试布局、正常/最小窗口、日志/反馈、权限、更新与守护开关；按共享网页测试规范由观察 Agent 独立记录。

## 4. 自身更新和发布包

Files: `src/core/updater.cjs`, `scripts/update-mac.sh`, `scripts/update-win.ps1`, `scripts/package.cjs`, `scripts/installer.nsi`, `test/updater.test.cjs`, `test/package.test.cjs`。

- [x] 先测试数字版本比较、正式/预览版、同版/降级、每日尝试/成功、平台资源、错误哈希和重复点击。
- [x] 更新仅来自固定 `lyzbcy/nettools` 正式发行：匹配确切平台架构、下载原始包后 SHA-256 校验；进度、取消、手动重试与发布页回退。
- [x] 用 ready/commit/abort 交接等待旧进程退出，在私有暂存目录准备安装；旧应用保留到新版通过验证；失败恢复旧版，设置独立于安装目录；新窗口可见。
- [x] 构建正确外层 .app 的 Mac ZIP/DMG，以及根目录主程序 `LaoyuNetTools.exe` 的 Windows ZIP 和安装器。安装器提供主题图、选择路径、非系统盘推荐及可选快捷方式。
- [x] 核验最终架构、图标、版本、完整性、资源布局和原始包 SHA，记录平台实际运行证据。

## 5. 文档、软件中心和网页

Files: `SKILL.md`, `docs/agent.md`, `docs/roadmap.md`, `docs/tech.md`, `docs/watchdog.md`, `docs/security.md`, `docs/updater.md`, `docs/feedback.md`, `docs/release.md`, `launcher-adapter.json`, `reference/launcher/*`。

- [x] 创建规范要求的项目开发入口和模块文档，同步版本；旧 `doc/` 明确历史状态并导航至新文档。
- [x] 记录稳定 `nettools` ID、平台/架构、固定主程序名、真实图标和最终包 SHA；登记图标原素材，不与其他软件重复。
- [x] 修改软件中心的目录、Windows/Mac 安装识别与准备白名单；严格自查不得仅靠远端 catalog。使用中心隔离副本测试，不覆盖其他平台在途变更。
- [x] 根据实际发行同步原介绍页，保留原网址；公开包先上传核验，再更新元数据；每次网页更新保留基底与私有备份。

## 6. 交付审核

- [x] 重读用户目标与 15 份共享规范，逐项建立“要求→源码→测试→实际证据”的矩阵。
- [x] 全部核心测试通过后，只扩大存在缺口的检查；独立代码安全与规范审查，修复重要问题。
- [x] Mac 与 Windows 分别完成实际安装、功能、更新、数据保留、中心打开链路。缺少 Windows 环境时保持候选状态并继续寻找授权验收环境。
- [x] 备份源码及报告；正式发布前不得用候选/模拟测试冒充实际交付。

## 当前证据检查点（2026-10-11）

1–4由最终生产源413a5f3和三平台CI38085097075验证，网络工具5.0.0六资产公开原字节回读通过。中心Mac0.9.3/源150c683/CI38114074313双架构四阶段、Windows0.8.7/源ccfec6a/CI38119522879四阶段均通过，正式原包公开回读。Windows Node22中文复制崩溃与官方Node24.21.0同机对照已留存，只有CI工具链改变，产品Electron30运行时不变。

两个介绍页最终源已审查和浏览器回归，公网版本JSON真实200/全文SHA匹配。中心最终源9文件已私有备份e06a7ac3并全文核验。用户明确“确认确认”后，两个原WS网址均已覆盖确认的最终HTML并匿名全文SHA回读；中心发布后立即私有备份7190fb59，9文件远端原字节核验，原tree/dirty目录/索引保留。线上版本JSON真实200、桌面/390页头必要观察已通过；5的网页和6的发布备份已闭环。详见docs/delivery.md、docs/roadmap.md及当前状态verification/delivery-state-20261011.json。
