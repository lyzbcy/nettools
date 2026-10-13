# 网络工具粉丝使用只读核验（2026-10-13）

本次正式 arm64 包的五项原生只读调用成功，网络工具的核心检查不是演示数据。仍有一项已复现的日志缺口，以及首次下载启动和系统授权交互的必需验收缺口，不能据此宣称全部粉丝使用场景已验证。

## 当前源码和执行包身份

- 当前 HEAD：b836887f1811b0a02257e8aab780038a8e840e6c；正式 5.0.0 生产源：413a5f3d5c78adf10154907487a025ac858eba8b。当前 src/ui/scripts/build.sh/package.json 相对生产源没有 Git 差异。
- 使用已有 accepted arm64 .app 内的 NetRepair，未编译或执行未核验旧文件。正式 ZIP 完整 SHA-256 与 frozen 记录一致，ZIP 内 8 个关键条目与本次执行的本地 .app 原字节绑定。
- 35 个运行源码、UI 和更新脚本与当前源码原字节一致。唯一额外对比差异为正式 package.json 移除 scripts/devDependencies；产品名称、版本、入口及其他产品身份一致。这是明确的打包元数据差异，不是运行代码差异。
- native manifest 两个哈希及 arm64 架构通过；.app 严格深层 ad-hoc 验签通过。没有 Developer ID、公证或 Windows 代码签名；ad-hoc 不能证明粉丝电脑的首次安全提示已通过。

## 本次实际只读调用

| 原生 action | RPC/进程 | 业务结果 |
| --- | --- | --- |
| get-status | ok / exit 0 | 本机地址和网关存在，DHCP；约 4.4 秒 |
| network-check | ok / exit 0 | 业务 ok，DNS 成功、系统代理路径 HTTPS 200；direct HTTPS 成功，raw 单独失败；约 5.2 秒 |
| diagnose | ok / exit 0 | 8 项真实诊断；raw 为 warn，防火墙为 info，整体 issue=ok；约 5.2 秒 |
| ping-test | ok / exit 0 | 三个公网目标响应为成功／失败／成功；约 5.2 秒 |
| helper-status | ok / exit 0 | 未安装授权，privileged=false，PERMISSION_REQUIRED；约 11 毫秒 |

RPC 成功表示完成调用，业务健康由 data.ok/issue 决定。本次 raw 和单一 ping 失败未被误报为整机断网。未安装授权没有被伪装为已授权。

## 需要修复的实现

**NFR-01 / P2：人工网络检查的日志固定写成功。** src/core/controller.cjs:100 在原生 RPC 完成后固定记录 info + ok:true，没有写网络业务 result.ok/issue。原 Controller.invoke 夹具复现：生产协议输入 RPC ok:true、业务 ok:false、issue=dns，输出仍为成功日志且没有故障分类。夹具只验证原控制器日志逻辑，没有执行或伪造本机断网。守护 _operation 已按业务 ok 记录成功/失败，但 src/core/watchdog.cjs:198 及 Controller.onLog:49 不保留故障原因。

最小修复范围：controller.cjs 对 network-check 按业务 ok 分 info/warn 并保留允许的 issue；watchdog.cjs 的检查日志保留 issue，经 Controller 传到日志。仅记录分类，不引入 IP、接口、完整系统输出或用户配置。

回归应覆盖：健康、dns/http/stale-proxy 业务失败、RPC 执行错误，确保分类不同；守护业务失败写 ok:false + issue；日志导出和反馈预览仍脱敏。未在本机制造真实网络故障，真实故障触发／安全修复仍需隔离系统验收。

## 仍缺的验收及边界

- **NFR-02 / P2：粉丝首次启动和授权。** Mac 原生 CI 明确使用 sudo bootstrap；本机 helper 不存在，本次没有打开授权对话框。介绍页告知未签名及“按系统提示处理”，但未证明下载带隔离属性的 Mac 包可按指引完成首次打开、真实 install-helper 同意／取消，以及 Windows SmartScreen/UAC 首次路径。需清洁、可交互测试环境完成，不能用 sudo 或验签代替。
- **NFR-03 / P3：状态文档冲突。** SKILL.md、docs/agent.md、docs/release.md 仍写中心／介绍页待交付，roadmap.md 已写完成；应统一现状并保留首次授权边界。
- **NFR-04 / P3：单一站点的健康边界。** Mac 核心 HTTPS/DNS 以同一公共站点为主；站点自身或地区过滤故障可能显示 http，即使其他网站可用。当前不能宣传成“所有站点已验证”；可考虑独立 HTTPS 探测源。

已有 CI 38085097075 的三平台实际安装、可见窗口、更新／回滚和 Windows 卸载证据保留。更新中的 4.99.0／5.0.1、fixture.local 是私有测试版本／传输；不是历史公网版本自动升级。实际授权写动作仅固定授权安装／撤销和 DNS 缓存刷新，不能证明真实网卡重配、VPN 共存或整机重启。六资产公网原字节回读和中心 CI 38114074313／38119522879 为 existing 证据，本次未重复下载或重跑。

本次未启动 GUI／保活，没有改网卡、DNS、代理或 VPN，没有安装／撤销 helper、请求重启、发送反馈、升级安装或部署。旧版配置存在，get-config/export-config 可能隐式迁移，因而没有调用。WiFi 指标和大流量测速不在本次实际探测范围，不声称硬件已测试。

## 数据和证据

公开摘要：verification/fan-readiness-20261013.json。实际原始 RPC、包绑定、用户配置前后摘要和日志夹具只存忽略目录 .local-tools/fan-readiness/private/，目录 0700、文件 0600；不得提交或公开原始记录。

后验确认：用户配置文件哈希和目录存在状态不变，unused-config 未创建，helper 仍不存在，执行文件原字节不变。除本次两份新核验报告外，没有改生产或已跟踪文件。

独立实施复核：已对保留的私有记录核对五项只读RPC、35项运行文件绑定、8项归档绑定、完整ZIP与原生manifest哈希；本次没有重跑原生调用。JSON的network-check/diagnose耗时分别按原始记录纠正为5196/5216毫秒，原摘要各相差1毫秒。该报告描述修复前5.0.0/基底状态，5.0.1候选进展另见本次计划与roadmap，不改写旧发行或既有最终审计结论。
