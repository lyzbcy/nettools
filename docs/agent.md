# 项目文档导航

现状：正式 5.0.0 已公开；软件中心 Mac 0.9.3 / Windows 0.8.7 和两个原网址已完成旧版本同步。冻结 5.0.1 保持不变；5.0.2正式生产源 `cee61b6ea94c03f6453306f52cadb9d643602c35` 已通过三平台CI [38523318220](https://github.com/lyzbcy/nettools/actions/runs/38523318220)。六个原包已正式公开，匿名完整回读 SHA-256/大小匹配，`/latest` 为5.0.2；回执 `verification/release/public-receipt-5.0.2.json`。Mac arm64 浏览器原包下载、保留隔离标记、系统“仍要打开”入口、实际隔离运行窗口和真实授权同意/取消已验收。取消返回 `AUTH_CANCELLED`，原助手身份及原字节不变，随后只读 RPC 证明原授权仍有效。Windows SmartScreen 首次下载提示未单独观察，未签名说明保持。软件中心与两个原介绍页的5.0.2同步正在进行，产品发行不等于中心上架完成。负责人：捞鱼工作室。更新时间：2026-10-14。

真实旧助手完整权限判定及暂存复验修复已进入 `cee61b6ea94c03f6453306f52cadb9d643602c35`，三平台 CI `38523318220` 成功；原六包 `release/final-fd8a9a7/` 保持不可变且不用于发行。当前六包封存于 `release/final-cee61b6/`，已逐项重算 SHA-256/大小。2026-10-14 本机生产 UI 完成授权且本人确认系统密码提示和自行输入密码，只读 RPC 验证当前 5.0.2 root/4755 身份；Mac arm64 真实浏览器首次打开及授权取消也已验收；Windows SmartScreen提示未单独观察，不能把Mac结果泛化为所有系统提示。

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

当前Windows适配输入为根目录 `launcher-adapter.json`（5.0.2）；包核对通过，中心发行元数据仍为5.0.0，严格自查5项失败及报告位置见 `release.md`。
