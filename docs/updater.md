# 自身更新

现状：5.0.0 三平台实际安装版正常升级、可见启动、故障回滚及数据保留通过 CI 38085097075；Windows 原卸载器真实卸载通过。负责人：捞鱼工作室。更新时间：2026-10-11。

正式版本源 package.json。每天首次运行按 Asia/Shanghai 检查 GitHub `lyzbcy/nettools` 正式新版，尝试和成功日期分开保存；断网不记成功，手动检查可以重试。按数字语义版本比较，拒绝降级和默认预览版。

平台/架构匹配固定资源名；原始下载包必须验证 SHA-256。用户点击才下载并更新，显示进度和失败回退。校验失败不得执行。设置、日志和公司配置不放在被替换目录内。

交接使用每次独立暂存目录、256 位随机 token 和 ready/commit/abort。准备与助手都复核原始包；暂存应用以每个文件的 SHA-256、大小、目录和链接清单核验。ZIP 拒绝路径越界、大小写冲突、特殊文件、加密、多卷与 ZIP64；默认最多 20,000 项、单文件 512 MiB、解压总量 2 GiB、原始包 1 GiB。Mac 框架的相对符号链接只能留在完整外层 `.app` 内；AppleDouble 元数据验 CRC 后忽略，最终应用仍需通过深度签名验证。Windows 不创建链接，核对 PE x64 与应用包版本。

Mac 助手为独立 JXA/Foundation 进程；路径从私有 JSON 读取，系统命令使用固定程序和参数数组。Windows 使用非 detached 的短 PowerShell 引导器，`Start-Process` 创建独立助手，UTF-8 BOM 脚本与结构化 JSON 分离；两级都固定 Windows PowerShell 模块搜索路径，SHA 使用 .NET，避免继承 PowerShell 7 环境的模块故障。

助手确认就绪后才提交并退出旧客户端，最多等待旧进程 30 秒。同目录保留旧版备份，原子移动新版后正常可见启动，传递原数据目录和本次确认文件。新版主进程完成初始化且窗口真实可见后写确认；离线本身不会阻止确认。90 秒内没有正确 PID、token、版本与路径确认即恢复旧版，并重新打开。回滚后的失败记录写入仅作尽力记录，不会阻止旧版重开；只有记录成功才向旧版传报告参数，记录不可用时仍保留原数据目录正常启动。成功确认后的备份清理或警告记录失败均不撤销已经成功运行的新版。

Windows 安装版只复制当前产品精确 `DisplayName` 和 `InstallLocation` 登记指向的原卸载器，保留安装位置、其他登记字段和既有快捷方式；确认启动后更新 `DisplayVersion`。便携版没有登记时不创建登记。真实安装版升级和卸载仍需单独验收。

## 主进程接口

- `prepareUpdate(record, {signal, appPath, dataDir})`：返回 `{ready:true, token, payloadFile, attempt, version, appPath, dataDir, file}`，不替换应用。
- `handoffUpdate(ready, {oldPid, signal})`：等待真实 token 就绪确认并提交，调用前主进程先停止守护并等待操作清理，交接成功返回后退出；失败时恢复控制器；同一尝试只允许一次交接。
- `abortUpdate(ready)`：撤销尚未完成的尝试，写本次 token 的 abort 标记。
- `confirmUpdateStartup({version, appPath, dataDir, argv, visible:true})`：在初始化成功、窗口 `isVisible()` 后调用；识别 `--nettools-update-confirm=<file>`。两端助手同时传 `--nettools-data=<原 dataDir>`。
- `readUpdateStartupResult({version, appPath, dataDir, argv})`：识别回滚重开时的 `--nettools-update-result=<file>`，返回经身份验证的失败信息，供主窗口展示重试/发布页回退。

确认函数不替代窗口验收，调用方必须传实际窗口状态，不能固定写 `true`。

## 当前证据

`test/update-install.test.cjs` 覆盖原始哈希、危险路径/链接、CRC、数量/大小限制、版本与架构、取消、独立 token、重复交接、Windows 引导器与 BOM，以及实际隔离 Mac 助手的成功替换、取消和无确认回滚。两端另覆盖确认后清理及警告写入双重失败、回滚时结果写入双重失败；Windows 以真实生产尾部及回滚块配模拟启动函数执行，并验证 CRLF/LF 边界，未代替完整安装升级。Mac 测试使用临时签名 Objective-C 应用与模拟启动 ACK；它证明实际助手和文件事务，不证明正式 Electron 窗口真正可见。临时目录清理先等待助手结束，再发现全部所属应用 PID 并确认退出，最后删除目录。

此阶段的隔离夹具未替换用户已安装的应用，未执行真实电脑重启。后续 CI 38085097075 已完成 Windows worker、NSIS 更新后原卸载器、Mac 双芯片与 Windows 的正常可见窗口及数据保留；公开原始包再由 `verification/release/public-receipt-5.0.0.json` 匿名核验。

旧 4.x 用户应先手动安装一次新版本；旧固化更新器不保证安全迁移。未有真实平台升级证据前，不把逻辑或模拟测试写作已完成。

## 正式 Electron 更新验收入口

三个平台安装验收脚本先完成正常安装版桌面操作，退出并核对磁盘上的 17 分钟设置以及三个安全开关。随后只在真实 `RUNNER_TEMP` 的独立临时安装副本中运行两段更新：将安装副本标为 `4.99.0` 后从本次实际 `5.0.0` 候选 ZIP 更新；再从正常 `5.0.0` 更新到私有 `5.0.1` 故障副本，故障主进程正常进入 Electron ready 后以 42 退出，不写启动确认，等待原助手回滚并由原 main 展示失败提示。Mac 修改副本后重新签名；Windows 仅修改精确当前用户安装登记的版本。`4.99.0` 与 `5.0.1` 是测试副本，不是历史发行版本，也不得作为发行资源上传。

更新传输固定标为 `fixture:true`、`published:false`、`transport:fixture.local`；符合原资源选择规则的元数据仅用于隔离测试，下载操作实际按字节复制本次候选 ZIP 并显示真实进度。窗口显示本地测试来源。测试走原 UI、Updater、校验、prepare、控制器 shutdown 与交接；不会替助手写 ready、commit、confirmed。新版正常 main 调用原启动确认后，独立观察再核对真实安装状态、窗口可见性、PID、可执行文件、数据目录、DOM 版本、17 分钟设置和公司配置/哨兵哈希，等待字体与两帧绘制后保存截图。外部脚本核对旧进程句柄关闭、助手退出和启动确认 PID。原 90 秒启动确认期限保持。

Windows 两段更新后核对原卸载器哈希、登记版本与路径，再实际调用该卸载器 `/S /currentuser`，确认登记、安装目录和既有快捷方式消失、数据保留；不通过删除目录模拟卸载。正式候选 ZIP 和未打包目录在前后做指纹比较。失败时保存 UI 报告、日志、截图与退出证据；没有确认所属进程结束或真实卸载完成时保留临时安装目录。

入口只接受 `CI=true`、真实 `RUNNER_TEMP` 下私有 `plan.json` 与匹配的 64 位小写十六进制 nonce：`NETTOOLS_UPDATE_ACCEPTANCE_PLAN` 和 `NETTOOLS_UPDATE_ACCEPTANCE_NONCE`。计划绑定当前平台、架构、安装目录和数据目录；安装、数据与证据目录不得重叠，路径不可含符号链接，Unix 计划文件和父目录需由当前用户独占。拒绝模拟平台、损坏设置、开启修复/重启/登录启动的数据以及待处理重启记录。没有这两个环境变量时不启用验收。Mac 助手以 `open --env` 显式转交四个固定 CI 环境字段，避免依赖 LaunchServices 环境继承。

供软件中心复用的 `mode:"observe"` 只观察实际当前安装：计划字段为 `{protocol:1,mode:"observe",nonce,platform,arch,suiteRoot,caseRoot,installPath,dataDir,version}`，目录约束相同。使用单个 `--nettools-data=<dataDir>` 参数启动，禁止更新确认/回滚参数和本地传输。正常初始化后写 `probe.json` 和 `evidence/01-observed-production-window.png`；观察模块不会点击操作、改设置、执行修复、发送反馈、重启或写更新握手记录。向同一 caseRoot 的 `stop.json` 写入 `{nonce}` 后走原正常退出流程。普通启动的只读网络检查、日志和自动版本检查保持；它不是原生产 `shell.openPath` 启动行为的替代证据。

本地边界与生命周期回归、原更新测试证明入口约束和助手事务；后续最终 CI 38085097075 已完成三平台正式 Electron 可见成功更新、失败回滚及 Windows 真实卸载。两类证据分别记录。

真实 CI `38081682666` 的三平台普通安装桌面均进入了实际更新流程，但准备阶段在 `resources/default_app.asar` 报 `Invalid package`。Electron 的普通 `fs` 会把 `.asar` 当成虚拟目录；这不仅阻止新文件解压写入，也会让 stat、流式哈希和清单遍历读到归档内部。更新、原始包下载和更新观察现在共享 `raw-fs.cjs`：Electron 使用内置 `original-fs`，普通 Node 仅在精确缺少该模块时回退；Electron 缺模块、模块内部缺依赖和初始化失败均保持失败。ZIP/CRC/SHA、链接、身份、签名与清单规则保持，不删除 ASAR 文件规避问题。

`test/update-raw-fs.test.cjs` 启动固定版本的真实 Electron main（不启用 RUN_AS_NODE、不创建窗口、不访问网络、不交接更新），先证明普通 fs 的 ASAR 虚拟目录与新文件写入错误，再在临时夹具中验证有效默认 ASAR 与不透明 ASAR 的真实解压字节、物理文件大小、哈希和文件清单，确认没有归档内虚拟条目，错误 SHA 仍被拒绝，旧副本版本保持。CI 在三个平台完整构建取得固定运行时后强制再跑该回归，不能用普通 Node 的绿色结果代替 Electron 语义验证。此修复已在最终 CI 38085097075 的三个平台通过真实 Electron 回归及完整安装更新验收。

## 验收脚本的助手生命周期

2026-10-13 的冻结 5.0.1 验收 CI `38368759242`：Intel 通过，arm64 在 `helper-exit` 的瞬时命令检查失败。保留记录显示同次助手 PID 2185 在 ready 时具有完整创建时间及当前 attempt 命令，更新结果为 confirmed 且新版窗口 probe 已产生；清理前后采样均显示该助手消失。失败瞬间未保留，因此退出竞态是待验证假设，不能把僵尸状态写成已经确认的根因，也不能据此宣称 arm64 验收完成。

驱动报告只表示更新已准备，写入时间早于实际安装点击；此时 payload 还可能没有交接的 oldPid，助手 ready 文件也尚未产生。验证脚本在最多 120 秒内等待真实物理 ready 握手，期间继续读取绑定 actor 失败；文件出现后核对 token、版本、状态和 PID，再重新读取已交接 payload 核对旧 PID，然后绑定助手创建身份和本次 attempt 命令，最后等待旧进程关闭及更新结果。错误握手、查询失败或超时不会被当成正常等待。Mac 查询保留完整 `lstart` 并增加 `state`；Windows 保持原有 UTC StartTime ticks、可执行文件及命令查询。退出检查使用已绑定身份：消失、同创建身份的 Z 状态、完整不同创建身份的替代 PID 都表示原实例不再运行；不会等待或终止替代 PID。同实例正确命令仍运行时继续等待，错误命令、缺失预期/当前创建身份、查询失败和等待超时均保留失败。

每次检查在判定或抛错前保存完整状态、分类和时间到私有 `update-report.json`。证据采集器继续校验 plan/driver/payload/token 和固定源文件路径，并将角色/PID/预期创建身份匹配的生命周期样本存入清理前后 manifest；后续“进程已消失”的查询不会覆盖失败瞬间的样本。诊断不加入产品日志，也不向终端打印用户路径或 token。`scripts/ci-process-lifecycle.cjs` 仅供验收脚本复用，不改变生产更新助手。合成竞态回归及本地完整测试只证明验证逻辑，实际平台证据仍需新 CI。审计见 `verification/helper-lifecycle-audit-20261013.md`。

## 5.0.2 候选：取消暂存回收与私有就绪状态

2026-10-14：复现了 prepare 后取消只写 abort、仍遗留 source.zip/extract，以及下载原 ZIP 在 rename 后没有回收的问题。现在原下载 ZIP 在 prepare 成功或失败后按捕获的文件/父目录 bigint dev+ino 身份 unlink；被替换时保留并报错，不能删除替代文件。取消后晚到的 ready 进入同一清理流程；退出等待准备完成并再次检查清理，避免提前结束进程留下晚到 payload。

prepare 返回的内存 Symbol/WeakMap capability 捕获 attempt、source.zip、extract 及祖先身份，传播只限主进程对象展开。JSON 不能授权删除。取消与 handoff 竞争同一个独占锁；取消先占锁才删除原 archive/extract，保留小型握手/诊断记录。已有 handoff 锁时只写 abort 并保留助手可能还在读取的 payload，锁后结束态的回收未冒充完成。替换目录、符号链接、祖先变化、权限变化与复制序列化 ready 均拒绝；并发/重复取消安全。

Unix 维持已有 app data/updates 祖先的当前用户独占写权限要求，attempt 额外要求 0700；不强改用户目录权限。Windows 新增只读 Get-Acl/reparse 与当前令牌核验：普通令牌只接受自身 owner；已有提升运行时仅当 TokenOwner=Administrators 且该组实际启用才接受 Administrators owner（deny-only 不可）。Allow 仅当前 SID、SYSTEM、Administrators；不 takeown、不修改 ACL。Windows hosted 原验收是提升令牌，不能称为普通用户验收；真正 Windows token/目录/链接测试仅 Windows 运行，本机策略测试不代替它。

Updater 保留失败的私有 ready/download 清理身份，`cleanupPending` 阻止再次下载或安装，允许显式重试。查新导致旧 ready 失效、晚到 ready、取消和安装失败均遵守该规则。main 的 update-stage IPC 只返回正常公开 state，不再返回路径、token、payload 或 capability；内部 CI getReady 保持主进程私有。实际 renderer 的 banner 可重新打开失败清理入口，显示“重试取消并清理暂存”，隐藏再次下载/安装。

回归覆盖三次真实 prepare/cancel 无大型残留、原包生命周期、晚到结果、失效/取消/安装失败重试、被替换原包不删、锁竞争、主进程 IPC 不泄露 ready，以及固定 Electron 的实际 renderer 重试入口。测试没有触碰用户已安装应用或执行网络修改；完整候选仍需重新构建并跑三平台安装/更新验收，不能沿用 c0b44ab 的 CI 38507152751 作为本次修复证据。

本次本机完整结果：Node 24.21.0、官方 PowerShell 7.4.21、固定 Electron 44.7.0，285 tests / 284 pass / 0 fail / 1 Windows-only native-token skip。原有 PowerShell 尾部回归实际运行，没有运行时缺失跳过。外部删除的旧日志未重造，新日志保存于工作区共用 `.delivery-runtime-20261014/task-evidence/network-cancel-final.txt`。

独立 SPEC 发现并复现最后一次下载 unlink 的 await 期间取消会清空 ready，但 stage 仍发布 ready 的竞态。修正为 unlink 返回后再次检查 AbortSignal 和原 ready 对象身份，再发布就绪；实际暂停 unlink、期间取消的回归先失败后通过。updater+实际main IPC 29/29。

Windows CI 38510656355 的实际 Get-Acl 失败源于 Windows PowerShell 5.1 继承了 pwsh 7 的 PSModulePath，Microsoft.PowerShell.Security 无法加载。只在证明子进程的脚本首部将模块路径设为其自身 PSHOME/Modules 与 Machine 配置，与现有 handoff bootstrap 一致；不改变系统、父进程或 ACL。新增脚本次序契约与真正 Windows 下污染父 PSModulePath 后的 native proof 回归（也断言父值不变）。本机 updater/main/策略31 pass + 1 Windows-only pending；真实 Windows 结果待新CI，未放宽权限门槛。
