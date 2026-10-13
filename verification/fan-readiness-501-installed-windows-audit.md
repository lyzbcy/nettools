# 5.0.1 Windows 原安装包补验独立审计

**结论：本次 Windows 原安装包写路径补验在实际 GitHub Windows 管理员环境通过。** 原安装版真实可见界面经过原 preload/controller IPC，完成授权安装、SYSTEM DNS 缓存刷新、撤销授权、普通退出、原卸载器卸载与隔离目录清理。整体产品交付仍为 pending。

生产原包源为 `ac1597a5956386c4f7f5dd101ed9fd247085c4bb`，来自原 CI `38337392645`、artifact `11784644714`；本次仅补验 harness 为 `0c4a74c0ebe644121336e1dedd1cbc398f1e4550`，实际补验 [run 38351682640](https://github.com/lyzbcy/nettools/actions/runs/38351682640)。独立读取的 run/jobs 元数据均绑定该 harness SHA，completed/success，未重建生产候选包。

## 原包与真实桌面身份

| 原资产 | 大小（字节） | SHA-256 |
|---|---:|---|
| nettools-5.0.1-win-x64-setup.exe | 114206186 | `49bb9360141f964346a538e02cc11c0072d9d81a4404765826a743c1b599b66a` |
| nettools-5.0.1-win-x64.zip | 155501826 | `15a37c88b11a50d50e3f4b499b8cb9b9aefc50bb502442a1caf77a53343ef25d` |

补验报告记录的原资产大小和 SHA 与此前完整字节流审计的冻结原包一致。harness 读取固定 artifact、核算原资产 SHA/size，再使用原安装器；本次没有重做六包全部哈希。补验 evidence 的外层下载收据绑定 artifact `11791360977`，记录大小 `435121`、SHA-256 `4e998881bf093cc817cffc8b32f65077c39d3be02893f11a60d59799786f0a39`、API digest 已核对；外层下载字节未留给本审计二次读取，不能冒称本次重新计算该外层流。

原 WPF 安装器实际运行 24,064 ms，欢迎、可编辑位置、完成截图均为真实品牌 5.0.1。harness 对便携包每个参考文件与真实安装目录逐字节比较，UI 操作前后均为 111 个文件一致。本审计独立数出原 ZIP 的 111 个文件，并直接从该 ZIP 重算安装版三个 native 文件的 SHA，全部对应补验报告。隔离安装目录已正常卸载，未保留 111 个逐文件 hash 清单，因此这部分是已读过的实际比较代码与 CI 结果证据，不能称现已再次读取删除后的安装目录。NSIS 额外的 uninstaller/elevate 文件另属登记与卸载范围。

原安装 EXE PID 为 1792；进程可执行路径、独立数据参数与原 child 身份一致，CDP browser PID 同为 1792，监听仅在 runner loopback。renderer 精确对应安装目录中的原 `resources/app/ui/index.html`。原窗口可见，版本 5.0.1，smoke=false、updateFixture=null；启动环境清除了验收、Node 注入相关开关。CDP 只作为隔离环境的外部驱动，点击原 DOM 按钮；没有替换原 preload 或修改包内文件。

## 写操作与原始证据绑定

本审计读取 exact harness commit，并从原 ZIP 检查真实调用链：DOM `data-action` 按钮 → `api.call` → 原 preload 的 `nettools:call` → 原 main 的 `controller.invoke` → 平台 native。外部平台模块只用于只读佐证及失败清理；此次成功路径的三项写操作均由原可见桌面按钮发起。

| 操作 | 原始证据 | 独立核对结果 |
|---|---|---|
| 安装授权 | install-helper 截图、snapshot、原 authorization-install receipt、业务日志 | 可见“已授权”与成功 toast；原日志 started/success；receipt install、5.0.1、同用户 SID、独立 nonce、direct、closed=true，原 receipt SHA 与汇总一致；成功后授权父进程列表为空 |
| 刷新 DNS 缓存 | flush-dns 截图、actual request/result、SYSTEM task identity、业务日志 | 原界面显示 DNS cache refreshed；请求 action=flush-dns、args为空、version5.0.1；request/result/汇总使用同 nonce，请求时间处于原日志 started/success 之间，result 原字节 SHA 与汇总一致 |
| 撤销授权 | uninstall-helper 截图、snapshot、原 authorization-uninstall receipt、业务日志 | 可见“未授权”与撤销成功 toast；receipt uninstall、5.0.1、同 SID、与安装不同的 nonce、direct、closed=true，原 SHA 对应；成功后授权父进程列表为空 |

固定 flush-dns 任务精确绑定该用户授权目录：SYSTEM、Highest、ServiceAccount、单一正确 PowerShell action、固定 WorkerAction/GrantSid 参数、正确 working directory，末态 Ready。grant manifest 的 SID/version、worker SHA、安装版 worker SHA 与原 ZIP 的 `windows-network.ps1` 完全对应，SHA 为 `4b64301a0a4f20378069f9a688ea7d6761e9550ccb015e89abc29e3dae980f34`。原 worker 校验 SYSTEM 身份、grant/hash/nonce/action，再执行 Clear-DnsClientCache；本次结果属于 DNS 缓存刷新，没有据此扩展到其他网络配置写操作。

三项业务操作各有唯一 started/success 记录，无失败记录；40 次过程中观测分别显示该操作 busy/rendererBusy。五份终态 snapshot 的 renderer、5.0.1、授权状态及原业务日志前缀一致，operation=null、无 lastError；保活、自动重启、登录启动均关闭。审计报告不复述原 SID、nonce、用户路径、网络地址或网卡值。

## 撤销、退出与卸载

撤销后精确授权范围的 tasks=[]、manifest=false、worker=false。原 footer `quit-app` 按钮经原 IPC 请求退出，原 child handle close，code=0、signal=null；成功路径没有强制终止兜底。卸载前自有进程已为空。

原卸载器依据精确安装登记和原 uninstaller hash 执行，真实登记、安装目录、原快捷方式均移除，独立数据指纹保留。最终授权与安装均移除、原 app handle 已关闭、进程查询成功且 remainingProcesses=[]，符合 harness 清理谓词；beforeCleanupProcesses、failureProcessesBeforeTermination 也为空，privateFixtureRemoved=true。此前提出的“cleanupConfirmed 未包含终态进程检查”问题已在本次 exact harness 中修正。

## 图片复核与边界

全部八张 PNG 已逐张读取，SHA 与文件大小记录于结构化审计：安装器三张、guard 授权前、安装授权、DNS刷新、撤销授权、普通退出前。画面与对应场景一致。授权前图显示 guard 安全开关，授权区域在视口下方，所以“未授权”前态直接依据对应 raw snapshot；安装后、撤销后画面实际可见授权区域。

本次证据补齐旧 package-audit 中的 **Windows 原安装包写路径与真实桌面 IPC** 缺口。旧报告所述打包前 source CI 仍只证明其原来的 source 范围，不能倒推成此前已经拥有 installed-package 写路径证据。

本次 authorization receipts 明确为 `execution=direct`，对应已经具备管理员权限的 runner。**没有证明普通非管理员用户的 UAC 正路径、拒绝或输错密码。** 本次也没有修复旧 Mac 两张 rollback 设置截图，不证明本机 macOS 授权、fresh quarantine/Gatekeeper、历史公开5.0.0 grant迁移、公开 release/re-download/public update、cleaner 或 Pages/public delivery。这些继续 pending。

独立审计的 28 项证据绑定检查全部通过。只做只读证据检查和审计报告写入，没有运行授权或修网，没有启动本机 app、触发 CI、改生产源、改冻结包、改 harness、提交或发版。细证见 `fan-readiness-501-installed-windows-audit.json`。
