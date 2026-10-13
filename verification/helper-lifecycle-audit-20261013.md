# CI 助手生命周期验证修正

基底：`c9e88719ed1cfbd3bfdaf2c55123a2bd2870750b`，分支 `codex/nettools-cross-platform-delivery`。范围仅为验证脚本、回归测试和说明；产品版本及冻结包不变。

## 保留证据与结论边界

冻结 Mac CI `38368759242` 的 Intel 作业通过，arm64 在旧脚本 `ci-electron-update.cjs:72` 报助手命令不属于本次尝试。arm64 清理前 manifest 中，helper-ready 的预期身份为 PID 2185、完整 Mac 创建时间及当前 attempt 的 osascript 命令；ready/commit/confirmed/result 的绑定及新版可见 probe 已产生，result 为 confirmed。稍后的清理前后进程查询均为不存在。

旧脚本没有保存抛错那次瞬时进程查询。因此可以提出助手退出竞态假设，但不能确认当时是 Z 状态、PID 复用或其他状态。本次合成测试证明判定逻辑，不填补那次真实瞬时证据，也不宣称 arm64 实际验收已通过。

## 验证实现

- 驱动报告产生后，先读取真实 payload/ready、核对旧 PID/token，再绑定 ready 助手的操作系统创建身份和本次 attempt 命令；绑定成功后等待旧客户端关闭。
- Mac 保留原完整 24 字符 `lstart`，增加 `state` 和完整 `command`；Windows 原查询脚本保持逐字节不变，仍使用 UTC StartTime ticks、MainModule 和 CIM CommandLine。
- 退出等待始终比较 ready 阶段的绑定身份。消失、同创建身份的 Z 状态、完整不同创建身份的替代 PID 表示原实例不再运行。替代进程的无关命令不使原实例等待；生命周期模块没有任何发信号或终止 PID 的操作。
- 同一实例的正确命令仍运行时继续等待；预期或当前创建身份缺失、同实例命令错误、查询失败和超时均失败。ready 绑定也拒绝缺失或空 attempt。
- 判断/抛错前将瞬时状态、分类、查询错误和时间存入私有报告。`update-report.json` 改用现有的 0600 原子写入；不新增终端诊断打印。清理前后 manifest 保存来源匹配的历史样本，即使再次查询已经显示消失。
- 证据采集保留原 plan/driver/payload/token、固定控制文件路径、源文件物理身份和哈希校验；历史样本的角色/PID 必须来自绑定控制文件，预期创建身份和命令必须匹配该次上下文。

## RED / GREEN

使用本机 bundled Node 运行真实验收模块和纯生命周期模块，进程查询/等待在回归中注入，以免依赖一次不可控退出瞬间。

1. 首次 RED：27 项，7 项原回归通过，20 项失败。新生命周期 API 尚不存在，采集器将僵尸/缺失身份等状态错误归类且未保留历史样本；外来 PID/创建身份样本未被拒绝。
2. 集成 RED：30 项，28 项通过，2 项失败。旧 harness 忽略注入查询/保存回调，Mac 查询没有 state，未对绑定的错误 live 命令失败。
3. 绑定 RED：15 项，14 项通过，1 项失败。空/缺失 attempt 可以绑定，随后修正为失败。
4. 定向 GREEN：32 项通过；完整最终 GREEN：238 项通过，0 失败、0 跳过。完整回归包含现有隔离更新事务及本机 PowerShell 夹具；没有执行真实网络授权、重启、用户网卡配置、发行或 CI dispatch。

覆盖同创建身份但无命令的 Z 状态、消失、完整不同创建身份且无关命令的 PID 替代、缺失预期/当前创建身份、错误 live 命令、正确 live 命令继续等待及超时、查询失败、Windows 编码命令、实际 harness 查询/wait 包装、采集分类及失败瞬时样本在后续消失查询后的保留、外来历史样本拒绝、rollback 在没有 confirmed 文件时按 result 的 reopenPid 绑定观察进程样本。

## 不变证明与后续

`helper-lifecycle-proof-20261013.json` 记录 36 个受保护跟踪文件和 23 个本地冻结 ZIP/DMG/EXE 的比对：产品源码、界面、原生代码、package 文件没有变化，全部本地冻结资产大小与 SHA-256 相同。Windows 进程查询脚本 SHA-256 为 `54ecd8f462fd2a4cb55ed94c9dfb4fe72a003529807f4215c08d008aae8a8151`，基底与修改后原字节相同。

未修改、清理或提交既有未跟踪证据，包括 `fan-readiness-current-audit-20261013.md`；未推送、触发工作流或改动冻结工作树。本次新共享模块 `scripts/ci-process-lifecycle.cjs` 必须与两个验证入口一起同步。后续候选真实平台作业需独立验证，此修正不能代替发行候选的生产功能验收。
