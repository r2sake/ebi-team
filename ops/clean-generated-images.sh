#!/usr/bin/env bash
# codex の画像生成ツール（image_gen__imagegen）が吐く ~/.codex/generated_images/ の掃除。
#
# 背景（docs/design/imagegen-role-2026-09-05.md §6.5）:
#   image_gen は生成のたび ~/.codex/generated_images/<uuid>/exec-<uuid>.png を作り、
#   セッションが終わっても残る（1 枚 ≒ 0.8〜0.9 MB）。imagegen エビ自身には掃除させない
#   （他セッションが生成中のディレクトリを消す事故を避けるため）。ここで人が回す。
#
# 使い方:
#   ops/clean-generated-images.sh            # 既定: 7 日より古いものを削除
#   ops/clean-generated-images.sh --dry-run  # 消さずに対象だけ出す
#   ops/clean-generated-images.sh --days 30
#
# 安全策: 対象は $HOME/.codex/generated_images 直下のディレクトリだけ（-mindepth/-maxdepth 1）。
# ルートが存在しなければ何もせず正常終了する。EBI_GENERATED_IMAGES_DIR で上書き可（テスト用）。

set -euo pipefail

ROOT="${EBI_GENERATED_IMAGES_DIR:-$HOME/.codex/generated_images}"
DAYS=7
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --days) DAYS="${2:?--days には日数が要ります}"; shift 2 ;;
    --days=*) DAYS="${1#--days=}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done

case "$DAYS" in
  ''|*[!0-9]*) echo "--days は 0 以上の整数にしてください: $DAYS" >&2; exit 2 ;;
esac

if [ ! -d "$ROOT" ]; then
  echo "[clean-generated-images] 対象なし（$ROOT が存在しません）"
  exit 0
fi

# macOS 同梱の bash は 3.2（mapfile 無し）。NUL 区切りの find を while で読む。
COUNT=0
LIST=""
while IFS= read -r -d '' d; do
  COUNT=$((COUNT + 1))
  LIST="$LIST$d
"
done < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$DAYS" -print0)

if [ "$COUNT" -eq 0 ]; then
  echo "[clean-generated-images] ${DAYS} 日より古いディレクトリはありません（${ROOT}）"
  exit 0
fi

echo "[clean-generated-images] ${DAYS} 日より古い $COUNT 件が対象（${ROOT}）"
printf '%s' "$LIST" | sed 's/^/  /'

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[clean-generated-images] --dry-run のため削除しません"
  exit 0
fi

find "$ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$DAYS" -print0 | xargs -0 rm -rf
echo "[clean-generated-images] $COUNT 件を削除しました"
