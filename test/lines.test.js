import { describe, expect, it } from 'vitest'
import { lineReader, listenerEvent } from '../lib/lines.js'

describe('listenerEvent: desk-unlock --listen 的输出 → 屏保页面的事件', () => {
  it('摸到传感器', () => {
    expect(listenerEvent('touch match')).toEqual({ channel: 'saver:touch', value: 'match' })
    expect(listenerEvent('touch miss')).toEqual({ channel: 'saver:touch', value: 'miss' })
    expect(listenerEvent('touch')).toEqual({ channel: 'saver:touch', value: '' }) // 老版本
  })

  it('密码框出来、输错、超时、上一次还没回来、收起', () => {
    const seen = []
    const read = lineReader((line) => seen.push(listenerEvent(line)))
    // 一行可能被切成两块来
    read('typing on\npassword wr')
    read('ong\npassword timeout\npassword busy\ntyping off\n')
    expect(seen).toEqual([
      { channel: 'saver:typing', value: 'on' },
      { channel: 'saver:typing', value: 'wrong' },
      { channel: 'saver:typing', value: 'timeout' },
      { channel: 'saver:typing', value: 'busy' },
      { channel: 'saver:typing', value: 'off' },
    ])
  })

  it('不认识的、退出前打的结果行不转发', () => {
    for (const line of ['ok', 'password', 'denied -1 认证失败', 'unavailable -8 locked', 'typing', 'password right', ' typing on', ''])
      expect(listenerEvent(line)).toBeNull()
  })
})
