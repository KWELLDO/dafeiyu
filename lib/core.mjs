// 大肥鱼 · 公共基础设施:配置 / 音频 / 识别引擎 / 输入注入
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const HOME = process.env.HOME || ''
export const RUNTIME = join(process.env.XDG_RUNTIME_DIR || '/tmp', 'dafeiyu')
export const PORT_FILE = join(RUNTIME, 'port.json')
mkdirSync(RUNTIME, { recursive: true, mode: 0o700 })

// ── 配置:默认值 < ~/.config/dafeiyu/config < 环境变量 ──
const CONFIG_FILE = process.env.DAFEIYU_CONFIG || join(HOME, '.config/dafeiyu/config')

function readKeyValues(path) {
  const out = {}
  try {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const i = line.indexOf('=')
      if (i < 0) continue
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
    }
  } catch {}
  return out
}

const fileCfg = readKeyValues(CONFIG_FILE)

function opt(name, legacy, fallback) {
  return process.env[name] ?? process.env[legacy] ?? fileCfg[name] ?? fileCfg[legacy] ?? fallback
}
function num(name, legacy, fallback) {
  const v = Number(opt(name, legacy, fallback))
  return Number.isFinite(v) ? v : fallback
}
function list(name, legacy, fallback) {
  return String(opt(name, legacy, fallback)).split(',').map((s) => s.trim()).filter(Boolean)
}

export const cfg = {
  typeDelay: Math.max(1, num('DAFEIYU_TYPE_DELAY', 'VOICE_TYPE_DELAY', 35)),
  autoStopMs: num('DAFEIYU_AUTO_STOP_MS', 'VOICE_AUTO_STOP_MS', 3000),
  phraseMs: num('DAFEIYU_PHRASE_MS', 'VOICE_PHRASE_MS', 400),
  noSpeechMs: num('DAFEIYU_NO_SPEECH_MS', 'VOICE_NO_SPEECH_MS', 10000),
  maxMs: num('DAFEIYU_MAX_MS', 'VOICE_MAX_MS', 300000),
  vadDb: num('DAFEIYU_VAD_DB', 'VOICE_VAD_DB', -48),
  lang: opt('DAFEIYU_STT_LANG', 'VOICE_STT_LANG', 'zh'),
  wakeWords: list('DAFEIYU_WAKE_WORDS', 'VOICE_WAKE_WORDS', '我跟你说,你听我跟你说'),
  cmdWakeWords: list('DAFEIYU_CMD_WAKE_WORDS', 'VOICE_CMD_WAKE_WORDS', '大肥鱼,大飞鱼,大肥魚,大飞魚'),
  sendWords: list('DAFEIYU_SEND_WORDS', 'VOICE_SEND_WORDS', '回车,回车键,换行,发送,半送,发出去'),
  pasteApps: list('DAFEIYU_PASTE_APPS', 'VOICE_PASTE_APPS', 'wechat'),
  nlu: opt('DAFEIYU_NLU', 'VOICE_NLU', 'ollama:actbro/minicpm5-2b-jev:latest'),
  clickScale: Number(opt('DAFEIYU_CLICK_SCALE', 'VOICE_CLICK_SCALE', 2)) || 2,
}

export const log = (...a) => process.stderr.write(`[dafeiyu] ${a.join(' ')}\n`)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const notify = (msg, ms = 2000) => {
  try { spawn('notify-send', ['-a', 'dafeiyu', '-t', String(ms), msg]).unref() } catch {}
}

export function run(cmd, args, input) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('error', () => resolve(-1))
    p.on('close', (code) => resolve(code ?? -1))
    p.stdin.end(input ?? '')
  })
}

export function capture(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let s = ''
    p.stdout.on('data', (d) => { s += d })
    p.on('error', () => resolve(''))
    p.on('close', () => resolve(s))
  })
}

// ── 识别引擎(独立进程,HTTP 回环)──
export function readPort() {
  try {
    const j = JSON.parse(readFileSync(PORT_FILE, 'utf8'))
    return j.port && j.token ? j : null
  } catch { return null }
}

export async function ensureEngine() {
  let info = readPort()
  if (info) return info
  try { spawn('systemctl', ['--user', 'start', 'dafeiyu-stt.service']).unref() } catch {}
  for (let i = 0; i < 240; i++) {
    await sleep(250)
    info = readPort()
    if (info) return info
  }
  throw new Error('识别引擎没起来(看 journalctl --user -u dafeiyu-stt)')
}

export function toWav(pcm, rate = 16000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

async function transcribeOnce(pcm) {
  const engine = await ensureEngine()
  const res = await fetch(`http://127.0.0.1:${engine.port}/transcribe?language=${cfg.lang}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'audio/wav' },
    body: toWav(pcm),
    signal: AbortSignal.timeout(90000),
  })
  if (!res.ok) throw new Error(`识别失败 HTTP ${res.status}`)
  const j = await res.json()
  if (j.error) throw new Error(j.error)
  return (j.text || '').trim()
}

export async function transcribe(pcm) {
  try { return await transcribeOnce(pcm) }
  catch (e) {
    // 引擎可能按 RuntimeMaxSec 自停过,重启后再试一次
    try { spawn('systemctl', ['--user', 'restart', 'dafeiyu-stt.service']).unref() } catch {}
    await sleep(300)
    try { return await transcribeOnce(pcm) } catch { throw e }
  }
}

// ── 音频:80Hz 高通 + 20ms 帧 ──
export const FRAME_SAMPLES = 320
export const FRAME_BYTES = FRAME_SAMPLES * 2
export const FRAME_MS = 20

export function dbfs(buf) {
  let sum = 0
  const n = buf.length >> 1
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return 20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(1, n)), 1e-7))
}

export function createHighpass() {
  const A = 0.969
  let px = 0, py = 0
  return (buf) => {
    const out = Buffer.allocUnsafe(buf.length)
    for (let i = 0; i < buf.length; i += 2) {
      const x = buf.readInt16LE(i)
      const y = A * (py + x - px)
      px = x; py = y
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y))), i)
    }
    return out
  }
}

// ── 文本工具 ──
const TAIL_NOISE = '[\\s，。,.!！?？、；;：:…~～嗯啊吧了呢呀哦]*$'

export function stripPunct(s) {
  return String(s || '').replace(/[\s，。,.!！?？、；;：:…~～]/g, '')
}

export function lev(a, b) {
  const m = a.length, n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[m][n]
}

/** 末尾说「回车/发送」(容忍一字误差)→ 去掉该词并回车 */
export function extractSend(text) {
  let t = String(text || '').trim()
  for (const w of cfg.sendWords) {
    const re = new RegExp(`[\\s，。,.!！?？、；;：:…~～]*${w}${TAIL_NOISE}`)
    if (re.test(t)) return { text: t.replace(re, '').trim(), send: true }
  }
  const bare = t.replace(new RegExp(TAIL_NOISE), '')
  for (const w of cfg.sendWords) {
    if (w.length < 2) continue
    const cand = bare.slice(-w.length)
    if (cand.length === w.length && lev(cand, w) <= 1) {
      const body = bare.slice(0, -w.length).replace(new RegExp(TAIL_NOISE), '')
      return { text: body.trim(), send: true }
    }
  }
  return { text: t, send: false }
}

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
export function cnToNum(s) {
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  let total = 0, num = 0
  for (const ch of s) {
    if (CN_DIGIT[ch] !== undefined) num = CN_DIGIT[ch]
    else if (ch === '十') { total += (num || 1) * 10; num = 0 }
    else if (ch === '百') { total += (num || 1) * 100; num = 0 }
    else if (ch === '千') { total += (num || 1) * 1000; num = 0 }
    else return null
  }
  return total + num
}

// ── 焦点应用 / 上屏 ──
let focusCache = { at: 0, app: '' }
export async function focusedApp() {
  const now = Date.now()
  if (now - focusCache.at < 250) return focusCache.app
  const app = await new Promise((resolve) => {
    const p = spawn('niri', ['msg', '-j', 'focused-window'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let s = ''
    p.stdout.on('data', (d) => { s += d })
    p.on('error', () => resolve(''))
    p.on('close', () => { try { resolve(JSON.parse(s).app_id || '') } catch { resolve('') } })
  })
  focusCache = { at: now, app }
  return app
}

export async function typeText(text, { delay = cfg.typeDelay } = {}) {
  if (!text) return
  await sleep(120)
  const app = await focusedApp()
  if (cfg.pasteApps.includes(app)) {
    // Qt 客户端(微信)对虚拟键盘 Unicode keysym 处理有缺陷 → 剪贴板粘贴
    const prev = await new Promise((resolve) => {
      const p = spawn('wl-paste', ['--no-newline'], { stdio: ['ignore', 'pipe', 'ignore'] })
      let s = ''
      p.stdout.on('data', (d) => { s += d })
      p.on('error', () => resolve(null))
      p.on('close', (code) => resolve(code === 0 ? s : null))
    })
    await run('wl-copy', [], text)
    await sleep(40)
    await run('wtype', ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'])
    if (prev !== null) { await sleep(150); await run('wl-copy', [], prev) }
    return
  }
  const code = await run('wtype', ['-d', String(delay), '--', text])
  if (code !== 0) {
    await run('wl-copy', [], text)
    notify('wtype 失败,已复制到剪贴板')
  }
}

export async function pressEnter() {
  await sleep(120)
  await run('wtype', ['-k', 'Return'])
}
