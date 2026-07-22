# ASSETS · 图片素材清单

> **TL;DR** — 所有图片在 `.app/Contents/Resources/img/` 下。换图直接替换文件 + 重签 app。图标用 `build_icon.py` 生成 icns。表情贴图必须压到 < 80KB。

---

## 素材清单（v4.1 现状）

### `img/` 目录

| 文件 | 尺寸 | 体积 | 用途 | 来源 |
|---|---|---|---|---|
| `avatar.png` | 1000×1000 | 174KB | 作者头像（侧边栏、关于页、模态框） | 作者自拍/插画 |
| `reward-qr.jpg` | 828×1124 | 123KB | **真赞赏码**（关于页 + 模态框） | `<你的本地 weshoto-study 仓库>` |
| `sticker-qr.png` | 444×444 | 28KB | 星星布丁表情包下载二维码 | lyzbcy.github.io 线上同步 |

### `img/sticker/` 目录（v4.1 新增，星星布丁表情贴图）

| 文件 | 原始素材 | 体积（压缩后） | 用途（表情种草触点） |
|---|---|---|---|
| `mascot.png` | `第7弹-飞天.png` | 32KB | 关于页/仪表盘主形象 |
| `ok.png` | `星第3弹-好的.png` | 32KB | 诊断通过/操作成功（替代 ✓） |
| `no.png` | `第7弹-大哭.png` | 38KB | 诊断失败（替代 ✗） |
| `warn.png` | `星第3弹-哦哟.png` | 52KB | 警告提醒（替代 ⚠） |
| `final.png` | `第7弹-自信.png` | 54KB | 诊断通关条 |

### `icon.icns`

- v4.0：通用「地球+医疗十字」图标（已备份为 `icon.icns.v4.0.bak`）
- v4.1：**星星布丁飞天**（圆角米色底 + forest 绿描边 + 飞天前景），由 `build_icon.py` 生成

---

## 素材源位置（更新时用）

### 星星布丁表情包库（主源）

```
<你的星星布丁素材目录>
├── 星第1弹-*.gif/png     （第1弹，含 sparkle/sleepy 等）
├── 星第2弹-*.png         （第2弹，含 下班/学习/抱抱 等）
├── 星第3弹-*.png         （第3弹，含 好的/哦哟/哭 等）
└── 第7弹-*.png           （第7弹，含 飞天/自信/大哭/骄傲 等）
```

**选表情的语义约定**（lyzbcy-study-map skill 规范）：
- 成功/通过 → 「好的」「收到」「自信」类
- 失败/错误 → 「大哭」「呜呜」「呜哇」类
- 警告/提醒 → 「哦哟」「气鼓」「哼」类
- 通关/庆祝 → 「自信」「骄傲」「闪耀」类
- 主形象 → 「飞天」「闪耀」等动态感强的

### 赞赏码

**唯一真实源**（3 份副本，字节一致，MD5 `dce6451dac2f6d9715bd5939524984d4`）：
1. `<你的管培生学习项目>`
2. `<你的管培生学习项目>`
3. `<你的本地 weshoto-study 仓库>` ← 线上 git 仓库副本

⚠️ **不要用** `星星布丁/微信表情包/赞赏页/` 下的图——那里只有引导图/致谢图，没有纯二维码。
⚠️ **不要用** avatar.png 当赞赏码（v4.0 的错误）。

### 表情包下载二维码

来自 lyzbcy.github.io 线上，skill 规定的获取方式：
```bash
curl -s "https://lyzbcy.github.io/weshoto-study/img/sticker/sticker-qr.png" -o img/sticker-qr.png
```
当前 app 里已有（28KB），无需重新下载。

---

## 图标更新流程

### 方法：用 `build_icon.py`（Python + Pillow）

脚本逻辑：
1. 读 `第7弹-飞天.png`（240×240 透明 PNG）
2. 合成到圆角米色底（#FAF6EB）+ forest 绿描边（#1E3A24）上
3. 飞天前景等比缩放至画布 78%，居中略上移
4. 4x 超采样抗锯齿，生成 10 张标准尺寸（16~1024px 含 @2x）
5. `iconutil -c icns` 封装

**完整脚本**（v4.1 用过的，重新跑前确保 `pip install --user Pillow`）：

```python
# 见项目根的 build_icon.py（建议存进项目，别只放 /tmp）
# 关键参数：
SRC = ".../第7弹-飞天.png"
CREAM = (250, 246, 235, 255)   # 米色底
FOREST = (30, 58, 36, 255)     # 绿描边
# 尺寸列表见 SIZES
# 圆角率 0.2237，描边宽 1.2%，前景占比 78%
```

### 换其他表情当图标

改 `SRC` 路径即可。建议选**全身动态感强**的表情（飞天/闪耀/飘走），半身/特写在 16×16 会糊。

---

## 表情贴图压缩流程

星星布丁原图 1~2MB，必须压缩。用 `/tmp/compress_stickers.py`（Pillow）：

```python
from PIL import Image
img = Image.open(f).convert("RGBA")
# 缩放到 240×240 最长边
img = img.resize((int(w*scale), int(h*scale)), Image.LANCZOS)
# 量化调色板（FastOctree 支持 RGBA）
img = img.quantize(colors=128, method=Image.FASTOCTREE).convert("RGBA")
img.save(f, "PNG", optimize=True)
```

效果：2MB → 50KB（97% 压缩率），视觉无损。

---

## 替换素材后的操作

```bash
# 1. 清扩展属性
xattr -cr "捞鱼的网络工具.app"
# 2. 重签
codesign --force --deep --sign - "捞鱼的网络工具.app"
# 3. 刷图标缓存（换图标时）
sudo rm -rf /Library/Caches/com.apple.iconservices.store
killall Dock Finder
# 4. 启动验证
open "捞鱼的网络工具.app"
```

---

*新增素材时：先压缩到合理体积，更新本清单，更新 build 脚本（如有）。*
