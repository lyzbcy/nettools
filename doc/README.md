# 捞鱼的网络工具 · 文档索引

> **TL;DR** — 这是一个 macOS 网络自诊断/自修复工具。v4.2 已恢复 Swift 源码：真实系统能力在 `src/NetRepair.swift`，界面在 app 包内的 `index.html`，统一由 `build.sh` 构建签名。

---

## 这是什么

`捞鱼的网络工具.app`（v4.2）= `NetRepair`（Swift 原生执行层）+ `index.html`（UI 与前端状态机）。
Swift 负责真实诊断、修复、测速和 VPN 分流，HTML 负责交互与展示。

**使命来源**：见上级目录的 [`初心与使命.md`](../初心与使命.md)。

---

## 文档导航（按需阅读）

| 文档 | 何时读 | 内容 |
|---|---|---|
| **[AI-CONTEXT.md](AI-CONTEXT.md)** | 🤖 AI 接手时**先读这个** | 使命摘要、关键约束、改动红线、常见坑 |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | 改 UI / 加功能时 | Swift+HTML 架构、桥接协议、action、守护与 VPN 共存流程 |
| **[TECH-STACK.md](TECH-STACK.md)** | 改执行层时 | macOS 原生命令、权限、构建与测试 |
| **[ASSETS.md](ASSETS.md)** | 换图标/表情/赞赏码时 | 所有图片素材的来源、尺寸、更新方式 |
| **[CHANGELOG.md](CHANGELOG.md)** | 看版本演进时 | v3 网络急救箱 → v4.0 → v4.1 的变更历史 |

---

## 快速上手

### 修改并构建
修改 `src/NetRepair.swift` 或 `捞鱼的网络工具.app/Contents/Resources/index.html` 后：
```bash
./build.sh
```

### 加一个新的诊断项
1. 在 `src/NetRepair.swift` 的 `handle(action:args:)` 增加或复用 action
2. 在 `index.html` 调用并展示结果
3. 更新 `ARCHITECTURE.md` 后运行 `./build.sh` 与只读自检

### 换图标
见 `ASSETS.md` 的"图标更新"章节。用 `/tmp/build_icon.py`（或重新生成）。

---

## 目录结构

```
网络工具/
├── 初心与使命.md              ← 项目使命（最高优先级需求文档）
├── src/NetRepair.swift         ← ★ 原生执行层源码
├── build.sh                    ← ★ 可重复构建/签名
├── 捞鱼的网络工具.app/        ← 成品 app（v4.2）
│   └── Contents/
│       ├── Info.plist         ← 版本号、Bundle ID
│       ├── MacOS/NetRepair    ← Swift 编译的二进制壳（不可改）
│       └── Resources/
│           ├── index.html     ← ★ 唯一可编辑的"源"
│           ├── icon.icns      ← app 图标（v4.1 起为星星布丁飞天）
│           └── img/           ← 全部图片素材
│               ├── avatar.png          ← 作者头像
│               ├── reward-qr.jpg       ← 真赞赏码
│               ├── sticker-qr.png      ← 表情包下载二维码
│               └── sticker/            ← 星星布丁表情贴图
├── 捞鱼的网络工具-v4.1.1-backup.app/ ← 本轮改造前备份
├── 捞鱼的网络工具-v4.0-backup.app/   ← 历史备份
└── doc/                       ← 你在这里
```

---

*最后更新：2026-07-17 · v4.2*
