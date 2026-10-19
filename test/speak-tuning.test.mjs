import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_SETTINGS, SPEAK_RATE_RANGE, SPEAK_VOLUME_RANGE, normalizeSettings } from '../src/shared/protocol.ts'

/**
 * 朗读语速/音量：设置页露出这两个滑杆，伴生进程在每次朗读前读同一个文件。
 *
 * 这里只钉协议层——**越界要夹住、非法要落回默认**：SAPI 的 setRate 只收 -10..10、
 * setVolume 只收 0..100，喂进去脏值不是抛错就是静音（用户会以为"朗读坏了"）。
 */
test('朗读语速/音量：缺省走默认值', () => {
  assert.equal(DEFAULT_SETTINGS.speakRate, -1)
  assert.equal(DEFAULT_SETTINGS.speakVolume, 100)
  const normalized = normalizeSettings({})
  assert.equal(normalized.speakRate, -1)
  assert.equal(normalized.speakVolume, 100)
})

test('朗读语速/音量：合法值原样保留', () => {
  const normalized = normalizeSettings({ speakRate: 4, speakVolume: 60 })
  assert.equal(normalized.speakRate, 4)
  assert.equal(normalized.speakVolume, 60)
})

test('朗读语速/音量：越界夹到区间边界', () => {
  assert.equal(normalizeSettings({ speakRate: 99 }).speakRate, SPEAK_RATE_RANGE.max)
  assert.equal(normalizeSettings({ speakRate: -99 }).speakRate, SPEAK_RATE_RANGE.min)
  assert.equal(normalizeSettings({ speakVolume: 500 }).speakVolume, SPEAK_VOLUME_RANGE.max)
  assert.equal(normalizeSettings({ speakVolume: -20 }).speakVolume, SPEAK_VOLUME_RANGE.min)
})

test('朗读语速/音量：非法值落回默认，不写进文件', () => {
  const normalized = normalizeSettings({ speakRate: 'x', speakVolume: null })
  assert.equal(normalized.speakRate, DEFAULT_SETTINGS.speakRate)
  assert.equal(normalized.speakVolume, DEFAULT_SETTINGS.speakVolume)
  assert.equal(normalizeSettings({ speakRate: Number.NaN }).speakRate, DEFAULT_SETTINGS.speakRate)
})

test('朗读语速/音量：小数取整（滑杆本来就给整数）', () => {
  assert.equal(normalizeSettings({ speakRate: 2.6 }).speakRate, 3)
  assert.equal(normalizeSettings({ speakVolume: 49.4 }).speakVolume, 49)
})
