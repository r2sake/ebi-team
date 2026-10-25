#!/usr/bin/env python3
"""バッチ dir の画像を 1 枚に並べた一覧（contact.png）を作る。

  python3 scripts/imagegen-contact.py <batch dir> [--out <path>] [--cell 360]
  npm run imagegen:contact -- tmp/images/<batch>

ファイル名のラベル付き。透過の画像は市松模様の背景に置く（抜けの具合が見える）。
並びはファイル名順なので、foo_magenta.png と foo_alpha.png は隣り合う。
master は chat_image で contact.png を 1 回送れば、案を一度に比べられる。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

EXTS = {".png", ".webp", ".jpg", ".jpeg"}
FONT_CANDIDATES = [
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
]
LABEL_H = 44
GAP = 12


def load_font(size: int) -> ImageFont.ImageFont:
    for p in FONT_CANDIDATES:
        if Path(p).is_file():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default(size=size)


def checker(size: int, sq: int = 16) -> Image.Image:
    im = Image.new("RGB", (size, size), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for y in range(0, size, sq):
        for x in range(0, size, sq):
            if (x // sq + y // sq) % 2:
                d.rectangle([x, y, x + sq - 1, y + sq - 1], fill=(204, 204, 204))
    return im


def fit_label(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, width: int) -> str:
    if draw.textlength(text, font=font) <= width:
        return text
    while text and draw.textlength(text + "…", font=font) > width:
        text = text[:-1]
    return text + "…"


def main() -> int:
    ap = argparse.ArgumentParser(description="画像の一覧（contact.png）を作る")
    ap.add_argument("dir")
    ap.add_argument("--out", default=None, help="既定は <dir>/contact.png")
    ap.add_argument("--cell", type=int, default=360, help="1 マスの辺（px）")
    args = ap.parse_args()

    root = Path(args.dir).resolve()
    out = Path(args.out).resolve() if args.out else root / "contact.png"
    files = sorted(
        p for p in root.iterdir()
        if p.is_file() and p.suffix.lower() in EXTS and p.resolve() != out and not p.name.startswith("contact")
    )
    if not files:
        print(f"画像がありません: {root}", file=sys.stderr)
        return 1

    cell = args.cell
    cols = min(len(files), 4)
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new("RGB", (GAP + cols * (cell + GAP), GAP + rows * (cell + LABEL_H + GAP)), (40, 40, 44))
    draw = ImageDraw.Draw(sheet)
    font = load_font(18)
    bg = checker(cell)

    for i, p in enumerate(files):
        x = GAP + (i % cols) * (cell + GAP)
        y = GAP + (i // cols) * (cell + LABEL_H + GAP)
        try:
            im = Image.open(p)
            im.load()
        except Exception as e:  # 壊れた画像も一覧から落とさず、印を付けて並べる
            draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(90, 30, 30))
            draw.text((x + 8, y + 8), f"読めない: {e}"[:40], font=font, fill=(255, 255, 255))
        else:
            has_alpha = "A" in im.getbands() or "transparency" in im.info
            im = im.convert("RGBA")
            im.thumbnail((cell, cell), Image.LANCZOS)
            tile = bg.copy() if has_alpha else Image.new("RGB", (cell, cell), (24, 24, 28))
            tile.paste(im, ((cell - im.width) // 2, (cell - im.height) // 2), im)
            sheet.paste(tile, (x, y))
        label = f"{i + 1}. {p.name}"
        draw.text((x + 4, y + cell + 10), fit_label(draw, label, font, cell - 8), font=font, fill=(235, 235, 235))

    sheet.save(out)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
