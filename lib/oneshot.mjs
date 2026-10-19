// 大肥鱼 · 单文件识别(调试):读取 16k/mono/s16le 原始 PCM,打印识别文本
import { readFileSync } from 'node:fs'
import { transcribe, log } from './core.mjs'

const file = process.argv[2]
if (!file) { console.error('用法: dafeiyu -p FILE'); process.exit(2) }
try {
  const pcm = readFileSync(file)
  process.stdout.write((await transcribe(pcm)) + '\n')
} catch (e) {
  log('识别失败:', e.message)
  process.exit(1)
}
