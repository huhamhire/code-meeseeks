#!/usr/bin/env python3
# Generate the macOS-specific app icon: dark rounded plate (squircle) + centered, inset cyan glyph.
#
# Why produce a separate one for mac: Windows/Linux are fine with a full-bleed transparent
# free-form icon, but the macOS icon convention is "opaque rounded-rectangle plate + inset logo".
# Feeding a transparent free-form glyph directly, macOS (especially 26 Tahoe) wraps it into rounded
# corners and pads a default white background → ugly. Here the brand glyph is composited onto a dark squircle to avoid that.
#
# Depends on Pillow (not a build-time dependency, run manually only when changing the icon):
#   python3 -m venv /tmp/iconvenv && /tmp/iconvenv/bin/pip install Pillow
#   /tmp/iconvenv/bin/python tools/icons/gen-mac-icon.py \
#       assets/icons/icon.png assets/icons/icon-mac.png
#
# The output icon-mac.png is referenced by mac.icon in electron-builder.yml (win/linux still use icon.png).
import sys
from PIL import Image, ImageDraw

SRC = sys.argv[1]
OUT = sys.argv[2]

S = 1024          # canvas
SS = 4            # supersampling factor (rounded-corner anti-aliasing)
MARGIN = 100      # plate padding on all sides (Apple grid: body 824 centered)
RADIUS = 186      # corner radius (≈0.225*body)
GLYPH_MAX = 560   # glyph max-edge target size (further inset within the body)

# Dark base, subtle top-to-bottom gradient (avoids a flat solid color)
TOP = (42, 47, 57)     # #2A2F39
BOT = (22, 26, 33)     # #161A21

big = S * SS

# 1) vertical gradient base
grad = Image.new("RGB", (1, big))
for y in range(big):
    t = y / (big - 1)
    grad.putpixel((0, y), tuple(round(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)))
grad = grad.resize((big, big))

# 2) squircle mask (supersampled rounded rectangle)
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

# 3) glyph: crop to alpha bounding box → scale proportionally to GLYPH_MAX → center
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
