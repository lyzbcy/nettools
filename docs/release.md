# 打包与软件中心交付

现状：正式 5.0.0 六包与冻结5.0.1包均保持不可变；软件中心 Mac 0.9.3 / Windows 0.8.7 及两个原网址已完成旧版本同步。5.0.2候选生产源 `fd8a9a701b73b40ce25ba2e88890b7e667cbb0cf` 已通过三平台CI [38515392531](https://github.com/lyzbcy/nettools/actions/runs/38515392531)（Mac arm64、Mac x64、Windows x64）；尚未公开发行或同步软件中心及两个原介绍页。首次下载系统安全提示和真实用户授权同意/取消仍未验收。负责人：捞鱼工作室。更新时间：2026-10-14。

后续本机真实迁移发现旧助手完整权限判定缺陷：当前修复待独立复审与新三平台CI，不能用此前 `fd8a9a7` 六包作为修复后发行包；`release/final-fd8a9a7/` 保持不可变，仍未公开。

Mac 输出 arm64 / x64 独立 ZIP、DMG；ZIP 包含完整 .app。Windows 输出 x64 ZIP 与安装器，ZIP 根目录固定 LaoyuNetTools.exe，依赖与许可证完整。安装器以主题一致的图形界面选择位置，优先非系统盘，可自定义，快捷方式由用户决定。

真实旧版用户应先退出旧程序及旧守护，手动安装5.0.2一次，再在新版点击“安装网络授权”并完成系统授权。原生授权绑定版本和二进制哈希，不宣称旧 helper/grant 自动迁移；不会自动提权。当前更新回归使用候选原生版本的私有4.99.0夹具，经 fixture.local 传输，不是真实已发行5.0.0→5.0.2自动升级或旧授权迁移验收。

稳定产品 ID nettools，发布仓库 lyzbcy/nettools。软件中心目录、图标、平台资源、安装识别及准备规则同步登记；新增识别必须随客户端发布。launcher-adapter.json 记录实际最终包 SHA，运行共享适配脚本严格自查。Mac 接入与 Windows 接入分别验收。

5.0.2三平台六资产由上述候选CI独立生成，不复用冻结5.0.1的包、哈希或manifest。原生检查、实际安装版、夹具升级/回滚与数据保留已通过；公开发行、中心及原页同步、首次使用边界仍待验收。本地已逐一核对六个原包SHA-256与大小，匹配 `release/final-fd8a9a7/source-and-assets.json` 和候选CI；封存目录同时保留 `SHA256SUMS-5.0.2.txt`。Windows ZIP为155509718字节，SHA-256为 `b7ca32d87b82bf0d8dcdf7f4bbce84860eec50647bbc68b9daf56585ed5a5a05`。

`launcher-adapter.json` 指向本次Windows ZIP；其中 `https://github.com/lyzbcy/nettools/releases/download/v5.0.2/nettools-5.0.2-win-x64.zip` 是既定仓库的拟发布稳定地址，当前尚未发布，不是可下载回执。描述文件只供开发自查，现有中心不会自动读取；中心5.0.2下载、准备、打开及重开识别仍待独立验收。

共享适配严格自查使用权威 `_skill_release_work/center-win-final`（0.8.10），结果退出码1：包哈希、ZIP布局、主程序及中心识别/便携映射通过；5项失败均为中心仍登记5.0.0的发行版本、哈希、URL、文件名和 publishedVersion，5.0.2中心接入尚未完成。报告位于工作区 `.delivery-runtime-20261014/task-evidence/nettools-launcher-adapter-5.0.2.json`；本机未执行Windows安装识别或产品启动。

沿用原创飞天图标，并在共享 logo-registry.json 登记来源和哈希。未配 Developer ID / Windows 签名时如实说明安装提示；不能靠删除所有隔离标记作为“已签名”。

发行顺序：验证最终包→上传不可变版本包→公网下载核验→更新元数据→同步原介绍页→回读全文与备份。5.0.0 已完成上述发行闭环，正式地址为 https://github.com/lyzbcy/nettools/releases/tag/v5.0.0 ，`/latest` 已核验。冻结与公开回执在 `verification/release/`。软件中心 Mac 0.9.3 / Windows 0.8.7 和两个原 WSHOTO 页已完成同步、公开核验及备份，详见 roadmap.md；原网址与其他产品保留。5.0.2 本次候选尚未公开或同步，须重新完成对应闭环。首次下载系统安全提示及真实 Mac 授权同意/取消仍待独立验收，CI sudo 不代表用户对话框通过。

## 历史5.0.0构建与验收记录

打包配置在目录包与 NSIS 两次构建前分别进行深复制，避免固定 electron-builder 对 `files` 归一化时污染下一次配置。`test/package.test.cjs` 使用生产配置和真实固定 builder 连续归一化两次，本机 4/4 通过；不下载运行时或执行打包。CI 先运行不依赖工具链的核心测试，仅在精确缺少 electron-builder 时跳过这一项，安装锁定依赖后在三个平台任务中再次执行完整包测试；已安装依赖的解析或运行错误仍然失败。正式完整构建及安装版验收已由最终 CI 38085097075 提供，不能用此纯配置测试替代。

历史 CI `38077230692` 的 WPF 安装登记缺口已修复，`customInstall` 向准确卸载键写入实际 `$INSTDIR`。后续 CI 38085097075 已验证主题安装界面、真实路径和登记、正常更新与失败回滚，以及原卸载器删除登记/快捷方式/程序并保留用户数据。

实际验收先运行安装版桌面，再走成功升级和故障回滚；Windows 最后实际调用原卸载器。CI 38085097075 三个作业均通过，两段更新保留设置、公司配置与哨兵原字节，ZIP/未打包目录前后指纹一致。合成 `4.99.0`、故障 `5.0.1` 仅在 CI 私有副本，传输标为 `fixture.local`；正式公开文件只有本次不变的 5.0.0 六资产。控制文件、助手日志和进程身份在清理前后分别保存。回滚提示经历实际缺陷与真实 Electron 回归修复，最终安装版截图证实恢复说明显示。详情见 [自身更新](updater.md)。

## 真实旧助手迁移修正（2026-10-14，待新CI）

用户完成真实系统授权后，本机已复制新版helper与grant，却因旧助手retirement返回AUTHORIZATION_FAILED。只读stat证实旧原版root/setuid助手的 `%u:%Lp` 为 `0:755`，此前与 `0:4755` 比较必然失败。改为 `%u:%Op` 精确匹配 `0:104755`，同时保留Swift lstat的root、regular、4755与固定SHA，以及授权脚本的非链接、完整mode和原字节SHA再次检查；未知旧助手仍拒绝。

安装先完成新版stage准备，再把已核验旧助手暂存于本轮root私有stage，随后提交新grant/helper。命令失败时尝试恢复旧助手，不覆盖同时出现的新对象；恢复失败保留stage并返回LEGACY_RECOVERY_REQUIRED，不能显示授权已完成。这只保护旧助手retirement，不宣称两次新版mv组成完整事务，也不把已有部分安装当作成功；最终仍须helperStatus验证。

本地仅用自有惰性数据进行实际stat、生产函数编译和shell回归：非SUID/错误mode/目录/链接拒绝，成功清除、后续失败恢复、恢复冲突保留、预检后内容变化拒绝。没有触碰本机旧助手、触发OS授权、改网卡或重启。CI新增 `scripts/ci-macos-legacy.cjs`，从固定公开历史提交 `413a5f3d5c78adf10154907487a025ac858eba8b` 的原文件获取164704字节、SHA `9466607886a478331cd53669c799e7e02975840acedcc388c8657e5dd84df7a1`，只在目标原本不存在的隔离runner安装自有fixture并运行生产retirement/恢复片段。旧二进制绝不执行，Intel结果也不代表该历史arm64程序可运行。新候选需独立SPEC→QUALITY及三平台新CI后另行封存；原六包不重写。
