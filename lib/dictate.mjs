// 大肥鱼 · 听写守护:手动(Alt+V) 或 唤醒词模式(Alt+Shift+V)
import {
  cfg, RUNTIME, log, sleep, notify, transcribe, typeText, pressEnter,
  dbfs, createHighpass, extractSend, FRAME_MS,
} from './core.mjs'
import { startCapture, playStdin } from './audio.mjs'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

const WAKE_MODE = process.argv.includes('--wake')
const STDIN_MODE = process.argv.includes('--stdin')
const PRINT_MODE = process.argv.includes('--print')

let phase = WAKE_MODE ? 'listen' : 'dictate'
let carry = ''
let phaseAt = Date.now()
let frames = []
let speechStarted = false
let sawSpeech = false
let above = 0
let silenceMs = 0
let noise = -55
let keywordChecked = false
let listenChecking = false
let idleMs = 0
let finishing = false
let draining = false
let speechStart = 0

const PRE_FRAMES = Math.ceil(300 / FRAME_MS) + 2
const WAKE_FRAMES = Math.ceil(6000 / FRAME_MS)
const hp = createHighpass()

// ── 结束词 ──
const STOP_WORDS = (process.env.DAFEIYU_STOP_WORDS || process.env.VOICE_STOP_WORDS
  || '结束,结束输入,输入结束,完毕,完事,完事了,说完了,停止输入,就这样,就这些,到此为止')
  .split(',').map((s) => s.trim()).filter(Boolean)
const stripPunct = (s) => s.replace(/[\s，。,.!！?？、；;：:…~～]/g, '')
const endsWithStopWord = (t) => STOP_WORDS.some((w) => stripPunct(t).endsWith(w))

function findWake(text) {
  for (const w of cfg.wakeWords) {
    const idx = text.indexOf(w)
    if (idx >= 0) {
      const rest = text.slice(idx + w.length).replace(/^[\s，。,.!！?？、；;：:…~～]+/, '').trim()
      return { rest }
    }
  }
  return null
}

// 手动听写进行中?唤醒守护暂停,避免重复录/重复打字
let manualCache = { at: 0, active: false }
function manualActive() {
  if (!WAKE_MODE) return false
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
  phase = 'listen'; frames = []; speechStarted = false; sawSpeech = false
  above = 0; silenceMs = 0; keywordChecked = false; idleMs = 0; carry = ''; phaseAt = Date.now()
}

function enterDictate(rest) {
  phase = 'dictate'; carry = rest || ''; frames = []; speechStarted = false
  sawSpeech = carry.length > 0; above = 0; silenceMs = 0; keywordChecked = false
  idleMs = 0; phaseAt = Date.now()
  notify('🎤 开始说话', 800)
}

async function finish(reason, { silent = false } = {}) {
  if (finishing) return
  finishing = true
  if (!silent) log(`结束(${reason})`)
  if (!silent) {
    if (reason === '静音') notify('🛑 长时间静音,已结束录音')
    else if (reason === '结束词') notify('🛑 听到结束词,已停')
    else if (reason === '超长') notify('🛑 达到时长上限,已结束录音')
  }
  draining = true
  if (!STDIN_MODE) await sleep(400) // 先收尾再断流,PipeWire 缓冲里有最后几个字
  draining = false
  try { if (recorder && !WAKE_MODE) recorder.stop() } catch {}

  const pcm = Buffer.concat([...frames.slice(speechStart), Buffer.alloc(16000 * 2 * 0.2)])
  try {
    if (!sawSpeech && pcm.length < 16000 * 0.6) {
      if (!silent) notify('没听到声音')
    } else {
      if (pcm.length / 32000 > 20 && !silent) notify('⏳ 识别中…', 3000)
      let text = await transcribe(pcm)
      text = text.replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '')
      text = (carry + text).trim()
      const parsed = extractSend(text)
      text = parsed.text
      if (text && PRINT_MODE) console.log(text)
      else if (text) await typeText(text)
      if (parsed.send) {
        if (PRINT_MODE) console.log('[回车]')
        else await pressEnter()
      }
      if (text || parsed.send) {
        await sleep(250) // 别急着退出/切状态,wtype 拆虚拟键盘太快会丢最后按键
        if (!silent) log(`已输入 ${text.length} 字${parsed.send ? ' + 回车' : ''}`)
      }
    }
  } catch (e) {
    log('失败:', e.message)
    notify(`语音输入失败: ${e.message}`)
  }

  if (WAKE_MODE) { finishing = false; resetListen(); return }
  process.exit(0)
}

async function checkKeyword() {
  if (listenChecking || finishing) return
  listenChecking = true
  try {
    const from = Math.max(0, frames.length - Math.ceil(5000 / FRAME_MS))
    const text = await transcribe(Buffer.concat(frames.slice(from)))
    if (text && endsWithStopWord(text)) finish('结束词')
  } catch (e) { log('结束词检测失败:', e.message) }
  finally { listenChecking = false }
}

async function checkWake() {
  if (listenChecking || finishing) return
  listenChecking = true
  try {
    const from = Math.max(0, frames.length - WAKE_FRAMES)
    const text = await transcribe(Buffer.concat(frames.slice(from)))
    const hit = text ? findWake(text) : null
    if (hit) { log(`唤醒:「${text}」`); enterDictate(hit.rest) }
    else if (silenceMs >= 3000) { frames = frames.slice(-PRE_FRAMES); speechStarted = false; sawSpeech = false; silenceMs = 0 }
  } catch (e) { log('唤醒检测失败:', e.message) }
  finally { listenChecking = false }
}

function pushFrame(raw) {
  if (finishing && !draining) return
  if (manualActive()) { frames.length = 0; speechStarted = false; sawSpeech = false; silenceMs = 0; return }

  const buf = hp(raw)
  const level = dbfs(buf)
  const voiced = level > Math.max(cfg.vadDb, noise + 9)

  if (phase === 'listen') {
    frames.push(buf)
    while (frames.length > WAKE_FRAMES) frames.shift()
    if (!voiced) noise = Math.max(-70, Math.min(-25, noise * 0.98 + level * 0.02))
    above = voiced ? above + 1 : 0
    if (voiced) { silenceMs = 0; sawSpeech = true } else silenceMs += FRAME_MS
    if (sawSpeech && silenceMs >= cfg.phraseMs && !listenChecking) void checkWake()
    else if (!sawSpeech && silenceMs >= 3000) { frames.length = 0; silenceMs = 0 }
    return
  }

  frames.push(buf)
  if (!speechStarted) {
    if (carry) {
      if (voiced) { speechStarted = true; speechStart = 0; silenceMs = 0; keywordChecked = false }
      else { silenceMs += FRAME_MS; if (silenceMs >= cfg.autoStopMs) void finish('静音') }
      return
    }
    if (!voiced) noise = Math.max(-70, Math.min(-25, noise * 0.98 + level * 0.02))
    above = voiced ? above + 1 : 0
    if (above >= 4) {
      speechStarted = true; sawSpeech = true; speechStart = 0; silenceMs = 0; keywordChecked = false
    } else {
      idleMs += FRAME_MS
      if (idleMs >= cfg.noSpeechMs) { void finish('一直没说话'); return }
      if (Date.now() - phaseAt > 5000) { if (WAKE_MODE) resetListen(); else process.exit(0); return }
    }
    return
  }

  if (voiced) { silenceMs = 0; keywordChecked = false } else silenceMs += FRAME_MS
  if (silenceMs >= cfg.autoStopMs) return void finish('静音')
  if (!keywordChecked && silenceMs >= cfg.phraseMs) { keywordChecked = true; void checkKeyword() }
  if (frames.length * FRAME_MS >= cfg.maxMs) return void finish('超长')
}

// ── 启动 ──
let recorder = null
if (!STDIN_MODE) {
  recorder = startCapture(pushFrame)
} else {
  playStdin(pushFrame, () => { if (WAKE_MODE) process.exit(0); finish('输入结束') })
}

process.on('SIGINT', () => { if (WAKE_MODE) process.exit(0); finish('手动') })
process.on('SIGTERM', () => { if (WAKE_MODE) process.exit(0); finish('手动') })
