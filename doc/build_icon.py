#!/usr/bin/env python3
"""
为「捞鱼的网络工具」生成 macOS 标准 icon.icns：
- 源图：第7弹-飞天.png（240x240 透明 PNG）
- 合成：圆角米色底 + forest 绿描边 + 飞天前景
- 输出：标准 iconset（10 张）→ iconutil 封装为 icon.icns
"""
import os, subprocess, tempfile, shutil
from PIL import Image, ImageDraw

SRC = "<你的星星布丁素材目录>"
OUT_ICNS = "<项目根目录>/捞鱼的网络工具.app/Contents/Resources/icon.icns"

# lyzbcy 视觉系统配色
CREAM = (250, 246, 235, 255)    # #FAF6EB 米色底
FOREST = (30, 58, 36, 255)      # #1E3A24 深绿描边

# macOS iconset 标准尺寸（含 @2x）
SIZES = [
    (16,  "icon_16x16.png"),
    (32,  "icon_16x16@2x.png"),
    (32,  "icon_32x32.png"),
    (64,  "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024,"icon_512x512@2x.png"),
]

def make_icon(size):
    """生成指定尺寸的图标：圆角米色底 + 绿描边 + 飞天前景居中。"""
    # 高分辨率画布（4x 超采样抗锯齿）
    SS = 4
    W = size * SS
    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # 圆角矩形底（macOS Continuous 经验值：约 22.5% 圆角率）
    radius = int(W * 0.2237)
    # 描边（外层 forest 绿）
    stroke_w = max(2, int(W * 0.012))
    draw.rounded_rectangle(
        [stroke_w//2, stroke_w//2, W - stroke_w//2, W - stroke_w//2],
        radius=radius, fill=CREAM, outline=FOREST, width=stroke_w
    )

    # 飞天前景：等比缩放至画布 ~78%，居中
    mascot = Image.open(SRC).convert("RGBA")
    target = int(W * 0.78)
    m_w, m_h = mascot.size
    scale = target / max(m_w, m_h)
    new_w, new_h = int(m_w * scale), int(m_h * scale)
    mascot = mascot.resize((new_w, new_h), Image.LANCZOS)
    offset = ((W - new_w)//2, int((W - new_h)//2) - int(W*0.02))  # 略微上移
    canvas.alpha_composite(mascot, offset)

    # 降采样到目标尺寸
    return canvas.resize((size, size), Image.LANCZOS)


def main():
    iconset_dir = tempfile.mkdtemp(prefix="iconset_")
    print(f"[icon] 工作目录: {iconset_dir}")

    for px, fname in SIZES:
        img = make_icon(px)
        out = os.path.join(iconset_dir, fname)
        img.save(out, "PNG")
        print(f"  ✓ {fname} ({px}x{px})")

    # 备份原 icns
    if os.path.exists(OUT_ICNS):
        bak = OUT_ICNS + ".v4.0.bak"
        if not os.path.exists(bak):
            shutil.copy2(OUT_ICNS, bak)
            print(f"[icon] 已备份原 icns → {bak}")

    # iconutil 封装
    iconset_path = iconset_dir.rstrip("/") + ".iconset"
    shutil.move(iconset_dir, iconset_path)
    r = subprocess.run(
        ["iconutil", "-c", "icns", iconset_path, "-o", OUT_ICNS],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        print("[icon] iconutil 失败:", r.stderr)
        return 1
    print(f"[icon] ✓ 已生成 {OUT_ICNS}")
    print(f"[icon] 体积: {os.path.getsize(OUT_ICNS)} 字节")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
