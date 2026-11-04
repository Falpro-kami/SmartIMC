"""Generate the two local carousel illustrations (Pillow; no remote image dependency)."""
from pathlib import Path
from PIL import Image, ImageDraw

TARGET = Path(__file__).resolve().parents[1] / 'miniprogram/assets/home'
TARGET.mkdir(parents=True, exist_ok=True)
W, H = 1200, 675

def background(top, bottom):
    image = Image.new('RGB', (W, H))
    draw = ImageDraw.Draw(image)
    for y in range(H):
        ratio = y / H
        color = tuple(round(a + (b - a) * ratio) for a, b in zip(top, bottom))
        draw.line((0, y, W, y), fill=color)
    return image

weekly = background((47, 91, 167), (20, 47, 98))
d = ImageDraw.Draw(weekly)
for x in range(40, W, 60):
    for y in range(35, H, 60):
        d.ellipse((x, y, x + 2, y + 2), fill=(85, 124, 184))
d.ellipse((680, -170, 1260, 410), outline=(85, 135, 209), width=2)
d.ellipse((730, -120, 1210, 360), outline=(69, 113, 187), width=2)
d.rounded_rectangle((730, 102, 1045, 342), 22, fill=(68, 109, 179), outline=(117, 158, 220), width=2)
d.rounded_rectangle((690, 133, 1005, 373), 22, fill=(170, 197, 237))
d.rounded_rectangle((650, 165, 965, 405), 22, fill=(226, 236, 250))
d.rounded_rectangle((679, 196, 813, 212), 6, fill=(65, 107, 177))
for y, length in [(242, 241), (270, 205), (298, 226)]:
    d.rounded_rectangle((680, y, 680 + length, y + 8), 4, fill=(168, 190, 225))
d.line((690, 352, 723, 329, 756, 345, 796, 319, 840, 329, 910, 287), fill=(78, 126, 198), width=5)
weekly.save(TARGET / 'weekly-preview.png', optimize=True)

challenge = background((38, 57, 107), (23, 35, 72))
d = ImageDraw.Draw(challenge)
for x in range(0, W, 80):
    d.line((x, 0, x, H), fill=(47, 66, 116))
for y in range(0, H, 80):
    d.line((0, y, W, y), fill=(47, 66, 116))
nodes = [(650, 120), (830, 69), (1030, 150), (1082, 326), (900, 405), (708, 324)]
for i, point in enumerate(nodes):
    d.line((*point, *nodes[(i + 1) % 6]), fill=(98, 147, 212), width=2)
    d.line((*point, 866, 234), fill=(70, 110, 174), width=2)
    x, y = point
    d.ellipse((x - 7, y - 7, x + 7, y + 7), fill=(130, 185, 239))
d.polygon([(866, 112), (978, 177), (978, 296), (866, 361), (754, 296), (754, 177)], fill=(67, 103, 166), outline=(140, 186, 239), width=3)
d.rounded_rectangle((804, 192, 928, 275), 14, fill=(200, 222, 249))
d.ellipse((826, 218, 840, 232), fill=(47, 85, 150))
d.ellipse((891, 218, 905, 232), fill=(47, 85, 150))
d.line((840, 250, 892, 250), fill=(91, 134, 195), width=5)
d.line((866, 192, 866, 167), fill=(200, 222, 249), width=6)
d.ellipse((858, 156, 874, 172), fill=(168, 206, 246))
challenge.save(TARGET / 'challenge-preview.png', optimize=True)
