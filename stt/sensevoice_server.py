#!/usr/bin/env python3
"""大肥鱼 · 独立识别引擎(SenseVoice + Silero VAD,sherpa-onnx)

协议与 dsh 的 worker 兼容:loopback HTTP POST /transcribe?language=zh,
Authorization: Bearer <token>,body 为 16k/mono/PCM16 规范 WAV,
返回 {"text": "...", "audioSeconds": n}。
启动后把 {"port", "token", "backend"} 写到 $XDG_RUNTIME_DIR/dafeiyu/port.json。
"""
from __future__ import annotations

import glob
import json
import os
import secrets
import signal
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

HOME = os.path.expanduser('~')
RT = os.path.join(os.environ.get('XDG_RUNTIME_DIR', '/tmp'), 'dafeiyu')
PORT_FILE = os.path.join(RT, 'port.json')
LOCK = threading.Lock()

LANGS = {'auto', 'zh', 'en', 'yue', 'ja', 'ko'}


def log(*a):
    print('[dafeiyu-stt]', *a, file=sys.stderr, flush=True)


def find_model_dir():
    candidates = [
        os.environ.get('DAFEIYU_MODEL_DIR'),
        os.path.join(HOME, '.local/share/dafeiyu/models/sensevoice'),
        os.path.join(HOME, '.dsh/speech-to-text/sensevoice/models'),
    ]
    for d in candidates:
        if d and os.path.isdir(d):
            return d
    raise SystemExit('找不到模型目录,请运行 install.sh 下载,或设置 DAFEIYU_MODEL_DIR')


def locate(model_dir):
    models = glob.glob(os.path.join(model_dir, '**', 'model.int8.onnx'), recursive=True) \
        or glob.glob(os.path.join(model_dir, '**', 'model.onnx'), recursive=True)
    if not models:
        raise SystemExit(f'{model_dir} 下没有 SenseVoice ONNX 模型')
    model = models[0]
    tokens = os.path.join(os.path.dirname(model), 'tokens.txt')
    if not os.path.exists(tokens):
        found = glob.glob(os.path.join(model_dir, '**', 'tokens.txt'), recursive=True)
        if not found:
            raise SystemExit('找不到 tokens.txt')
        tokens = found[0]
    vads = glob.glob(os.path.join(model_dir, '**', 'silero_vad.onnx'), recursive=True)
    if not vads:
        raise SystemExit('找不到 silero_vad.onnx')
    return model, tokens, vads[0]


def validate_wav(data: bytes) -> float:
    if len(data) < 46 or data[0:4] != b'RIFF' or data[8:12] != b'WAVE' or data[12:16] != b'fmt ':
        raise ValueError('不是 WAV')
    if struct.unpack_from('<I', data, 16)[0] != 16 or struct.unpack_from('<H', data, 20)[0] != 1:
        raise ValueError('必须是 PCM')
    channels, rate = struct.unpack_from('<H', data, 22)[0], struct.unpack_from('<I', data, 24)[0]
    byte_rate, block_align, bits = struct.unpack_from('<IHH', data, 28)
    if channels != 1 or rate != 16000 or byte_rate != 32000 or block_align != 2 or bits != 16:
        raise ValueError('必须是 16kHz 单声道 PCM16')
    if data[36:40] != b'data':
        raise ValueError('data 块位置不对')
    size = struct.unpack_from('<I', data, 40)[0]
    if size != len(data) - 44 or size % 2:
        raise ValueError('data 长度不一致')
    return size / 32000


def main():
    model_dir = find_model_dir()
    model, tokens, vad_path = locate(model_dir)
    threads = int(os.environ.get('DAFEIYU_STT_THREADS', '4'))
    log('模型:', model)

    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model, tokens=tokens, num_threads=threads,
        use_itn=True, language='auto', debug=False)

    vad_conf = sherpa_onnx.VadModelConfig()
    vad_conf.silero_vad.model = vad_path
    vad_conf.silero_vad.threshold = 0.35
    vad_conf.silero_vad.min_silence_duration = 1.0
    vad_conf.silero_vad.min_speech_duration = 0.1
    vad_conf.silero_vad.max_speech_duration = 29
    vad_conf.silero_vad.window_size = 512
    vad_conf.sample_rate = 16000
    vad = sherpa_onnx.VoiceActivityDetector(vad_conf, buffer_size_in_seconds=30)

    def drain(parts):
        """把当前 VAD 段全部解码,按段收集(去掉段尾句号,后面统一拼)"""
        while not vad.empty():
            seg = vad.front
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, seg.samples)
            recognizer.decode_stream(stream)
            text = stream.result.text.strip().rstrip('。．.!！?？').strip()
            if text:
                parts.append(text)
            vad.pop()

    def transcribe(wav: bytes) -> dict:
        seconds = validate_wav(wav)
        pcm = np.frombuffer(wav[44:], dtype=np.int16).astype(np.float32) / 32768.0
        with LOCK:
            try:
                vad.reset()
            except Exception:
                pass
            parts = []
            for i in range(0, len(pcm), 512):
                vad.accept_waveform(pcm[i:i + 512])
                drain(parts)
            vad.flush()
            drain(parts)
        # 一次请求 = 一次听写;中间的停顿用逗号连接,不切成句号
        text = '，'.join(parts)
        if text and text[-1] not in '。．.!！?？':
            text += '。'
        return {'text': text, 'audioSeconds': round(seconds, 3)}

    token = os.environ.get('DAFEIYU_SPEECH_TOKEN') or secrets.token_hex(32)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'

        def log_message(self, *a):
            pass

        def reply(self, status, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            auth = self.headers.get('authorization', '')
            if not secrets.compare_digest(auth, f'Bearer {token}'):
                self.rfile.read(int(self.headers.get('content-length') or 0))
                return self.reply(401, {'error': 'Unauthorized'})
            path = self.path.split('?')[0]
            if path != '/transcribe':
                self.rfile.read(int(self.headers.get('content-length') or 0))
                return self.reply(404, {'error': 'Unknown endpoint'})
            n = int(self.headers.get('content-length') or 0)
            if n < 46 or n > 16 * 1024 * 1024:
                return self.reply(413, {'error': 'Invalid speech audio size', 'code': 'invalid-input'})
            data = self.rfile.read(n)
            try:
                self.reply(200, transcribe(data))
            except ValueError as e:
                self.reply(400, {'error': str(e), 'code': 'invalid-input'})
            except Exception as e:  # noqa: BLE001
                log('推理失败:', e)
                self.reply(500, {'error': str(e)})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    port = server.server_address[1]
    os.makedirs(RT, exist_ok=True)
    tmp = PORT_FILE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'port': port, 'token': token, 'backend': 'sensevoice', 'pid': os.getpid()}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, PORT_FILE)
    print(json.dumps({'port': port}), flush=True)
    log(f'ready on 127.0.0.1:{port}')

    def stop(*_):
        try:
            os.unlink(PORT_FILE)
        except OSError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()


if __name__ == '__main__':
    main()
