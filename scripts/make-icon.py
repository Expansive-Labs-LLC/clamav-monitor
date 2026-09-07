#!/usr/bin/env python3
"""Generate the app icon set into build/icons/ plus build/icon.png.

Drawn once at high resolution and downsampled per size: Pillow does not
antialias polygon or ellipse fills, so supersampling is the only way to get
clean curves. electron-builder picks up a directory of NxN.png files and maps
each into /usr/share/icons/hicolor/NxN/apps/.
"""
from PIL import Image, ImageDraw
import os

MASTER = 1024
F = 4                       # supersample factor for the master render
W = MASTER * F

# Sizes the freedesktop icon theme spec expects a desktop app to provide.
SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

ACCENT_TOP = (91, 140, 255)
ACCENT_BOT = (125, 91, 255)
SHIELD = (255, 255, 255)
CHECK = (91, 140, 255)


def vertical_gradient(size, top, bottom):
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = (
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
        )
    return grad.resize((size, size), Image.NEAREST)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return m


def shield_polygon(cx, cy, w, h):
    """Straight shoulders, flanks curving inward to a point at the base."""
    half = w / 2
    top = cy - h / 2
    bot = cy + h / 2
    shoulder = top + h * 0.30
    pts = [(cx - half, top), (cx + half, top)]

    steps = 60
    for i in range(steps + 1):
        t = i / steps
        pts.append((cx + half * (1 - t ** 2.2), shoulder + (bot - shoulder) * t))
    for i in range(steps, -1, -1):
        t = i / steps
        pts.append((cx - half * (1 - t ** 2.2), shoulder + (bot - shoulder) * t))
    return pts


def render_master():
    base = vertical_gradient(W, ACCENT_TOP, ACCENT_BOT).convert("RGBA")
    base.putalpha(rounded_mask(W, int(W * 0.22)))

    d = ImageDraw.Draw(base)
    cx = cy = W / 2
    d.polygon(shield_polygon(cx, cy + W * 0.01, W * 0.46, W * 0.60), fill=SHIELD)

    lw = int(W * 0.055)
    p1 = (cx - W * 0.115, cy + W * 0.005)
    p2 = (cx - W * 0.028, cy + W * 0.092)
    p3 = (cx + W * 0.130, cy - W * 0.088)
    d.line([p1, p2, p3], fill=CHECK, width=lw, joint="curve")
    for p in (p1, p3):                      # round the stroke caps
        r = lw / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=CHECK)

    return base.resize((MASTER, MASTER), Image.LANCZOS)


def main():
    master = render_master()
    build = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "build"))
    icons = os.path.join(build, "icons")
    os.makedirs(icons, exist_ok=True)

    for s in SIZES:
        img = master if s == MASTER else master.resize((s, s), Image.LANCZOS)
        img.save(os.path.join(icons, f"{s}x{s}.png"))

    master.save(os.path.join(build, "icon.png"))
    print(f"wrote {len(SIZES)} icons to {icons} and icon.png")


if __name__ == "__main__":
    main()
