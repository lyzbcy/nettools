# 项目文档导航

现状：正式 5.0.0 已公开；软件中心 Mac 0.9.3 / Windows 0.8.7 和两个原网址已完成旧版本同步。冻结 5.0.1 保持不变；本次 5.0.2 日志与反馈修复候选待重新打包及正式验收，首次安全提示与真实 Mac 授权仍未验收。负责人：捞鱼工作室。更新时间：2026-10-13。

接手先读根目录 SKILL.md，再读 roadmap.md。改对应模块时读取下列文档；不要用旧 doc/ 的版本说明替代当前行为。

- `roadmap.md`：当前实现、证据与未完成交付门槛。
- `tech.md`：主进程、渲染桥、平台执行与目录边界。
- `watchdog.md`：检查间隔、修复超时、可选重启与取消。
- `security.md`：特权助手、参数校验、快照与权限。
- `updater.md`：每日检查、下载校验、升级交接和恢复。
- `feedback.md`：日志脱敏、问题反馈与用户自主提交。
- `release.md`：平台包、签名边界、软件中心接入及公开发行顺序。
- `delivery.md`：共享规范逐项实现状态、证据类型与正式交付门槛。
- `superpowers/specs/2026-10-10-cross-platform-delivery-design.md`：用户目标与方案。
- `superpowers/plans/2026-10-10-cross-platform-delivery.md`：历史交付任务清单。
- `superpowers/plans/2026-10-13-fan-logging-fix.md`：日志与反馈修复、候选包和首次使用验收计划。

共享规范入口：`/Users/zeen/Documents/共享/tools/软件开发`。桌面接入具体读取其 `启动器适配/laoyu-launcher-adapter/SKILL.md` 与 `references/适配规范.md`。
