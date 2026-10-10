---
name: laoyu-nettools-dev
description: Use when developing, repairing, packaging or releasing the 捞鱼的网络工具 macOS and Windows desktop application.
---

# 捞鱼的网络工具开发入口

面向 Mac / Windows 用户的本地网络诊断、修复和可选无人值守保活工具。

技术：Electron 本地界面与主进程、Node CommonJS；Mac Swift 原生执行层，Windows 固定动作 PowerShell。正式版本源为 `package.json.version`，目前 5.0.0 候选。

## 目录与入口

- `docs/agent.md`：唯一文档导航；接手和改模块前先查对应文档。
- `src/core/`：保活、设置、日志、反馈和更新逻辑。
- `src/platform/`：平台适配；现有 Swift 源码在 `src/` 根部。
- `ui/`：本地界面与原创素材；渲染端没有 Node 权限。
- `scripts/`：构建、更新交接、安装和验收。
- `test/`：核心与平台回归；不得真实重启用户电脑。
- `reference/`：接入与深度资料；`doc/` 是历史资料，不能据其声明当前功能。
- `release/`：最终候选包、真实哈希；不提交二进制入源码仓库。

## 开发约定

使用小写英文文件与稳定 `nettools` 产品 ID。开发在功能分支完成，提交说明改动目的。变更与模块文档、版本号同步；备份远端沿用 `lyzbcy/nettools`，不得因重构改变仓库可见性。软件公开包和更新元数据单独发布，推送源码不等于客户端完成升级。

读取 `/Users/zeen/Documents/共享/tools/软件开发` 中与任务对应的规范。日志按 `软件组件/日志系统.md`：记录分类状态和进度、可复制、脱敏；反馈只有用户点击提交才发送。图标沿用原创飞天素材，并维护该目录的 logo-registry.json。

软件中心接入前读取 `启动器适配/laoyu-launcher-adapter/SKILL.md`，维护真实包的 launcher-adapter.json 并严格自查。Windows 检查不能替代 Mac 检查，静态登记不能代替公开客户端的实际下载与打开。

## 必须保持的行为

- 保活默认关闭，正常检查间隔默认 30 分钟，可配置 1–1440 分钟。
- 发现故障后修复最多 5 分钟；超时默认无动作。自动重启必须用户明确开启，旧“超级守护”设置不自动迁移。
- 取消、停止、网络恢复和休眠使过期重启任务失效；重启前重新确认网络，并防止循环重启。
- 不将静态 IP 改成 DHCP，不关闭正常代理。备份写成功后才能修改，真正恢复后才显示成功。
- 特权操作只有固定 action 和经过校验的参数；禁止任意命令、任意路径和未引用的 shell 拼接。
- 更新校验原始包 SHA-256、保持设置与原安装位置，升级成功前保留旧版本；错误哈希不得执行。

## 状态与验收

当前正在实现双平台 5.0.0，完成范围与证据统一见 `docs/roadmap.md`。核心测试入口 `node --test test/*.test.cjs`；最终包、主窗口、原生修复和完整升级分别验收。Windows 真机验收尚需确认环境；不把 Mac 上构建 Windows 包或模拟结果写作正式交付。
