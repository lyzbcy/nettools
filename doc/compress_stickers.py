#!/usr/bin/env python3
"""压缩 app 内表情贴图：透明 PNG → 缩放至 240x240 + 量化调色板，目标 < 80KB"""
import os, glob
from PIL import Image

STICKER_DIR = "<项目根目录>/捞鱼的网络工具.app/Contents/Resources/img/sticker"
TARGET = 240

for f in sorted(glob.glob(os.path.join(STICKER_DIR, "*.png"))):
    before = os.path.getsize(f)
    img = Image.open(f).convert("RGBA")
    w, h = img.size
    # 等比缩放至最长边=TARGET
    scale = TARGET / max(w, h)
    img = img.resize((int(w*scale), int(h*scale)), Image.LANCZOS)
    # 量化到调色板（Fast Octree，支持 RGBA 透明）
    img = img.quantize(colors=128, method=Image.FASTOCTREE).convert("RGBA")
    img.save(f, "PNG", optimize=True)
    after = os.path.getsize(f)
    print(f"  {os.path.basename(f):16s} {before:>8d} → {after:>8d} B  ({int((1-after/before)*100)}%↓)")
