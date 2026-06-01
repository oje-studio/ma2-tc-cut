#!/usr/bin/env python3
"""
App icon generator for MA2 Timecode Cut — same look as ØJE CUE MONITOR
(dark rounded square + the studio Ø mark) with "MA2" under the mark.

    python3 assets/build_icon.py
Produces assets/icon_1024.png, assets/icon.icns, assets/icon.ico
"""
import os
import struct
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = 1024
BG_COLOR = (28, 28, 28, 255)            # matches CUE MONITOR's icon background
TEXT_COLOR = (240, 240, 240, 255)
CORNER_RADIUS_RATIO = 0.22              # macOS squircle-ish
ICNS_ENTRIES = [("ic04", 16), ("ic05", 32), ("ic07", 128), ("ic13", 256), ("ic09", 512), ("ic10", 1024)]


def load_font(px):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/Library/Fonts/Arial Bold.ttf",
              "/System/Library/Fonts/HelveticaNeue.ttc",
              "/System/Library/Fonts/Helvetica.ttc"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, px)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_master(size=BASE):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * CORNER_RADIUS_RATIO), fill=BG_COLOR)

    # studio Ø mark, scaled smaller and lifted to leave room for the label
    logo = Image.open(os.path.join(HERE, "logo_src.png")).convert("RGBA")
    bbox = logo.getbbox()
    if bbox:
        logo = logo.crop(bbox)
    target = int(size * 0.46)
    scale = target / max(logo.size)
    logo = logo.resize((int(logo.size[0] * scale), int(logo.size[1] * scale)), Image.LANCZOS)
    img.alpha_composite(logo, dest=((size - logo.size[0]) // 2, int(size * 0.13)))

    # "MA2" label, bold, tracked
    text = "MA2"
    font = load_font(int(size * 0.20))
    d2 = ImageDraw.Draw(img)
    spacing = int(size * 0.02)
    widths = [d2.textbbox((0, 0), ch, font=font)[2] for ch in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x = (size - total) / 2
    y = int(size * 0.74)
    for ch, w in zip(text, widths):
        d2.text((x, y), ch, font=font, fill=TEXT_COLOR, anchor="lm",
                stroke_width=int(size * 0.006), stroke_fill=TEXT_COLOR)
        x += w + spacing
    return img


def save_ico(master, path):
    master.resize((256, 256), Image.LANCZOS).save(
        path, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])


def save_icns(master, path):
    body = b""
    for code, px in ICNS_ENTRIES:
        buf = BytesIO()
        master.resize((px, px), Image.LANCZOS).save(buf, format="PNG")
        data = buf.getvalue()
        body += code.encode("ascii") + struct.pack(">I", 8 + len(data)) + data
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", 8 + len(body)) + body)


def main():
    master = draw_master(BASE)
    master.save(os.path.join(HERE, "icon_1024.png"))
    save_ico(master, os.path.join(HERE, "icon.ico"))
    save_icns(master, os.path.join(HERE, "icon.icns"))
    print("wrote icon_1024.png, icon.ico, icon.icns")


if __name__ == "__main__":
    main()
