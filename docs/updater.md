# 自身更新

现状：准备、独立交接及启动确认已实现；正式安装版完整升级仍分别验收。负责人：捞鱼工作室。更新时间：2026-10-11。

正式版本源 package.json。每天首次运行按 Asia/Shanghai 检查 GitHub `lyzbcy/nettools` 正式新版，尝试和成功日期分开保存；断网不记成功，手动检查可以重试。按数字语义版本比较，拒绝降级和默认预览版。

平台/架构匹配固定资源名；原始下载包必须验证 SHA-256。用户点击才下载并更新，显示进度和失败回退。校验失败不得执行。设置、日志和公司配置不放在被替换目录内。

交接使用每次独立暂存目录、256 位随机 token 和 ready/commit/abort。准备与助手都复核原始包；暂存应用以每个文件的 SHA-256、大小、目录和链接清单核验。ZIP 拒绝路径越界、大小写冲突、特殊文件、加密、多卷与 ZIP64；默认最多 20,000 项、单文件 512 MiB、解压总量 2 GiB、原始包 1 GiB。Mac 框架的相对符号链接只能留在完整外层 `.app` 内；AppleDouble 元数据验 CRC 后忽略，最终应用仍需通过深度签名验证。Windows 不创建链接，核对 PE x64 与应用包版本。

Mac 助手为独立 JXA/Foundation 进程；路径从私有 JSON 读取，系统命令使用固定程序和参数数组。Windows 使用非 detached 的短 PowerShell 引导器，`Start-Process` 创建独立助手，UTF-8 BOM 脚本与结构化 JSON 分离；两级都固定 Windows PowerShell 模块搜索路径，SHA 使用 .NET，避免继承 PowerShell 7 环境的模块故障。

助手确认就绪后才提交并退出旧客户端，最多等待旧进程 30 秒。同目录保留旧版备份，原子移动新版后正常可见启动，传递原数据目录和本次确认文件。新版主进程完成初始化且窗口真实可见后写确认；离线本身不会阻止确认。90 秒内没有正确 PID、token、版本与路径确认即恢复旧版，并重新打开。回滚后的失败记录写入仅作尽力记录，不会阻止旧版重开；只有记录成功才向旧版传报告参数，记录不可用时仍保留原数据目录正常启动。成功确认后的备份清理或警告记录失败均不撤销已经成功运行的新版。

Windows 安装版只复制当前产品精确 `DisplayName` 和 `InstallLocation` 登记指向的原卸载器，保留安装位置、其他登记字段和既有快捷方式；确认启动后更新 `DisplayVersion`。便携版没有登记时不创建登记。真实安装版升级和卸载仍需单独验收。

## 主进程接口

- `prepareUpdate(record, {signal, appPath, dataDir})`：返回 `{ready:true, token, payloadFile, attempt, version, appPath, dataDir, file}`，不替换应用。
- `handoffUpdate(ready, {oldPid, signal})`：等待真实 token 就绪确认并提交，返回后主进程停止守护、退出；同一尝试只允许一次交接。
- `abortUpdate(ready)`：撤销尚未完成的尝试，写本次 token 的 abort 标记。
- `confirmUpdateStartup({version, appPath, dataDir, argv, visible:true})`：在初始化成功、窗口 `isVisible()` 后调用；识别 `--nettools-update-confirm=<file>`。两端助手同时传 `--nettools-data=<原 dataDir>`。
- `readUpdateStartupResult({version, appPath, dataDir, argv})`：识别回滚重开时的 `--nettools-update-result=<file>`，返回经身份验证的失败信息，供主窗口展示重试/发布页回退。

确认函数不替代窗口验收，调用方必须传实际窗口状态，不能固定写 `true`。

## 当前证据

`test/update-install.test.cjs` 覆盖原始哈希、危险路径/链接、CRC、数量/大小限制、版本与架构、取消、独立 token、重复交接、Windows 引导器与 BOM，以及实际隔离 Mac 助手的成功替换、取消和无确认回滚。两端另覆盖确认后清理及警告写入双重失败、回滚时结果写入双重失败；Windows 以真实生产尾部及回滚块配模拟启动函数执行，并验证 CRLF/LF 边界，未代替完整安装升级。Mac 测试使用临时签名 Objective-C 应用与模拟启动 ACK；它证明实际助手和文件事务，不证明正式 Electron 窗口真正可见。临时目录清理先等待助手结束，再发现全部所属应用 PID 并确认退出，最后删除目录。

未替换用户已安装的应用、未提权、未重启电脑、未发布。Windows worker 的实际执行、NSIS 升级后卸载、正式 Mac/Windows 客户端窗口与数据保留，由平台安装验收提供后续证据。

旧 4.x 用户应先手动安装一次新版本；旧固化更新器不保证安全迁移。未有真实平台升级证据前，不把逻辑或模拟测试写作已完成。

## 正式 Electron 更新验收入口

三个平台安装验收脚本先完成正常安装版桌面操作，退出并核对磁盘上的 17 分钟设置以及三个安全开关。随后只在真实 `RUNNER_TEMP` 的独立临时安装副本中运行两段更新：将安装副本标为 `4.99.0` 后从本次实际 `5.0.0` 候选 ZIP 更新；再从正常 `5.0.0` 更新到私有 `5.0.1` 故障副本，故障主进程正常进入 Electron ready 后以 42 退出，不写启动确认，等待原助手回滚并由原 main 展示失败提示。Mac 修改副本后重新签名；Windows 仅修改精确当前用户安装登记的版本。`4.99.0` 与 `5.0.1` 是测试副本，不是历史发行版本，也不得作为发行资源上传。

更新传输固定标为 `fixture:true`、`published:false`、`transport:fixture.local`；符合原资源选择规则的元数据仅用于隔离测试，下载操作实际按字节复制本次候选 ZIP 并显示真实进度。窗口显示本地测试来源。测试走原 UI、Updater、校验、prepare、控制器 shutdown 与交接；不会替助手写 ready、commit、confirmed。新版正常 main 调用原启动确认后，独立观察再核对真实安装状态、窗口可见性、PID、可执行文件、数据目录、DOM 版本、17 分钟设置和公司配置/哨兵哈希，等待字体与两帧绘制后保存截图。外部脚本核对旧进程句柄关闭、助手退出和启动确认 PID。原 90 秒启动确认期限保持。

Windows 两段更新后核对原卸载器哈希、登记版本与路径，再实际调用该卸载器 `/S /currentuser`，确认登记、安装目录和既有快捷方式消失、数据保留；不通过删除目录模拟卸载。正式候选 ZIP 和未打包目录在前后做指纹比较。失败时保存 UI 报告、日志、截图与退出证据；没有确认所属进程结束或真实卸载完成时保留临时安装目录。

入口只接受 `CI=true`、真实 `RUNNER_TEMP` 下私有 `plan.json` 与匹配的 64 位小写十六进制 nonce：`NETTOOLS_UPDATE_ACCEPTANCE_PLAN` 和 `NETTOOLS_UPDATE_ACCEPTANCE_NONCE`。计划绑定当前平台、架构、安装目录和数据目录；安装、数据与证据目录不得重叠，路径不可含符号链接，Unix 计划文件和父目录需由当前用户独占。拒绝模拟平台、损坏设置、开启修复/重启/登录启动的数据以及待处理重启记录。没有这两个环境变量时不启用验收。Mac 助手以 `open --env` 显式转交四个固定 CI 环境字段，避免依赖 LaunchServices 环境继承。

供软件中心复用的 `mode:"observe"` 只观察实际当前安装：计划字段为 `{protocol:1,mode:"observe",nonce,platform,arch,suiteRoot,caseRoot,installPath,dataDir,version}`，目录约束相同。使用单个 `--nettools-data=<dataDir>` 参数启动，禁止更新确认/回滚参数和本地传输。正常初始化后写 `probe.json` 和 `evidence/01-observed-production-window.png`；观察模块不会点击操作、改设置、执行修复、发送反馈、重启或写更新握手记录。向同一 caseRoot 的 `stop.json` 写入 `{nonce}` 后走原正常退出流程。普通启动的只读网络检查、日志和自动版本检查保持；它不是原生产 `shell.openPath` 启动行为的替代证据。

本地边界与生命周期回归、原更新测试可证明入口约束和原助手事务；完整正式 Electron 成功更新、失败回滚和 Windows 真卸载仍以本次后续真实 CI 报告为准，当前不宣称已经通过。

真实 CI `38081682666` 的三平台普通安装桌面均进入了实际更新流程，但准备阶段在 `resources/default_app.asar` 报 `Invalid package`。Electron 的普通 `fs` 会把 `.asar` 当成虚拟目录；这不仅阻止新文件解压写入，也会让 stat、流式哈希和清单遍历读到归档内部。更新、原始包下载和更新观察现在共享 `raw-fs.cjs`：Electron 使用内置 `original-fs`，普通 Node 仅在精确缺少该模块时回退；Electron 缺模块、模块内部缺依赖和初始化失败均保持失败。ZIP/CRC/SHA、链接、身份、签名与清单规则保持，不删除 ASAR 文件规避问题。

`test/update-raw-fs.test.cjs` 启动固定版本的真实 Electron main（不启用 RUN_AS_NODE、不创建窗口、不访问网络、不交接更新），先证明普通 fs 的 ASAR 虚拟目录与新文件写入错误，再在临时夹具中验证有效默认 ASAR 与不透明 ASAR 的真实解压字节、物理文件大小、哈希和文件清单，确认没有归档内虚拟条目，错误 SHA 仍被拒绝，旧副本版本保持。CI 在三个平台完整构建取得固定运行时后强制再跑该回归，不能用普通 Node 的绿色结果代替 Electron 语义验证。此修复的后续完整安装更新结果仍待真实 CI。
