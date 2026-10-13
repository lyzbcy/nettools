# 5.0.1 CI 原始候选包独立审计

审计源：`ac1597a5956386c4f7f5dd101ed9fd247085c4bb`；CI [38337392645](https://github.com/lyzbcy/nettools/actions/runs/38337392645)。整体交付仍为 **pending**。验收以六个冻结原资产和真实 CI 报告为边界，没有以本机构建包代替 CI 字节。

后续补证：原安装包 Windows 写路径及真实桌面 IPC 缺口已由 run `38351682640` 的新证据补齐，见 `fan-readiness-501-installed-windows-audit.md/.json`。本报告以下内容保留为当时的审计范围；其原 source CI 证据并未因此变成 installed-package 写路径证据。普通非管理员 UAC 与原 Mac rollback 截图缺口仍未补齐。

## 原资产与包结构

| 原资产 | 大小（字节） | SHA-256 |
|---|---:|---|
| nettools-5.0.1-win-x64.zip | 155501826 | `15a37c88b11a50d50e3f4b499b8cb9b9aefc50bb502442a1caf77a53343ef25d` |
| nettools-5.0.1-win-x64-setup.exe | 114206186 | `49bb9360141f964346a538e02cc11c0072d9d81a4404765826a743c1b599b66a` |
| nettools-5.0.1-mac-arm64.zip | 131361919 | `4ee757b30722505be6c8ce7c4ff6fe8bd847b1647a2eef76d423c2743d180cce` |
| nettools-5.0.1-mac-arm64.dmg | 145580497 | `1748cbd4aeef1c57de80bb3ab54a40c4fcd98628700ac231a13f6731c83941fa` |
| nettools-5.0.1-mac-x64.zip | 137053666 | `ec9be178deeeb76cc54f08f8cc42bd8e37751e03c861b7739674e00e32e185a2` |
| nettools-5.0.1-mac-x64.dmg | 152573226 | `42cf66cf900c87e48db0cae98892672878ddc69c8f48aaaf06f8c9069cb4557d` |

六资产完整字节流的大小和 SHA-256 均匹配各平台原清单及冻结目录；冻结资产与提取的 CI 原件为相同硬链。三个 ZIP 全文件 CRC 校验通过，路径布局安全。外层四个 GitHub Actions 下载 archive 已按既定流程清理；本次核对 `download-receipt.json` 的 API digest 验证收据，不能称本次重新读取了外层原字节。

审计末再次完整读取六个冻结资产，大小与 SHA-256 仍全部一致。

Mac ZIP 的主程序、NetRepair、netrepair-helper 分别为真实 arm64 / x86_64；bundle ID 为 com.laoyu.nettools、品牌名为捞鱼的网络工具、版本 5.0.1、主入口 LaoyuNetTools，原生清单两哈希匹配实际文件。两 DMG 以只读方式挂载，均包含真实品牌 app 与 /Applications 链接；320 个文件/软链逐项对应 ZIP，全包深度严格签名验证成功，随后均已卸载挂载。签名为 ad-hoc，未证明 notarization 或首次下载 Gatekeeper 放行。

本机已解压的 CI arm64 app 全部 320 个文件/软链与原 ZIP 相同，目录指纹与 CI 候选目录指纹一致。两 Mac 包的 35 个 runtime 文件加 LICENSE 均与 ac1597a 原字节一致。Windows 35 个 runtime 文件加 LICENSE 中，25 个文本文件只有 CRLF checkout 换行差异，11 个二进制资源原字节相同；规范换行后全部内容一致。builder 去除 package.json 的 scripts/devDependencies 属于正常打包差异。

Windows 主程序为 x64 PE，真实版本资源为 5.0.1.0，产品名、公司名、OriginalFilename 均为品牌值；setup 版本资源为 5.0.1。主程序和安装器的七个实际 RT_ICON PNG 彼此相同，每种尺寸解码 RGBA 均与源品牌图标对应缩放像素完全一致，最大尺寸已视觉确认。图标压缩字节与本地生成 icon.ico 不相同，但像素一致。Windows 主程序 InternalName 仍为 electron.exe，显示品牌字段正确。

两个 Mac ZIP 目录指纹直接匹配 CI before/after。Windows ZIP 在 NSIS 制作前生成，NSIS 后续向 verifiedDirectory 加入 resources/elevate.exe，所以不能直接将 ZIP 目录指纹与 NSIS 后目录等同；将原 ZIP 字节与保留 CI rollback payload 中该文件 size/hash 合并，重建指纹恰好匹配 CI 的 before/after 指纹。此补充文件依据来自 CI manifest，未在本次读取其实际二进制流。

## 实际 CI 证据与限制

新取回的 `run-jobs-metadata.json` 显示 run 和三平台 jobs 全部 completed/success，head SHA 均为 ac1597a，相关 native、desktop、packaging、Electron raw ASAR/update 测试步骤成功。审计没有独立重跑测试集，也未在没有日志的情况下新增“200 tests”计数断言。

| 证据 | 已证明范围 | 未证明范围 |
|---|---|---|
| Mac arm64 / x64 native | 原候选 app 原生引擎、root setuid helper 身份、真实 DNS 缓存刷新；helper/grant 清理成功，之后 desktop 授权状态为未安装 | CI 固定 sudo bootstrap 不证明本机授权对话框、拒绝、输错密码 |
| Windows native | ac1597a 源 src/platform 真实 RPC、私有 Unicode 配置回写、SYSTEM grant install/status、DNS 缓存刷新、grant removal | workflow 在打包前运行；不能替代原已安装包资源路径及 IPC 写操作权限证明；admin runner 不证明标准用户 UAC |
| 三平台已安装桌面 | 原品牌可见 5.0.1、真实只读网络初始化和八项诊断、17 分钟设置持久化、非法间隔保留设置、日志、反馈预览未发送、900×620 七页侧栏入口可见可点 | 未覆盖网络适配器重设或重启，也未新增本机守护验证 |
| Windows 安装/卸载 | 原 setup 启动真实 WPF 界面，欢迎、可编辑位置、完成截图显示5.0.1；原卸载器 hash、卸载登记一致，卸载后目录、登记、原快捷方式消失，数据指纹保留 | CI 安装位置是隔离目录；不证明普通用户所有机器环境 |
| 三平台私有更新 | 4.99.0 altered fixture 升级为原始5.0.1；故障5.0.2 private fixture 未ACK且exitIntent42，恢复5.0.1；visible probe与旧PID/helperPID绑定 | 不证明历史公开4.99/5.0.0升级、真实旧授权迁移或公网release下载 |

六个 update case 的 driver/probe 真实版本、进程身份、安全开关、17 分钟与 settings/config/sentinel 字节哈希一致。十二份 helper before-cleanup / after-process-exit snapshot 的控制 nonce/token/PID 绑定一致，所有实际保留文件 size/hash 重算一致；original、helper、updated/confirmed 或 reopened 在末态均 not-running，查询无错误，suite remainingProcesses 为空。CI 原候选 ZIP 与目录 before/after 不变。本报告未复述 token、公司配置内容、网络地址或网卡名称。

## 两个具体证据缺口

1. **Windows 原安装包授权写路径仍待补验。** 源文件与包内内容相同不能消除运行路径与 IPC 权限差异。补验应使用六冻原资产中的原包，在隔离真实 Windows 环境完成原包 install-helper、helper-status、DNS 缓存刷新、uninstall-helper，并检查原桌面 IPC 路径；不变更适配器、不重启。
2. **Mac 两架构回滚设置截图不对应步骤。** `update/rollback/06-preserved-seventeen-minute-setting.png` 实际显示概览页，不能称视觉验证了回滚后 guard 的17分钟。两架构 success/06 显示正确 guard17；Mac rollback probe/state/磁盘哈希仍证明17分钟和数据保留。可在不改候选包的私有回滚副本中，等到真实 guard 页面合成完成，再同时取原生截图与状态、磁盘哈希补证。

已逐张视觉读取27张 CI关键截图并记录路径及SHA，发现上述2张回滚设置图缺口。Windows欢迎、位置、完成、三平台品牌about/诊断、4.99旧副本、5.0.1更新后、回滚提示、成功升级后17分钟均与命名场景一致。八项诊断由实际native/DOM报告断言，截图视口显示可滚动列表的一部分。

首次真实下载 quarantine、用户本机授权允许/拒绝/错误密码、真实旧5.0.0 grant迁移、标准用户 UAC 与公开 release/re-download/public-update 继续 pending，不能默认整体完成。

## 审计行为

仅审计读取与报告、私有审计文件写入；未改生产源、未改冻结资产、未启动本机 GUI、未安装本机 helper、未执行本机网络写操作、未读用户公司配置、未提交或发布。只读 DMG 挂载均已卸载。结构化细证见同目录 `nettools-501-package-audit.json`。

## 补验 harness 只读复查

复查 `scripts/ci-frozen-windows-native.cjs` 与 `.github/workflows/frozen-501-native.yml`，本审计没有执行它们。它们精确下载原 run/artifact、固定核对两个 Windows 资产、运行原安装器、逐文件核对便携包与安装目录、从安装目录加载平台桥及 PowerShell，能够补验 installed resources 路径。

当前 harness 通过外部 Node 直接 require 已安装 windows.cjs，并未启动原 Electron 桌面或经过真实 preload/controller IPC；结论应限制为已安装原包平台模块与 native scripts，若要证明桌面 IPC，应另加真实应用证据。另 finally 的 cleanupConfirmed 未纳入最后一次 ownedProcesses 检查；成功路径有进程检查，失败清理仍可能在残留进程时写 true，建议将终态进程查询纳入持久化结论。这两点已报根代理处理，补验运行结果仍 pending。
