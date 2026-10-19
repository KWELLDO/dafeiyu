// 大肥鱼 · 直接执行命令文本(调试):dafeiyu --exec "切到第二个桌面" [--dry]
import { route } from './router.mjs'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const text = args.filter((a) => a !== '--dry').join(' ')
if (!text) { console.error('用法: dafeiyu --exec TEXT [--dry]'); process.exit(2) }
const ok = await route(text, { dry })
process.exit(ok ? 0 : 1)
