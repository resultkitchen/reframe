#!/usr/bin/env bash
# Render the Reframe launch composition to MP4 and a README-ready GIF.
# Requires: Node 22+, FFmpeg.
set -euo pipefail
cd "$(dirname "$0")"

OUT="${1:-reframe.mp4}"

echo "[reframe-video] rendering $OUT via Hyperframes..."
npx hyperframes render --output "$OUT"

echo "[reframe-video] building loopable GIF..."
ffmpeg -y -i "$OUT" -vf "fps=12,scale=1280:-1:flags=lanczos" reframe.gif

echo "[reframe-video] done:"
echo "  - $OUT"
echo "  - reframe.gif  (drop into ../README.md)"
