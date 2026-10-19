import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRule } from '../lib/router.mjs'

test('桌面切换', () => {
  assert.deepEqual(parseRule('切到第三个桌面'), { type: 'workspace', n: 3 })
  assert.deepEqual(parseRule('回第一个桌面'), { type: 'workspace', n: 1 })
  assert.deepEqual(parseRule('下一个桌面'), { type: 'workspace-step', dir: 'down' })
})

test('窗口移动不被误判成切桌面', () => {
  assert.equal(parseRule('把终端挪到第二个桌面').type, 'move-window-to-workspace')
  assert.equal(parseRule('把终端挪到第二个桌面').who, '终端')
  assert.equal(parseRule('把窗口移到第三个桌面').n, 3)
})

test('焦点与移动', () => {
  assert.deepEqual(parseRule('左边的窗口'), { type: 'focus', dir: 'left' })
  assert.deepEqual(parseRule('窗口往右移'), { type: 'move-window', dir: 'right' })
  assert.deepEqual(parseRule('上一个窗口'), { type: 'focus', dir: 'prev' })
})

test('窗口动作', () => {
  assert.deepEqual(parseRule('关掉这个窗口'), { type: 'window', op: 'close' })
  assert.deepEqual(parseRule('全屏'), { type: 'window', op: 'fullscreen' })
  assert.deepEqual(parseRule('截个图'), { type: 'window', op: 'screenshot' })
})

test('输入与点击', () => {
  const t = parseRule('在微信里输入明天下午三点见')
  assert.equal(t.type, 'type')
  assert.equal(t.app, '微信')
  assert.equal(t.text, '明天下午三点见')

  const c = parseRule('点500 400右键')
  assert.equal(c.type, 'click')
  assert.equal(c.x, 500)
  assert.equal(c.y, 400)
  assert.equal(c.button, 'right')
})

test('未命中返回 null', () => {
  assert.equal(parseRule('今天天气不错'), null)
})
