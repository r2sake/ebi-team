#!/usr/bin/env python3
"""マゼンタ背景で生成した画像から、横に <名前>_alpha.png を足す（元の版は残す）。

  python3 scripts/imagegen-alpha.py <png> [<png> ...]
  npm run imagegen:alpha -- tmp/images/<batch>/*_magenta.png

抜くのは codex の imagegen スキル同梱の remove_chroma_key.py（背景色は外周から自動で取る）。
抜いたあとに機械的に確かめ、落ちた画像は _alpha を消して FAIL と書く。
1 画像 1 行の JSON を標準出力に出す: {"src", "alpha"|null, "ok", "reason"}。
FAIL の画像は「ボスに透過を依頼」（imagegen 役割の決まり・docs/ops/imagegen-role.md）。

名前: foo_magenta.png → foo_alpha.png ／ _magenta が無ければ foo.png → foo_alpha.png。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

CHROMA = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "skills/.system/imagegen/scripts/remove_chroma_key.py"
# remove_chroma_key.py の引数。soft-matte で縁をなめらかにし、despill で縁のマゼンタかぶりを落とす。
CHROMA_ARGS = [
    "--auto-key", "border", "--soft-matte",
    "--transparent-threshold", "12", "--opaque-threshold", "220",
    "--despill", "--force",
]

# 確かめの閾値（2026-10-25 の武器アイコンで実測して決めた。迷ったらボスへ回す側に倒す）
BORDER_PX = 8               # 外周この幅は、ほぼ透明であること
BORDER_OPAQUE_MAX = 0.002   # 外周で alpha>=32 の画素の割合の上限
MAGENTA_MAX = 0.003         # 見えている画素（alpha>=32）のうちマゼンタっぽい画素の割合の上限
PARTIAL_MAX = 0.25          # 見えている画素のうち半透明（32<=alpha<224）の割合の上限（グローや髪が溶けた目安）
VISIBLE_MIN = 0.01          # 見えている画素が全体のこの割合未満なら、被写体ごと抜けたとみなす
HOLE_KEY_DIST = 90          # 元画像で背景色からこれ以上離れた色なのに透けた画素＝被写体の穴の候補
HOLE_ERODE = 7              # 穴の候補を MinFilter で削る幅（輪郭の 1〜3px の混色を除くため）
HOLE_MAX = 0.002            # 削ったあとに残る穴の、見えている画素に対する割合の上限


def alpha_name(src: Path) -> Path:
    stem = src.stem
    for suffix in ("_magenta", "-magenta"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return src.with_name(f"{stem}_alpha.png")


def check(src: Path, out: Path, key: tuple[int, int, int]) -> str | None:
    """問題が無ければ None、あれば理由の短い文字列。"""
    im = Image.open(out)
    if "A" not in im.getbands():
        return "alpha なし"
    rgba = np.asarray(im.convert("RGBA"), dtype=np.int16)
    orig = np.asarray(Image.open(src).convert("RGB"), dtype=np.int16)
    r, g, b, a = (rgba[..., i] for i in range(4))
    h, w = a.shape

    visible = a >= 32
    n_visible = int(visible.sum())
    if n_visible < VISIBLE_MIN * w * h:
        return "被写体まで抜けた"

    border = np.zeros_like(visible)
    border[:BORDER_PX, :] = border[-BORDER_PX:, :] = True
    border[:, :BORDER_PX] = border[:, -BORDER_PX:] = True
    if (visible & border).sum() > BORDER_OPAQUE_MAX * border.sum():
        return f"外周に背景が残った（{(visible & border).sum() / border.sum():.1%}）"

    # 赤と青が強く、緑が明らかに弱い（#FF00FF 系とその暗い／淡いにじみ）
    magenta = visible & (r > 120) & (b > 120) & (g < 0.55 * np.minimum(r, b)) & (np.abs(r - b) < 70)
    if magenta.sum() > MAGENTA_MAX * n_visible:
        return f"マゼンタが残った（{magenta.sum() / n_visible:.1%}）"

    partial = visible & (a < 224)
    if partial.sum() > PARTIAL_MAX * n_visible:
        return f"半透明が多すぎ（{partial.sum() / n_visible:.0%}・グローや髪が溶けた疑い）"

    # 紫・ピンクなど背景色に近い色の被写体は、中まで抜けて穴があく（指輪の紫の宝石で実測）
    dist = np.abs(orig - np.array(key, dtype=np.int16)).max(axis=2)
    hole = ((a < 160) & (dist >= HOLE_KEY_DIST)).astype(np.uint8) * 255
    hole = np.asarray(Image.fromarray(hole, "L").filter(ImageFilter.MinFilter(HOLE_ERODE)))
    if (hole > 0).sum() > HOLE_MAX * n_visible:
        return f"被写体の中が透けた（{(hole > 0).sum() / n_visible:.1%}・紫やピンクの部分）"
    return None


def parse_key(stdout: str) -> tuple[int, int, int] | None:
    m = re.search(r"Key color: #([0-9a-fA-F]{6})", stdout)
    if not m:
        return None
    v = m.group(1)
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    if not CHROMA.is_file():
        print(json.dumps({"src": None, "alpha": None, "ok": False, "reason": f"TOOL_MISSING: {CHROMA}"}, ensure_ascii=False))
        return 1
    failed = 0
    for arg in argv:
        src = Path(arg).resolve()
        if src.stem.endswith("_alpha") or src.name == "contact.png":
            continue
        out = alpha_name(src)
        proc = subprocess.run(
            [sys.executable, str(CHROMA), "--input", str(src), "--out", str(out), *CHROMA_ARGS],
            capture_output=True, text=True,
        )
        key = parse_key(proc.stdout)
        if proc.returncode != 0:
            reason = "抜き処理エラー: " + (proc.stderr.strip().splitlines() or ["?"])[-1]
        elif key is None:
            reason = "背景色を読み取れない"
        else:
            reason = check(src, out, key)
        if reason is not None:
            out.unlink(missing_ok=True)
            failed += 1
        print(json.dumps({"src": str(src), "alpha": None if reason else str(out), "ok": reason is None, "reason": reason}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
