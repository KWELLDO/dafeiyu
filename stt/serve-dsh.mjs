// 大肥鱼 · 兼容后端:复用 dsh 的 speech-to-text-sensevoice worker
// 仅当本机装了 dsh 时可用;模型与 worker 都留在 dsh 目录,本项目不复制、不分发。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const HOME = process.env.HOME || ''
const DATA_ROOT = process.env.DAFEIYU_DSH_DATA || join(HOME, '.dsh/speech-to-text/sensevoice')
const WORKER = process.env.DAFEIYU_DSH_WORKER
  || join(HOME, 'project/dsh/packages/experimental/speech-to-text-sensevoice/lib/worker.js')
const RT = join(process.env.XDG_RUNTIME_DIR || '/tmp', 'dafeiyu')
const PORT_FILE = join(RT, 'port.json')
mkdirSync(RT, { recursive: true, mode: 0o700 })

if (!existsSync(WORKER)) {
  console.error(`找不到 dsh worker: ${WORKER}\n可设 DAFEIYU_DSH_WORKER 指向它,或改用 standalone 后端。`)
  process.exit(2)
}

const token = randomBytes(32).toString('hex')
const cfg = JSON.stringify({
  providerId: 'sensevoice-local',
  dataRoot: DATA_ROOT,
  precision: 'int8',
  threads: Number(process.env.DAFEIYU_STT_THREADS || 4),
  model: join(DATA_ROOT, 'models/sensevoice-onnx/model.int8.onnx'),
  tokens: join(DATA_ROOT, 'models/sensevoice-onnx/tokens.txt'),
  vad: join(DATA_ROOT, 'models/silero/silero_vad.onnx'),
  vadThreshold: 0.35,
  minSilenceSeconds: 1,
  minSpeechSeconds: 0.1,
  vadOnsetPaddingSeconds: 0.35,
  segmentSeconds: 29,
  maxAudioBytes: 16 * 1024 * 1024,
})

const child = spawn(process.execPath, [WORKER, cfg], {
  env: { ...process.env, DSH_SPEECH_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let buf = ''
child.stderr.on('data', (d) => process.stderr.write(d))
child.stdout.setEncoding('utf8')
child.stdout.on('data', (d) => {
  buf += d
  const nl = buf.indexOf('\n')
  if (nl < 0) return
  let port
  try { port = JSON.parse(buf.slice(0, nl)).port } catch { return }
  buf = ''
  const tmp = `${PORT_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify({ port, token, backend: 'dsh', pid: process.pid }), { mode: 0o600 })
  renameSync(tmp, PORT_FILE)
  console.log(`dafeiyu-stt(dsh) ready on 127.0.0.1:${port}`)
})

const shutdown = () => child.kill('SIGTERM')
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
child.on('exit', (code) => {
  try { rmSync(PORT_FILE, { force: true }) } catch {}
  process.exit(code ?? 0)
})
