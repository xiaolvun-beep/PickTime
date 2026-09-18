#!/usr/bin/env python3
"""生成安卓 App 图标（自适应图标前景 + 传统 mipmap）与启动图。"""
import os
from PIL import Image, ImageDraw

SRC = "/home/ubuntu/Picktime/icons/apple-touch-icon.png"
RES = "/home/ubuntu/picktime-android/app/src/main/res"

LEGACY_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE_SIZES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
SPLASH_SIZE = 320
ADAPTIVE_SCALE = 0.68


def rounded(img: Image.Image, radius_ratio: float) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    radius = int(min(w, h) * radius_ratio)
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    src = src.resize((512, 512), Image.LANCZOS)

    for density, size in LEGACY_SIZES.items():
        out_dir = os.path.join(RES, f"mipmap-{density}")
        os.makedirs(out_dir, exist_ok=True)
        icon = src.resize((size, size), Image.LANCZOS)
        rounded_icon = rounded(icon, 0.22)
        rounded_icon.save(os.path.join(out_dir, "ic_launcher.png"))
        rounded_icon.save(os.path.join(out_dir, "ic_launcher_round.png"))

    for density, size in ADAPTIVE_SIZES.items():
        out_dir = os.path.join(RES, f"mipmap-{density}")
        os.makedirs(out_dir, exist_ok=True)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        inner = int(size * ADAPTIVE_SCALE)
        logo = src.resize((inner, inner), Image.LANCZOS)
        offset = (size - inner) // 2
        canvas.paste(logo, (offset, offset), logo)
        canvas.save(os.path.join(out_dir, "ic_launcher_foreground.png"))

    splash_dir = os.path.join(RES, "drawable-nodpi")
    os.makedirs(splash_dir, exist_ok=True)
    src.resize((SPLASH_SIZE, SPLASH_SIZE), Image.LANCZOS).save(
        os.path.join(splash_dir, "splash_logo.png"))

    print("icons generated")


if __name__ == "__main__":
    main()
