import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractSend, cnToNum } from '../lib/core.mjs'

test('extractSend: 结尾触发词被去掉', () => {
  assert.deepEqual(extractSend('明天见发送'), { text: '明天见', send: true })
  assert.deepEqual(extractSend('明天见，发送。'), { text: '明天见', send: true })
  assert.deepEqual(extractSend('明天见回车'), { text: '明天见', send: true })
  assert.deepEqual(extractSend('明天见回车。嗯'), { text: '明天见', send: true })
})

test('extractSend: 容忍一个字之差', () => {
  assert.deepEqual(extractSend('明天见半送'), { text: '明天见', send: true })
})

test('extractSend: 句中出现不触发', () => {
  assert.deepEqual(extractSend('这个发送功能不错'), { text: '这个发送功能不错', send: false })
  assert.deepEqual(extractSend('明天见'), { text: '明天见', send: false })
})

test('extractSend: 单独说发送也回车', () => {
  assert.deepEqual(extractSend('发送'), { text: '', send: true })
})

test('cnToNum: 中文数字', () => {
  assert.equal(cnToNum('三'), 3)
  assert.equal(cnToNum('十一'), 11)
  assert.equal(cnToNum('二十'), 20)
  assert.equal(cnToNum('一百二十三'), 123)
  assert.equal(cnToNum('7'), 7)
})
