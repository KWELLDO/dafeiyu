#!/usr/bin/env bash
# 大肥鱼 · 安装脚本(Arch / 任何带 PipeWire 的 Linux + Wayland 合成器)
#   ./install.sh              安装到 ~/.local/share/dafeiyu + ~/.local/bin/dafeiyu
#   ./install.sh --no-model   跳过模型下载(已有模型时用)
#   ./install.sh --dsh        使用 dsh 自带的识别引擎与模型(不建 venv)
set -euo pipefail

SRC=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
PREFIX=${PREFIX:-$HOME/.local/share/dafeiyu}
BIN=${BIN_DIR:-$HOME/.local/bin}
MODEL_DIR=${DAFEIYU_MODEL_DIR:-$HOME/.local/share/dafeiyu/models}
NO_MODEL=0
USE_DSH=0
for a in "$@"; do
  case $a in
    --no-model) NO_MODEL=1 ;;
    --dsh) USE_DSH=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
  esac
done

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── 依赖检查 ──
command -v node >/dev/null || die "缺 node(>=20),先装 nodejs"
command -v pw-record >/dev/null || die "缺 pw-record(PipeWire),先装 pipewire"
command -v wtype >/dev/null || warn "缺 wtype,打字上屏会失败: sudo pacman -S wtype"
command -v wl-copy >/dev/null || warn "缺 wl-clipboard,微信粘贴模式会失败: sudo pacman -S wl-clipboard"
command -v notify-send >/dev/null || warn "缺 libnotify,不会有状态提示"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "node 版本太低,需要 >=20"

# ── 复制程序 ──
info "安装到 $PREFIX"
mkdir -p "$PREFIX" "$BIN"
for d in lib stt bin contrib systemd; do
  rm -rf "$PREFIX/$d"; cp -r "$SRC/$d" "$PREFIX/$d"
done
chmod +x "$PREFIX/bin/dafeiyu" "$PREFIX/stt/serve.sh"
ln -sf "$PREFIX/bin/dafeiyu" "$BIN/dafeiyu"
case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN 不在 PATH 里,记得加进 shell 配置" ;; esac

# ── 识别引擎 ──
if [ $USE_DSH = 0 ]; then
  info "创建 Python 虚拟环境(只需一次)"
  PY=""
  for c in python3.12 python3.11 python3; do
    command -v "$c" >/dev/null || continue
    v=$("$c" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null) || continue
    case $v in 3.10|3.11|3.12|3.13) PY=$(command -v "$c"); break ;; esac
  done
  [ -n "$PY" ] || die "需要 Python 3.10~3.13(3.14 暂无 sherpa-onnx 轮子)"

  if [ ! -x "$PREFIX/.venv/bin/python" ]; then
    "$PY" -m venv "$PREFIX/.venv"
  fi
  if ! "$PREFIX/.venv/bin/python" -c 'import sherpa_onnx' 2>/dev/null; then
    info "安装 sherpa-onnx(走代理 7897 更快,失败会自动直连重试)"
    "$PREFIX/.venv/bin/pip" install -q --upgrade pip >/dev/null 2>&1 || true
    "$PREFIX/.venv/bin/pip" install -q \
      ${HTTPS_PROXY:+--proxy "$HTTPS_PROXY"} numpy sherpa-onnx \
      || "$PREFIX/.venv/bin/pip" install -q --index-url https://pypi.org/simple sherpa-onnx
  fi
  "$PREFIX/.venv/bin/python" -c 'import sherpa_onnx' || die "sherpa-onnx 安装失败"
  info "sherpa-onnx $("$PREFIX/.venv/bin/python" -c 'import sherpa_onnx;print(sherpa_onnx.__version__)')"
else
  info "使用 dsh 引擎(DAFEIYU_STT_BACKEND=dsh)"
fi

# ── 模型 ──
if [ $NO_MODEL = 0 ]; then
  mkdir -p "$MODEL_DIR"
  SV="$MODEL_DIR/sensevoice/model.int8.onnx"
  VAD="$MODEL_DIR/silero_vad.onnx"
  if [ ! -f "$SV" ]; then
    info "下载 SenseVoice 模型(~230MB int8)"
    TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
    URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
    if command -v aria2c >/dev/null; then
      aria2c -q -x8 -s8 --dir="$TMP" -o model.tar.bz2 "$URL" || curl -L --fail --progress-bar -o "$TMP/model.tar.bz2" "$URL"
    else
      curl -L --fail --progress-bar -o "$TMP/model.tar.bz2" "$URL"
    fi
    tar -xjf "$TMP/model.tar.bz2" -C "$TMP"
    mkdir -p "$MODEL_DIR/sensevoice"
    mv "$TMP"/sherpa-onnx-sense-voice-*/* "$MODEL_DIR/sensevoice/"
    [ -f "$SV" ] || die "解包后没找到 model.int8.onnx"
  else
    info "SenseVoice 模型已存在,跳过"
  fi
  if [ ! -f "$VAD" ]; then
    info "下载 Silero VAD"
    curl -L --fail --progress-bar -o "$VAD" \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
  fi
  info "模型目录: $MODEL_DIR"
fi

# ── systemd 用户单元 ──
UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
mkdir -p "$UNIT"
sed "s#%h/.local/share/dafeiyu#$PREFIX#" "$SRC/systemd/dafeiyu-stt.service" > "$UNIT/dafeiyu-stt.service"
cp "$SRC/systemd/dafeiyu-ydotoold.service" "$UNIT/dafeiyu-ydotoold.service" 2>/dev/null || true
systemctl --user daemon-reload

# 配置样例
CONF=${XDG_CONFIG_HOME:-$HOME/.config}/dafeiyu/config
if [ ! -f "$CONF" ]; then
  mkdir -p "$(dirname "$CONF")"
  cp "$SRC/config.example" "$CONF"
  info "写入默认配置 $CONF"
fi

cat <<EOF

✅ 装好了。

  dafeiyu            切换手动听写(Alt+V)
  dafeiyu --wake     切换唤醒听写(说「我跟你说」)
  dafeiyu --cmd      切换语音命令(说「大肥鱼」)
  dafeiyu --status   看守护状态

下一步:
  1) 把 contrib/niri.kdl 里的键位粘进 ~/.config/niri/config.kdl,跑 niri validate
  2) 试一句: dafeiyu --exec "切到第二个桌面" --dry      (只解析不执行)
  3) 真跑一次: dafeiyu,对着麦克风说句话

配置: $CONF
日志: ${XDG_RUNTIME_DIR:-/tmp}/dafeiyu/daemon.log
EOF
