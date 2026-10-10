from pathlib import Path
from PIL import Image,ImageDraw
root=Path(__file__).resolve().parent.parent
out=root/'build/assets';out.mkdir(parents=True,exist_ok=True)
image=Image.open(root/'ui/assets/icon.png').convert('RGBA')
image.save(out/'icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
for name,size,mark in [('installer-header.bmp',(150,57),42),('installer-sidebar.bmp',(164,314),140)]:
    canvas=Image.new('RGB',size,'#f8f5ec');draw=ImageDraw.Draw(canvas)
    draw.rectangle((0,0,size[0],8),fill='#365746')
    sticker=image.copy();sticker.thumbnail((mark,mark));canvas.paste(sticker,((size[0]-sticker.width)//2,(size[1]-sticker.height)//2),sticker)
    canvas.save(out/name)
