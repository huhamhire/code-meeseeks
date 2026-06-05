#!/usr/bin/env python3
# 生成 macOS 专用 app 图标：深色圆角底板(squircle) + 居中留边的青色 glyph。
#
# 为什么单独给 mac 出一张：Windows/Linux 用满铺透明异形图标没问题，但 macOS 的图标
# 约定是「不透明圆角矩形底板 + logo 留边」。直接喂透明异形 glyph，macOS（尤其 26 Tahoe）
# 会把它套进圆角并垫一块默认白底 → 很丑。这里把品牌 glyph 合到深色 squircle 上规避。
#
# 依赖 Pillow（非构建期依赖，仅改图标时手动跑）：
#   python3 -m venv /tmp/iconvenv && /tmp/iconvenv/bin/pip install Pillow
#   /tmp/iconvenv/bin/python tools/icons/gen-mac-icon.py \
#       assets/icons/icon.png assets/icons/icon-mac.png
#
# 产物 icon-mac.png 由 electron-builder.yml 的 mac.icon 引用（win/linux 仍用 icon.png）。
import sys
from PIL import Image, ImageDraw

SRC = sys.argv[1]
OUT = sys.argv[2]

S = 1024          # 画布
SS = 4            # 超采样倍数（圆角抗锯齿）
MARGIN = 100      # 底板四周留白（Apple 网格：body 824 居中）
RADIUS = 186      # 圆角半径（≈0.225*body）
GLYPH_MAX = 560   # glyph 最大边目标尺寸（body 内再留边）

# 深色底，自上而下的细微渐变（避免死板纯色）
TOP = (42, 47, 57)     # #2A2F39
BOT = (22, 26, 33)     # #161A21

big = S * SS

# 1) 竖向渐变底
grad = Image.new("RGB", (1, big))
for y in range(big):
    t = y / (big - 1)
    grad.putpixel((0, y), tuple(round(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)))
grad = grad.resize((big, big))

# 2) squircle 蒙版（超采样圆角矩形）
mask = Image.new("L", (big, big), 0)
d = ImageDraw.Draw(mask)
d.rounded_rectangle(
    [MARGIN * SS, MARGIN * SS, (S - MARGIN) * SS, (S - MARGIN) * SS],
    radius=RADIUS * SS,
    fill=255,
)

body = Image.new("RGBA", (big, big), (0, 0, 0, 0))
body.paste(grad, (0, 0), mask)
body = body.resize((S, S), Image.LANCZOS)

# 3) glyph：裁到 alpha 包围盒 → 等比缩放到 GLYPH_MAX → 居中
glyph = Image.open(SRC).convert("RGBA")
bbox = glyph.split()[3].getbbox()
glyph = glyph.crop(bbox)
gw, gh = glyph.size
scale = GLYPH_MAX / max(gw, gh)
glyph = glyph.resize((round(gw * scale), round(gh * scale)), Image.LANCZOS)
gw, gh = glyph.size
pos = ((S - gw) // 2, (S - gh) // 2)

canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
canvas.alpha_composite(body)
canvas.alpha_composite(glyph, pos)
canvas.save(OUT)
print(f"wrote {OUT}  body_margin={MARGIN} radius={RADIUS} glyph_max={GLYPH_MAX}")
