// 大肥鱼 · 音频采集:pipewire 原始 PCM(16k/mono/s16le) → 20ms 帧
import { spawn } from 'node:child_process'
import { FRAME_BYTES, log, sleep } from './core.mjs'

export function startCapture(onFrame, { rate = 16000 } = {}) {
  let stopped = false
  let child = null
  let rest = Buffer.alloc(0)

  const launch = () => {
    if (stopped) return
    child = spawn('pw-record',
      ['--raw', '--format', 's16', '--rate', String(rate), '--channels', '1', '-q', '15', '-'],
      { stdio: ['ignore', 'pipe', 'inherit'] })
    rest = Buffer.alloc(0)
    child.stdout.on('data', (chunk) => {
      rest = rest.length ? Buffer.concat([rest, chunk]) : chunk
      while (rest.length >= FRAME_BYTES) {
        onFrame(rest.subarray(0, FRAME_BYTES))
        rest = rest.subarray(FRAME_BYTES)
      }
    })
    child.on('error', () => {})
    child.on('close', () => {
      if (stopped) return
      log('录音流断开,1s 后重连…')
      setTimeout(launch, 1000)
    })
  }

  launch()
  return {
    stop() {
      stopped = true
      try { if (child) child.kill('SIGINT') } catch {}
    },
    get child() { return child },
  }
}

/** 测试用:按真实时间回放 stdin 里的原始 PCM */
export function playStdin(onFrame, onDone) {
  const chunks = []
  process.stdin.on('data', (c) => chunks.push(c))
  process.stdin.on('end', () => {
    const all = Buffer.concat(chunks)
    let off = 0
    const timer = setInterval(() => {
      if (off + FRAME_BYTES <= all.length) {
        onFrame(all.subarray(off, off + FRAME_BYTES))
        off += FRAME_BYTES
        return
      }
      if (off < all.length) {
        const tail = Buffer.alloc(FRAME_BYTES)
        all.copy(tail, 0, off)
        onFrame(tail)
        off = all.length
        return
      }
      clearInterval(timer)
      setTimeout(onDone, 800)
    }, 20)
  })
  return { stop() {} }
}

export { sleep }
