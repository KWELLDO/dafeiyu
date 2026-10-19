#!/usr/bin/env bash
# 大肥鱼 · 识别引擎启动器:standalone SenseVoice 或 复用 dsh 的 worker
set -euo pipefail
DIR=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
BACKEND="${DAFEIYU_STT_BACKEND:-auto}"
DSH_WORKER="${DAFEIYU_DSH_WORKER:-$HOME/project/dsh/packages/experimental/speech-to-text-sensevoice/lib/worker.js}"

if [ "$BACKEND" = auto ]; then
  if [ -x "$DIR/.venv/bin/python" ]; then
    BACKEND=sensevoice
  elif [ -f "$DSH_WORKER" ]; then
    BACKEND=dsh
  else
    BACKEND=sensevoice
  fi
fi

case "$BACKEND" in
  dsh) exec node "$DIR/stt/serve-dsh.mjs" ;;
  sensevoice)
    for py in "$DIR/.venv/bin/python" "$DIR/../.venv/bin/python"; do
      [ -x "$py" ] && exec "$py" "$DIR/stt/sensevoice_server.py"
    done
    echo "找不到 venv,请先运行 install.sh" >&2; exit 2 ;;
  *) echo "未知的 DAFEIYU_STT_BACKEND: $BACKEND" >&2; exit 2 ;;
esac
