# 规范与交付验收矩阵

现状：网络工具5.0.0已正式发行；软件中心三平台客户端已正式公开核验，两个原介绍页已同网址更新并完成公网全文核验及立即私有备份。规范基底：/Users/zeen/Documents/共享/tools/软件开发。负责人：捞鱼工作室。更新时间：2026-10-14。

以下矩阵与完成审计是5.0.0及中心 Mac 0.9.3 / Windows 0.8.7 的历史交付事实。冻结5.0.1保持不变；5.0.2候选生产源 `fd8a9a701b73b40ce25ba2e88890b7e667cbb0cf` 已通过三平台CI [38515392531](https://github.com/lyzbcy/nettools/actions/runs/38515392531)（Mac arm64、Mac x64、Windows x64）；尚未公开发行或同步软件中心及两个原介绍页。首次下载系统安全提示和真实用户授权同意/取消仍未验收。不沿用历史完成结论。单公共HTTPS探测点为当前产品边界，本次不扩展。

源码测试、隔离夹具、真实系统动作、安装版桌面及公开字节分别记录，不能互相替代。

5.0.2反馈源码候选：真实主进程/IPC、OperationLog、HTTP正文编码和真实Electron DOM/preload隔离回归验证预览快照、失效与单次发送；使用内存凭据/传输，未发送真实反馈。历史5.0.0及冻结5.0.1包不能作为5.0.2正式包的验收证据。本次候选CI已通过三平台新包、原生检查、安装版及实际夹具更新/回滚；首次使用、公开下载和中心链路仍待复验。

| 规范 | 实现与证据 | 剩余项或边界 |
| --- | --- | --- |
| 软件架构/ios与win兼容架构.md | 同一Electron界面，Swift / PowerShell执行层；三平台最终CI安装、可见窗口、更新和回滚通过 | arm64 / x64 Mac及Windows x64 |
| 软件组件/软件对应开发 skill.md | 根SKILL.md、docs/agent.md及模块文档，版本5.0.0，公开源码及正式包 | 中心公开回执已核验，两份原网页公开全文及私有发布回执已核验 |
| 软件组件/日志系统.md | 有界脱敏轮转、复制/清空、进度及失败说明；核心与桌面验收 | 用户主动输入仍需预览 |
| 软件组件/用户提意见&反馈.md | 一级入口、分类备注，默认附加脱敏日志可预览取消；三正式包通道与私有构建配置一致 | 未发送真实验收消息，用户提交才发送 |
| 软件组件/自适应更新检测.md | 上海每日尝试/成功分离、数字版本、正式版/平台白名单、SHA/size、重试取消；真实旧UI→校验→助手交接→可见新版，故障回滚及恢复说明通过 | 合成4.99.0和故障5.0.1为私有夹具；历史4.x需手动迁移 |
| 推广&美化/润物细无声.md | 原创飞天图标及星星布丁提示图；安装版/网页截图 | 中心页桌面/390小屏、正式下载数据和WS线上版本请求均已复验；图片延迟加载与既有作者浮层的观察边界保留 |
| 推广&美化/个人推广页.MD | 内置作者页、原头像、主页、三二维码、Star及反馈 | 原介绍页已同URL发布，公网全文SHA与已确认最终源一致 |
| 推广&美化/美化设计.md | 主题标题栏及控件、Windows主题向导、自选目录、非系统盘建议及可选快捷方式，实际安装器通过 | 系统安全提示如实保留 |
| 推广&美化/图标logo.md | 原创飞天来源和SHA登记，共享logo登记，正式包PE/ICNS核验 | Mac0.9.3 / Windows0.8.7已正式公开原字节核验 |
| 推广&美化/不打扰用户的求好评.md | 至少3使用日且5次成功人工操作才邀请，关闭15天内不打扰 | 可控时钟验证，不自动Star或评价 |
| 测试/网页回归测试.md | Kimi操作者及独立观察Agent，真实前端与最终页报告 | F06历史工具阻塞保留，F09已独立验证真实导航后的guard持久与无重复刷新；本机原生授权对话框未验收 |
| 启动器适配/接入指南.md及适配规范 | nettools稳定ID、LaoyuNetTools.exe / com.laoyu.nettools、真实图标及三ZIP元数据；Windows严格exit0 | 三平台中心真实四阶段通过并正式发布；描述与实际白名单分别验证 |
| skill 组件/skill 静默更新.md | 项目开发入口随源码维护，未另发可安装Skill包 | 若独立发布需每日静默查新、失败继续旧版，不覆盖开发仓库 |
| 自用静态网页组件/强制刷新组件.md | 网络工具页1.0.0、公开version.json、一级刷新、sessionStorage目标防循环及网络/存储失败兜底 | 中心页源码、真实浏览器回归及公开entry-version.json原字节已核验；两个原URL均已确认覆盖并匿名全文SHA匹配 |

## 本次5.0.2候选证据

5.0.2候选生产源 `fd8a9a701b73b40ce25ba2e88890b7e667cbb0cf` 已通过三平台CI [38515392531](https://github.com/lyzbcy/nettools/actions/runs/38515392531)（Mac arm64、Mac x64、Windows x64）；尚未公开发行或同步软件中心及两个原介绍页。首次下载系统安全提示和真实用户授权同意/取消仍未验收。

真实旧版用户应先退出旧程序及旧守护，手动安装5.0.2一次，再在新版点击“安装网络授权”并完成系统授权。原生授权绑定版本和二进制哈希，不宣称旧 helper/grant 自动迁移；不会自动提权。当前更新回归使用候选原生版本的私有4.99.0夹具，经 fixture.local 传输，不是真实已发行5.0.0→5.0.2自动升级或旧授权迁移验收。

三个平台的原生与更新报告保存在工作区 `.delivery-runtime-20261014/nettools-artifact-38515392531-*`。更新报告均明确 `fixture:true`、`published:false`、`historicalPublishedVersion:false`；成功更新 confirmed，故障回滚 rolledBack，设置、公司配置及哨兵字节保留。原包封存目录 `release/final-fd8a9a7/` 与Windows适配描述不构成公网发布或中心验收证明。

## 历史5.0.0实际证据

- 生产提交413a5f3d5c78adf10154907487a025ac858eba8b；核心180/180与独立需求/质量审查通过。
- 最终CI [38085097075](https://github.com/lyzbcy/nettools/actions/runs/38085097075)的三个作业通过，报告在verification/ci-38085097075/：固定授权助手安装/撤销与DNS缓存刷新、可见安装版、设置17分钟、更新及回滚、Windows安装/卸载。ZIP与未打包目录前后指纹相同。
- verification/release/frozen-5.0.0.json、published-api-5.0.0.json和public-receipt-5.0.0.json记录六个资产、latest、匿名原字节SHA/size。DMG完整性与.app严格深层ad-hoc签名验证通过。
- verification/launcher-adapter-report.json为Windows共享严格检查；reference/launcher/单独记录Mac架构，没有在Mac上假称Windows已安装识别。
- verification/intro-final/report.md记录浏览器观察范围；本地mock不是新的公开版本。
- Mac软件中心CI38114074313双架构四阶段通过，0.9.3四原包及校验文件已公开匿名回读，见verification/release/center-mac-public-receipt-0.9.3.json。Windows38114072703构建后无报告、38115540621测试worker0xC0000409均保留；38118247724原生四例定位Node22.23.3中文目录fs.cpSync崩溃，38119064373同机官方Node24.21.0相同四例全通过。后两次均未进入产品构建/运行；随后工具链纠正ccfec6ac在真实Windows CI38119522879完整四阶段通过，原EXE/ZIP/校验文件以0.8.7正式公开并匿名原字节回读。Windows原生HWND截图、版本/身份、正常关闭及70个包内源文件原字节均独立核验，证据verification/center-ci-38119522879/及verification/release/center-win-public-receipt-0.8.7.json。

## 保活与安全边界

默认保活、开机运行、超时重启均关闭。开启后默认30分钟、范围1–1440分钟；五分钟仍修复失败默认无动作，单独允许重启才复查并进入60秒可取消倒计时。取消、迟到结果、防循环用虚拟时钟测试，未实际重启电脑。

CI真实系统写动作仅固定授权助手安装/撤销与DNS缓存刷新；异常网络变更在隔离环境验证。未重配用户网卡或发送真实反馈。本机Mac授权对话框未验收，CI sudo不替代该界面。Mac无Developer ID/Apple公证，Windows无代码签名证书。

## 原网址发布与备份闭环

用户明确回复“确认确认”后，只上传两份已审查HTML，没有上传目录、源码或缓存文件。网络工具原网址和软件中心原网址均保持不变，公网全文分别与最终源逐字节一致。

- 网络工具页1.0.0：1414572字节，SHA-256 `ce9970cb265f1b28b6856d57ced3e466ad91f5826a8a2345ebff52550c661ab5`，回执verification/release/ws-nettools-public-receipt.json。
- 软件中心页1.21.0：852602字节，SHA-256 `1562f8f3b441033ae9f8035efa84d02c9ffecc04afbae9a59812af9e250e21e3`，回执verification/release/ws-center-public-receipt.json。原20项目/36历史记录保留，新增后21/37。
- 中心页面更新后立即私有备份维护源、生成文件、线上基底、说明和发布回执：提交`7190fb5918e55be9603b5bb8aa2f7f3671d79ad6`，9个文件远端原字节逐项核验，原远端tree、dirty本地目录和索引保留。
- 两原WS网址上线后真实浏览器检查通过，版本JSON请求200；桌面和390页头绘制正常。边界见verification/online-final/：没有点击真实下载，屏下lazy图片不冒充全部已加载，既有作者浮层的小屏部分覆盖按截图如实记录。

公开同版包保持不可变；软件安装版、更新/回滚、中心链路、原网址发布和源码备份的证据分别保存，不互相替代。历史5.0.0最终逐项审计COMPLETION_AUDIT_PASS，历史三项用户要求、共享规范及发布备份已闭环；审计见verification/completion-audit.json。
