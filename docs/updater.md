# 自身更新

现状：准备、独立交接及启动确认已实现；正式安装版完整升级仍分别验收。负责人：捞鱼工作室。更新时间：2026-10-11。

正式版本源 package.json。每天首次运行按 Asia/Shanghai 检查 GitHub `lyzbcy/nettools` 正式新版，尝试和成功日期分开保存；断网不记成功，手动检查可以重试。按数字语义版本比较，拒绝降级和默认预览版。

平台/架构匹配固定资源名；原始下载包必须验证 SHA-256。用户点击才下载并更新，显示进度和失败回退。校验失败不得执行。设置、日志和公司配置不放在被替换目录内。

交接使用每次独立暂存目录、256 位随机 token 和 ready/commit/abort。准备与助手都复核原始包；暂存应用以每个文件的 SHA-256、大小、目录和链接清单核验。ZIP 拒绝路径越界、大小写冲突、特殊文件、加密、多卷与 ZIP64；默认最多 20,000 项、单文件 512 MiB、解压总量 2 GiB、原始包 1 GiB。Mac 框架的相对符号链接只能留在完整外层 `.app` 内；AppleDouble 元数据验 CRC 后忽略，最终应用仍需通过深度签名验证。Windows 不创建链接，核对 PE x64 与应用包版本。

Mac 助手为独立 JXA/Foundation 进程；路径从私有 JSON 读取，系统命令使用固定程序和参数数组。Windows 使用非 detached 的短 PowerShell 引导器，`Start-Process` 创建独立助手，UTF-8 BOM 脚本与结构化 JSON 分离；两级都固定 Windows PowerShell 模块搜索路径，SHA 使用 .NET，避免继承 PowerShell 7 环境的模块故障。

助手确认就绪后才提交并退出旧客户端，最多等待旧进程 30 秒。同目录保留旧版备份，原子移动新版后正常可见启动，传递原数据目录和本次确认文件。新版主进程完成初始化且窗口真实可见后写确认；离线本身不会阻止确认。90 秒内没有正确 PID、token、版本与路径确认即恢复旧版，并重新打开。成功确认后的备份清理失败只保留备份并记录警告，不撤销已经成功运行的新版。

Windows 安装版只复制当前产品精确 `DisplayName` 和 `InstallLocation` 登记指向的原卸载器，保留安装位置、其他登记字段和既有快捷方式；确认启动后更新 `DisplayVersion`。便携版没有登记时不创建登记。真实安装版升级和卸载仍需单独验收。

## 主进程接口

- `prepareUpdate(record, {signal, appPath, dataDir})`：返回 `{ready:true, token, payloadFile, attempt, version, appPath, dataDir, file}`，不替换应用。
- `handoffUpdate(ready, {oldPid, signal})`：等待真实 token 就绪确认并提交，返回后主进程停止守护、退出；同一尝试只允许一次交接。
- `abortUpdate(ready)`：撤销尚未完成的尝试，写本次 token 的 abort 标记。
- `confirmUpdateStartup({version, appPath, dataDir, argv, visible:true})`：在初始化成功、窗口 `isVisible()` 后调用；识别 `--nettools-update-confirm=<file>`。两端助手同时传 `--nettools-data=<原 dataDir>`。
- `readUpdateStartupResult({version, appPath, dataDir, argv})`：识别回滚重开时的 `--nettools-update-result=<file>`，返回经身份验证的失败信息，供主窗口展示重试/发布页回退。

确认函数不替代窗口验收，调用方必须传实际窗口状态，不能固定写 `true`。

## 当前证据

`test/update-install.test.cjs` 覆盖原始哈希、危险路径/链接、CRC、数量/大小限制、版本与架构、取消、独立 token、重复交接、Windows 引导器与 BOM，以及实际隔离 Mac 助手的成功替换、取消和无确认回滚。Mac 测试使用临时签名 Objective-C 应用与模拟启动 ACK；它证明实际助手和文件事务，不证明正式 Electron 窗口真正可见。测试收集并清理全部 fixture 进程。

未替换用户已安装的应用、未提权、未重启电脑、未发布。Windows worker 的实际执行、NSIS 升级后卸载、正式 Mac/Windows 客户端窗口与数据保留，由平台安装验收提供后续证据。

旧 4.x 用户应先手动安装一次新版本；旧固化更新器不保证安全迁移。未有真实平台升级证据前，不把逻辑或模拟测试写作已完成。
