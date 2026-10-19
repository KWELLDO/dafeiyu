// 大肥鱼 · 命令守护:常驻监听唤醒词,说一句指令就执行
import { cfg, RUNTIME, log, sleep, transcribe, dbfs, createHighpass, FRAME_MS } from './core.mjs'
import { route, nluParse } from './router.mjs'
import { startCapture, playStdin } from './audio.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STDIN_MODE = process.argv.includes('--stdin')
const DRY = process.argv.includes('--dry')

let phase = 'listen'
let carry = ''
let phaseAt = Date.now()
let frames = []
let speechStarted = false
let seenSpeech = false
let above = 0
let silenceMs = 0
let noise = -55
let checking = false
let finishing = false
let draining = false
let speechStart = 0

const PRE_FRAMES = Math.ceil(300 / FRAME_MS) + 2
const WAKE_FRAMES = Math.ceil(6000 / FRAME_MS)
const hp = createHighpass()

function findWake(text) {
  for (const w of cfg.cmdWakeWords) {
    const idx = text.indexOf(w)
    if (idx >= 0) return { rest: text.slice(idx + w.length).replace(/^[\s，。,.!！?？、；;：:…~～]+/, '').trim() }
  }
  return null
}

let manualCache = { at: 0, active: false }
function manualActive() {
  const now = Date.now()
  if (now - manualCache.at < 500) return manualCache.active
  let active = false
  try {
    const pid = readFileSync(join(RUNTIME, 'rec.pid'), 'utf8').trim()
    active = pid !== '' && existsSync(`/proc/${pid}`)
  } catch {}
  manualCache = { at: now, active }
  return active
}

function resetListen() {
  phase = 'listen'; frames = []; speechStarted = false; seenSpeech = false
  above = 0; silenceMs = 0; carry = ''; phaseAt = Date.now()
}

function enterDictate(rest) {
  phase = 'dictate'; carry = rest || ''; frames = []; speechStarted = false
  seenSpeech = carry.length > 0; above = 0; silenceMs = 0; idleMs = 0; phaseAt = Date.now()
}

let idleMs = 0

async function finish(reason) {
  if (finishing) return
  finishing = true
  draining = true
  if (!STDIN_MODE) await sleep(400)
  draining = false
  const pcm = Buffer.concat([...frames.slice(speechStart), Buffer.alloc(16000 * 2 * 0.2)])
  try {
    if (seenSpeech || pcm.length >= 16000 * 0.6) {
      let text = await transcribe(pcm)
      text = text.replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '')
      text = (carry + text).trim()
      if (text) await route(text, { dry: DRY })
    }
  } catch (e) {
    log('命令失败:', e.message)
  }
  finishing = false
  resetListen()
}

async function checkWake() {
  if (checking || finishing) return
  checking = true
  try {
    const from = Math.max(0, frames.length - WAKE_FRAMES)
    const text = await transcribe(Buffer.concat(frames.slice(from)))
    const hit = text ? findWake(text) : null
    if (hit) { log(`唤醒:「${text}」`); enterDictate(hit.rest) }
    else if (silenceMs >= 3000) { frames = frames.slice(-PRE_FRAMES); speechStarted = false; seenSpeech = false; silenceMs = 0 }
  } catch (e) { log('唤醒检测失败:', e.message) }
  finally { checking = false }
}

function pushFrame(raw) {
  if (finishing && !draining) return
  if (manualActive()) { frames.length = 0; speechStarted = false; seenSpeech = false; silenceMs = 0; return }

  const buf = hp(raw)
  const level = dbfs(buf)
  const voiced = level > Math.max(cfg.vadDb, noise + 9)

  if (phase === 'listen') {
    frames.push(buf)
    while (frames.length > WAKE_FRAMES) frames.shift()
    if (!voiced) noise = Math.max(-70, Math.min(-25, noise * 0.98 + level * 0.02))
    above = voiced ? above + 1 : 0
    if (voiced) { silenceMs = 0; seenSpeech = true } else silenceMs += FRAME_MS
    if (seenSpeech && silenceMs >= cfg.phraseMs && !checking) void checkWake()
    else if (!seenSpeech && silenceMs >= 3000) { frames.length = 0; silenceMs = 0 }
    return
  }

  frames.push(buf)
  if (!speechStarted) {
    if (carry) {
      if (voiced) { speechStarted = true; speechStart = 0; silenceMs = 0 }
      else { silenceMs += FRAME_MS; if (silenceMs >= cfg.autoStopMs) void finish('静音') }
      return
    }
    if (!voiced) noise = Math.max(-70, Math.min(-25, noise * 0.98 + level * 0.02))
    above = voiced ? above + 1 : 0
    if (above >= 4) { speechStarted = true; seenSpeech = true; speechStart = 0; silenceMs = 0 }
    else {
      idleMs += FRAME_MS
      if (idleMs >= cfg.noSpeechMs) { void finish('没说话'); return }
      if (Date.now() - phaseAt > 5000) resetListen()
    }
    return
  }

  if (voiced) silenceMs = 0; else silenceMs += FRAME_MS
  if (silenceMs >= cfg.autoStopMs) return void finish('静音')
  if (frames.length * FRAME_MS >= cfg.maxMs) return void finish('超长')
}

// 预热小模型,省掉第一次命令的冷启动等待
if (!STDIN_MODE) setTimeout(() => { void nluParse('预热') }, 2000)

let recorder = null
if (!STDIN_MODE) recorder = startCapture(pushFrame)
else playStdin(pushFrame, () => process.exit(0))

process.on('SIGINT', () => { try { recorder && recorder.stop() } catch {}; process.exit(0) })
process.on('SIGTERM', () => { try { recorder && recorder.stop() } catch {}; process.exit(0) })
