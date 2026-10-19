// 大肥鱼 · 命令模式:规则解析 + 本地小模型兜底 + 执行
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cfg, HOME, log, sleep, run, capture, notify, typeText, extractSend, cnToNum,
} from './core.mjs'

// ── 应用别名 ──
export const APP_ALIASES = {
  浏览器: ['vivaldi', 'chrome'], 网页: ['vivaldi', 'chrome'],
  终端: ['kitty'], 微信: ['wechat'], 文件: ['thunar'], 文件管理器: ['thunar'],
  笔记: ['obsidian'], 代码: ['code', 'codium'], 编辑器: ['code', 'codium'],
}
export const APP_SPAWN = {
  终端: 'kitty', 浏览器: 'vivaldi-stable', 文件: 'thunar', 文件管理器: 'thunar',
  微信: 'wechat', 笔记: 'obsidian', 代码: 'code',
}
const APP_EN = {
  browser: '浏览器', vivaldi: '浏览器', chrome: '浏览器',
  terminal: '终端', kitty: '终端', wechat: '微信',
  files: '文件', filemanager: '文件', thunar: '文件',
  editor: '代码', code: '代码', notes: '笔记', obsidian: '笔记',
}
export function normApp(name) {
  const n = String(name || '').trim()
  return APP_EN[n.toLowerCase()] || n
}

// ── niri ──
export const niri = (...a) => capture('niri', ['msg', 'action', ...a])

export async function listWindows() {
  try { return JSON.parse(await capture('niri', ['msg', '-j', 'windows']) || '[]') } catch { return [] }
}

export async function findWindow(name) {
  const key = normApp(name)
  const cands = APP_ALIASES[key] || [key]
  const wins = await listWindows()
  for (const c of cands) {
    const lc = c.toLowerCase()
    const w = wins.find((x) => (x.app_id || '').toLowerCase().includes(lc) || (x.title || '').toLowerCase().includes(lc))
    if (w) return w
  }
  return null
}

// ── 点击(ydotool,绝对坐标;niri 上实测系数 2×)──
export async function ensureYdotoold() {
  const sock = join(process.env.XDG_RUNTIME_DIR || '/tmp', '.ydotool_socket')
  if (existsSync(sock)) return
  await capture('systemctl', ['--user', 'start', 'ydotoold.service'])
  for (let i = 0; i < 40; i++) { await sleep(100); if (existsSync(sock)) return }
}

export async function clickAt(x, y, button = 'left') {
  let W = 2560, H = 1440
  try {
    const outs = JSON.parse(await capture('niri', ['msg', '-j', 'outputs']))
    let mx = 0, my = 0
    for (const o of Object.values(outs)) {
      const l = o.logical
      if (l) { mx = Math.max(mx, l.x + l.width); my = Math.max(my, l.y + l.height) }
    }
    if (mx && my) { W = mx; H = my }
  } catch {}
  const ax = Math.round(Math.min(Math.max(x, 0), W - 1) / cfg.clickScale)
  const ay = Math.round(Math.min(Math.max(y, 0), H - 1) / cfg.clickScale)
  await ensureYdotoold()
  await capture('ydotool', ['mousemove', '-a', String(ax), String(ay)])
  await sleep(80)
  const code = button === 'right' ? '0xC1' : button === 'middle' ? '0xC2' : '0xC0'
  await capture('ydotool', ['click', code])
}

// ── 按键 ──
export const KEYMAP = {
  回车: ['-k', 'Return'], 确认: ['-k', 'Return'],
  复制: ['-M', 'ctrl', '-k', 'c', '-m', 'ctrl'],
  粘贴: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'],
  全选: ['-M', 'ctrl', '-k', 'a', '-m', 'ctrl'],
  保存: ['-M', 'ctrl', '-k', 's', '-m', 'ctrl'],
  撤销: ['-M', 'ctrl', '-k', 'z', '-m', 'ctrl'],
  删除: ['-k', 'BackSpace'], 退格: ['-k', 'BackSpace'],
  退出: ['-k', 'Escape'], 取消: ['-k', 'Escape'],
}

// ── 规则解析(纯函数,便于测试)──
const NUM = '(\\d+|[零一二两三四五六七八九十百千]+)'
const NO_SPACE = /[\s，。,.!！?？、；;：:…~～“”"']/g

export function parseRule(rawText) {
  const raw = String(rawText || '').trim()
  const t2 = raw.replace(NO_SPACE, '')
  let m

  // 把<应用/窗口>挪到第 N 个桌面(必须先于「切到 N 号桌面」)
  m = t2.match(new RegExp(`(?:把|将)(.{0,12}?)(?:挪|移|放|弄|扔|丢)(?:到|去)?第?${NUM}个?(?:桌面|工作区)`))
  if (m) {
    const n = cnToNum(m[2])
    if (n) return { type: 'move-window-to-workspace', n, who: m[1] }
  }
  m = t2.match(new RegExp(`(?:切到|切换到|去|到|回)第?${NUM}个?(?:桌面|工作区)`))
  if (m) {
    const n = cnToNum(m[1])
    if (n) return { type: 'workspace', n }
  }
  if (/(?:下一个|后面)的?(?:桌面|工作区)/.test(t2)) return { type: 'workspace-step', dir: 'down' }
  if (/(?:上一个|前面)的?(?:桌面|工作区)/.test(t2)) return { type: 'workspace-step', dir: 'up' }
  m = t2.match(new RegExp(`窗口(?:移到|放到|移动到)第?${NUM}个?(?:桌面|工作区)`))
  if (m) {
    const n = cnToNum(m[1])
    if (n) return { type: 'move-window-to-workspace', n, who: '窗口' }
  }

  if (/关闭窗口|关掉窗口|关窗口|关掉这个窗口/.test(t2)) return { type: 'window', op: 'close' }
  if (/全屏/.test(t2)) return { type: 'window', op: 'fullscreen' }
  if (/浮动|悬浮/.test(t2)) return { type: 'window', op: 'float' }
  if (/居中/.test(t2)) return { type: 'window', op: 'center' }
  if (/截(?:个|一|张)?图/.test(t2)) return { type: 'window', op: 'screenshot' }

  if (/上一个窗口|前一个窗口/.test(t2)) return { type: 'focus', dir: 'prev' }
  if (/左(?:边|面)?的?(?:窗口|列)/.test(t2)) return { type: 'focus', dir: 'left' }
  if (/右(?:边|面)?的?(?:窗口|列)/.test(t2)) return { type: 'focus', dir: 'right' }
  if (/上(?:边|面)?的?窗口/.test(t2)) return { type: 'focus', dir: 'up' }
  if (/下(?:边|面)?的?窗口/.test(t2)) return { type: 'focus', dir: 'down' }
  if (/窗口(?:往)?左(?:移|移动|挪)/.test(t2)) return { type: 'move-window', dir: 'left' }
  if (/窗口(?:往)?右(?:移|移动|挪)/.test(t2)) return { type: 'move-window', dir: 'right' }
  if (/窗口(?:往)?上(?:移|移动|挪)/.test(t2)) return { type: 'move-window', dir: 'up' }
  if (/窗口(?:往)?下(?:移|移动|挪)/.test(t2)) return { type: 'move-window', dir: 'down' }

  m = raw.match(/在(.{1,20}?)里(?:输入|打字|写)([\s\S]+)/)
  if (m) return { type: 'type', app: m[1].trim(), text: m[2].trim() }
  m = raw.match(/^(?:输入|打字|写)([\s\S]+)/)
  if (m) return { type: 'type', text: m[1].trim() }

  if (t2.includes('点')) {
    const idx = raw.lastIndexOf('点')
    const tail = idx >= 0 ? raw.slice(idx + 1) : ''
    const nums = [...tail.matchAll(/\d+|[零一二两三四五六七八九十百千]+/g)]
      .map((x) => cnToNum(x[0])).filter((n) => n !== null)
    if (nums.length >= 2) {
      const appM = t2.match(/在(.{1,20}?)里点/)
      const button = /右键|右击/.test(t2) ? 'right' : /中键|中间键/.test(t2) ? 'middle' : 'left'
      return { type: 'click', x: nums[0], y: nums[1], button, app: appM ? appM[1].trim() : '' }
    }
  }

  for (const word of Object.keys(KEYMAP)) {
    if (t2.includes(word)) return { type: 'key', name: word }
  }

  m = t2.match(/(?:打开|启动|运行)(.+)/)
  if (m) {
    const name = m[1]
    if (APP_SPAWN[name] || APP_ALIASES[name]) return { type: 'open', app: name }
  }
  m = t2.match(/(?:切到|切换到|聚焦|找到)(.+)/)
  if (m) return { type: 'focus-app', app: m[1] }

  if (/音量(?:加|大|上调)/.test(t2)) return { type: 'volume', op: 'up' }
  if (/音量(?:减|小|下调)/.test(t2)) return { type: 'volume', op: 'down' }
  if (/静音/.test(t2)) return { type: 'volume', op: 'mute' }
  return null
}

// ── 小模型兜底(默认本地 ollama;也支持 deepseek / off)──
const NLU_PROMPT = `你是桌面指令解析器。把用户的话变成 JSON,只输出 JSON,不要解释。
可用动作:
focus_workspace(n) move_window_to_workspace(n) focus_window(app) focus_window_prev
focus_column(dir) move_column(dir) close_window fullscreen toggle_floating center screenshot
open_app(app) type_text(app,text) click(x,y,button) key(name) volume(op) unknown
dir: left/right/up/down; button: left/right/middle; op: up/down/mute
app 用中文名:微信/浏览器/终端/文件/笔记/代码
key 用:回车/复制/粘贴/全选/保存/撤销/删除/退出
示例:
"切到第三个桌面" → {"action":"focus_workspace","n":3}
"把这个窗口扔到第二个桌面去" → {"action":"move_window_to_workspace","n":2}
"在微信里发一句明天见" → {"action":"type_text","app":"微信","text":"明天见"}
"帮我点一下屏幕中间偏右" → {"action":"click","x":1800,"y":720,"button":"left"}
"把浏览器弄到左边" → {"action":"move_column","dir":"left"}
"关了吧" → {"action":"close_window"}
"太吵了" → {"action":"volume","op":"down"}
"随便看看" → {"action":"unknown"}`

function deepseekKey() {
  try {
    const j = JSON.parse(readFileSync(join(HOME, '.pi/agent/auth.json'), 'utf8'))
    return j.deepseek && (j.deepseek.key || j.deepseek.apiKey) || ''
  } catch { return '' }
}

export async function nluParse(text) {
  if (!cfg.nlu || cfg.nlu === 'off') return null
  try {
    if (cfg.nlu.startsWith('ollama:')) {
      const model = cfg.nlu.slice(7)
      const r = await fetch(process.env.DAFEIYU_OLLAMA_URL || 'http://127.0.0.1:11434/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, think: false, format: 'json', keep_alive: '30m',
          options: { temperature: 0, num_ctx: 2048, num_predict: 96 },
          messages: [{ role: 'system', content: NLU_PROMPT }, { role: 'user', content: text }],
        }),
        signal: AbortSignal.timeout(20000),
      })
      const j = await r.json()
      return JSON.parse(j.message.content)
    }
    if (cfg.nlu === 'deepseek') {
      const key = deepseekKey()
      if (!key) return null
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: process.env.DAFEIYU_NLU_MODEL || 'deepseek-chat', stream: false, temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: NLU_PROMPT }, { role: 'user', content: text }],
        }),
        signal: AbortSignal.timeout(5000),
      })
      const j = await r.json()
      return JSON.parse(j.choices[0].message.content)
    }
  } catch (e) {
    log('小模型解析失败:', e.message)
  }
  return null
}

export function nluToIntent(it) {
  if (!it || typeof it !== 'object') return null
  const d = it.dir
  switch (it.action) {
    case 'focus_workspace': return Number.isFinite(Number(it.n)) ? { type: 'workspace', n: Number(it.n) } : null
    case 'move_window_to_workspace': return Number.isFinite(Number(it.n)) ? { type: 'move-window-to-workspace', n: Number(it.n), who: it.app || '窗口' } : null
    case 'focus_window': return { type: 'focus-app', app: normApp(it.app) }
    case 'focus_window_prev': return { type: 'focus', dir: 'prev' }
    case 'focus_column': return ['left', 'right', 'up', 'down'].includes(d) ? { type: 'focus', dir: d } : null
    case 'move_column': return ['left', 'right', 'up', 'down'].includes(d) ? { type: 'move-window', dir: d } : null
    case 'close_window': return { type: 'window', op: 'close' }
    case 'fullscreen': return { type: 'window', op: 'fullscreen' }
    case 'toggle_floating': return { type: 'window', op: 'float' }
    case 'center': return { type: 'window', op: 'center' }
    case 'screenshot': return { type: 'window', op: 'screenshot' }
    case 'open_app': return { type: 'open', app: normApp(it.app) }
    case 'type_text': return { type: 'type', app: normApp(it.app), text: String(it.text || '') }
    case 'click': return Number.isFinite(Number(it.x)) && Number.isFinite(Number(it.y))
      ? { type: 'click', x: Number(it.x), y: Number(it.y), button: it.button || 'left', app: normApp(it.app) } : null
    case 'key': return { type: 'key', name: String(it.name || '') }
    case 'volume': return ['up', 'down', 'mute'].includes(it.op) ? { type: 'volume', op: it.op } : null
    default: return null
  }
}

// ── 执行 ──
export async function executeIntent(intent, { dry = false } = {}) {
  if (!intent) return false
  const act = async (label, fn) => {
    if (dry) { console.log(`[dry] ${label}`); return }
    try {
      await fn()
      notify(`✅ ${label}`, 1200)
      log(`命令: ${label}`)
    } catch (e) {
      log('命令失败:', e.message)
      notify(`❌ 执行失败: ${label}`, 2000)
    }
  }

  switch (intent.type) {
    case 'workspace':
      await act(`切到 ${intent.n} 号桌面`, () => niri('focus-workspace', String(intent.n)))
      return true
    case 'workspace-step':
      await act(intent.dir === 'up' ? '上一个桌面' : '下一个桌面', () => niri(intent.dir === 'up' ? 'focus-workspace-up' : 'focus-workspace-down'))
      return true
    case 'move-window-to-workspace': {
      if (/窗口/.test(intent.who) || !intent.who) {
        await act(`窗口移到 ${intent.n} 号桌面`, () => niri('move-window-to-workspace', String(intent.n)))
        return true
      }
      const win = await findWindow(intent.who)
      if (!win) return false
      if (!dry) await niri('focus-window', '--id', String(win.id))
      await sleep(120)
      await act(`${intent.who}移到 ${intent.n} 号桌面`, () => niri('move-window-to-workspace', String(intent.n)))
      return true
    }
    case 'focus': {
      if (intent.dir === 'prev') { await act('上一个窗口', () => niri('focus-window-previous')); return true }
      const a = { left: 'focus-column-left', right: 'focus-column-right', up: 'focus-window-up', down: 'focus-window-down' }[intent.dir]
      await act(`焦点向${intent.dir}`, () => niri(a))
      return true
    }
    case 'move-window': {
      const a = { left: 'move-column-left', right: 'move-column-right', up: 'move-window-up', down: 'move-window-down' }[intent.dir]
      await act(`窗口向${intent.dir}移`, () => niri(a))
      return true
    }
    case 'window': {
      const map = {
        close: ['关闭窗口', 'close-window'], fullscreen: ['切换全屏', 'fullscreen-window'],
        float: ['切换浮动', 'toggle-window-floating'], center: ['居中', 'center-column'],
        screenshot: ['截图', 'screenshot'],
      }
      const [label, action] = map[intent.op] || []
      if (!label) return false
      await act(label, () => niri(action))
      return true
    }
    case 'open': {
      const cmd = APP_SPAWN[intent.app] || (APP_ALIASES[intent.app] ? APP_ALIASES[intent.app][0] : null)
      if (!cmd) return false
      await act(`打开 ${intent.app}`, () => niri('spawn-sh', '--', cmd))
      return true
    }
    case 'focus-app': {
      const win = await findWindow(intent.app)
      if (win) { await act(`切到 ${intent.app}`, () => niri('focus-window', '--id', String(win.id))); return true }
      const cmd = APP_SPAWN[intent.app]
      if (!cmd) return false
      await act(`打开 ${intent.app}`, () => niri('spawn-sh', '--', cmd))
      return true
    }
    case 'type': {
      const parsed = extractSend(intent.text)
      if (!parsed.text && !parsed.send) return false
      let win = null
      if (intent.app) {
        win = await findWindow(intent.app)
        if (!win) { notify(`找不到窗口: ${intent.app}`, 2000); return true }
        if (!dry) await niri('focus-window', '--id', String(win.id))
        await sleep(150)
      }
      if (parsed.text) await typeText(parsed.text)
      if (parsed.send) { await sleep(100); if (!dry) await run('wtype', ['-k', 'Return']) }
      await act(`在 ${intent.app || '当前窗口'} 输入 ${parsed.text.slice(0, 12)}${parsed.send ? ' + 回车' : ''}`, async () => {})
      return true
    }
    case 'click': {
      if (intent.app) {
        const win = await findWindow(intent.app)
        if (win && !dry) await niri('focus-window', '--id', String(win.id))
      }
      if (dry) { console.log(`[dry] click ${intent.button} ${intent.x},${intent.y}`); return true }
      await clickAt(intent.x, intent.y, intent.button)
      await act(`点击 ${intent.button} ${intent.x},${intent.y}`, async () => {})
      return true
    }
    case 'key': {
      const keys = KEYMAP[intent.name] || KEYMAP[intent.name.replace(/键$/, '')]
      if (!keys) return false
      if (dry) { console.log(`[dry] 按键 ${intent.name}`); return true }
      await run('wtype', keys)
      await act(`按键 ${intent.name}`, async () => {})
      return true
    }
    case 'volume': {
      const arg = { up: '0.05+', down: '0.05-', mute: 'toggle' }[intent.op]
      const label = { up: '音量加', down: '音量减', mute: '静音切换' }[intent.op]
      if (!arg) return false
      const call = intent.op === 'mute'
        ? () => capture('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'])
        : () => capture('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', arg])
      await act(label, call)
      return true
    }
    default: return false
  }
}

/** 规则优先;没命中再调小模型 */
export async function route(text, opts = {}) {
  const rule = parseRule(text)
  if (rule && await executeIntent(rule, opts)) return true
  const intent = nluToIntent(await nluParse(text))
  if (intent && await executeIntent(intent, opts)) return true
  if (opts.dry) console.log(`[dry] 未匹配: ${text}`)
  else { notify(`没听懂: ${text}`, 2200); log(`未匹配: ${text}`) }
  return false
}
