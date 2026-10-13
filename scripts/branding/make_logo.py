"""Pixel-art Aladine icon: a genie rising from an oil lamp, writing LaTeX.

Shapes are drawn aliased on a small grid, rim-shaded and outlined per object
(Lyrebird-icon style), then upscaled with nearest-neighbour.
"""
import sys
import numpy as np
from PIL import Image, ImageDraw

N = 110          # grid size (Lyrebird icon is ~109 px art at 4x)
SCALE = 4
OUT = sys.argv[1] if len(sys.argv) > 1 else "aladine-icon.png"

OUTLINE = (27, 42, 56)
BLUE = [(38, 62, 84), (62, 97, 125), (95, 136, 168), (143, 180, 204)]       # dark..light
ORANGE = [(122, 42, 14), (190, 74, 28), (229, 112, 54), (244, 162, 107)]
SMOKE = [(95, 136, 168), (143, 180, 204), (196, 218, 232)]
WHITE = (255, 255, 255)
CREAM = (250, 243, 230)


def blank():
    return Image.new("1", (N, N), 0)


def mask_of(img):
    return np.asarray(img.convert("L")) > 0


def shift(m, dx, dy):
    out = np.zeros_like(m)
    h, w = m.shape
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    out[yd, xd] = m[ys, xs]
    return out


def dilate(m):
    return m | shift(m, 1, 0) | shift(m, -1, 0) | shift(m, 0, 1) | shift(m, 0, -1)


canvas = np.zeros((N, N, 4), dtype=np.uint8)


def paint(m, color):
    canvas[m, :3] = color
    canvas[m, 3] = 255


def obj(m, ramp, outline=True):
    """Fill mask with a 4-step ramp lit from the top-left: shadow on the
    bottom-right rim, highlight on the top-left rim."""
    if outline:
        paint(dilate(m) & ~m, OUTLINE)
    dark, base, mid, hi = ramp
    paint(m, base)
    shadow = m & ~shift(m, -2, -2)
    paint(m & ~shift(m, 2, 2) & ~shadow, mid)
    paint(m & ~shift(m, 1, 1) & ~shadow, hi)
    paint(shadow, dark)


def ellipse(cx, cy, rx, ry):
    im = blank()
    ImageDraw.Draw(im).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=1)
    return mask_of(im)


def poly(pts):
    im = blank()
    ImageDraw.Draw(im).polygon(pts, fill=1)
    return mask_of(im)


def line(pts, width):
    im = blank()
    d = ImageDraw.Draw(im)
    d.line(pts, fill=1, width=width, joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = width / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=1)
    return mask_of(im)


def bezier(p0, p1, p2, p3, n=60):
    t = np.linspace(0, 1, n)[:, None]
    p = (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3
    return [tuple(q) for q in p]


# ---------------------------------------------------------------- smoke tail
# Rises from the spout tip and swirls up into the genie's waist.
path = bezier(np.array([12.0, 80]), np.array([2.0, 60]), np.array([40.0, 76]), np.array([54.0, 60]))
smoke = np.zeros((N, N), bool)
for i, (x, y) in enumerate(path):
    r = 1.5 + 7.5 * (i / len(path)) ** 1.3
    smoke |= ellipse(x, y, r, r * 0.9)
paint(dilate(smoke) & ~smoke, OUTLINE)
paint(smoke, SMOKE[1])
paint(smoke & ~shift(smoke, -2, -2), SMOKE[0])
paint(smoke & ~shift(smoke, 1, 1), SMOKE[2])

# ---------------------------------------------------------------- genie body
torso = ellipse(58, 52, 13, 12) | poly([(47, 54), (69, 54), (62, 64), (52, 64)])
obj(torso, BLUE)
# sash
sash = poly([(46, 55), (70, 55), (69, 58), (47, 58)]) & torso
paint(sash, ORANGE[2])
paint(sash & ~shift(sash, 0, -1), ORANGE[1])

# far arm, resting on the hip
arm_l = line([(49, 45), (44, 52), (50, 56)], 4)
obj(arm_l, BLUE)
paint(ellipse(50, 56, 2, 2), BLUE[3])

# head
SKIN = [(70, 108, 138), (122, 162, 192), (150, 187, 211), (200, 222, 236)]
neck = poly([(57, 37), (63, 37), (63, 42), (57, 42)])
obj(neck, SKIN)
head = ellipse(60, 31, 8, 8)
obj(head, SKIN)
ear = poly([(51, 30), (47, 27), (52, 34)])
obj(ear, SKIN)
# turban + jewel
turban = ellipse(60, 23, 9, 5) | ellipse(60, 20, 5, 4)
obj(turban, ORANGE)
paint(ellipse(60, 23, 1, 1), WHITE)
# topknot curl
obj(line([(60, 15), (63, 12), (66, 13)], 2), ORANGE)
# face
paint(poly([(56, 29), (57, 29), (57, 31), (56, 31)]), OUTLINE)
paint(poly([(63, 29), (64, 29), (64, 31), (63, 31)]), OUTLINE)
paint(line([(55, 27), (57, 26)], 1), OUTLINE)
paint(line([(63, 26), (65, 27)], 1), OUTLINE)
paint(line([(57, 34), (59, 35), (61, 35), (63, 34)], 1), OUTLINE)
# beard tuft
beard = poly([(57, 37), (63, 37), (60, 42)])
obj(beard, [OUTLINE, BLUE[0], BLUE[0], BLUE[1]], outline=False)

# writing arm, raised toward the formula
arm_r = line([(68, 44), (76, 38), (82, 30)], 4)
obj(arm_r, BLUE)
cuff = line([(79, 34), (81, 32)], 4)
paint(cuff, ORANGE[2])
hand = ellipse(83, 28, 3, 3)
obj(hand, BLUE)

# quill: cream feather with an orange spine and a dark nib
feather = poly([(83, 26), (89, 14), (96, 6), (100, 5), (99, 10), (93, 20), (87, 28)])
obj(feather, [(214, 196, 170), CREAM, CREAM, WHITE])
paint(line([(86, 26), (98, 7)], 1), ORANGE[0])
paint(line([(82, 30), (84, 28)], 1), OUTLINE)

# ---------------------------------------------------------------- lamp
body = ellipse(42, 92, 20, 8)
spout = poly([(26, 89), (12, 80), (8, 79), (9, 82), (22, 95)])
handle_outer = ellipse(65, 89, 7, 6)
handle = handle_outer & ~ellipse(65, 89, 4, 3) & ~ellipse(56, 89, 6, 8)
foot = poly([(33, 98), (51, 98), (54, 104), (30, 104)])
lid = ellipse(42, 84, 9, 4)
knob = ellipse(42, 79, 2, 2)
for part in (handle, spout, foot, body, lid, knob):
    obj(part, ORANGE)
# rim line between body and lid
paint(line([(34, 87), (50, 87)], 1), ORANGE[0])

# ---------------------------------------------------------------- floating LaTeX
GLYPHS = {
    "\\": ["1....", "1....", ".1...", "..1..", "...1.", "....1", "....1"],
    "S":  ["11111", "1....", ".1...", "..1..", ".1...", "1....", "11111"],   # capital sigma
    "{":  ["..11", ".1..", ".1..", "1...", ".1..", ".1..", "..11"],
    "}":  ["11..", "..1.", "..1.", "...1", "..1.", "..1.", "11.."],
    "I":  ["..11", ".1..", ".1..", ".1..", ".1..", ".1..", "11.."],          # integral
    "x":  ["....", "....", "1..1", ".11.", ".11.", "1..1", "...."],
}


def glyph(ch, x0, y0, color, px=2):
    rows = GLYPHS[ch]
    m = np.zeros((N, N), bool)
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            if v == "1":
                m[y0 + r * px: y0 + (r + 1) * px, x0 + c * px: x0 + (c + 1) * px] = True
    paint(dilate(m) & ~m, OUTLINE)
    paint(m, color)


glyph("S", 10, 12, BLUE[1])
glyph("I", 30, 4, ORANGE[1])
glyph("\\", 70, 52 - 48, BLUE[2])
glyph("{", 6, 36, ORANGE[2])
glyph("x", 16, 36, BLUE[1])
glyph("}", 27, 36, ORANGE[2])

# ink sparkle trail from nib toward the braces
for (x, y) in [(80, 20), (74, 13), (66, 8), (50, 5), (42, 9)]:
    paint(ellipse(x, y, 1, 1), ORANGE[2])

# ---------------------------------------------------------------- export
img = Image.fromarray(canvas, "RGBA")
bg = Image.new("RGBA", img.size, WHITE + (255,))
bg.alpha_composite(img)
bg.convert("RGB").resize((N * SCALE, N * SCALE), Image.NEAREST).save(OUT)
img.resize((N * SCALE, N * SCALE), Image.NEAREST).save(OUT.replace(".png", "-transparent.png"))
print("wrote", OUT)
