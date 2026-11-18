// /screensaver 命令和 screensaver 工具：参数怎么解析、发给屏保进程什么。
import { describe, expect, it } from 'vitest'
import { run, USAGE } from '../lib/command.js'
import { start } from '../lib/tool.js'
import { saverConfig } from '../lib/index.js'
import { lineReader } from '../lib/lines.js'

function fakeBridge() {
  const sent = []
  return {
    sent,
    async request(cmd, body = {}) {
      sent.push([cmd, body])
      if (cmd === 'themes') return [{ id: 'basic', name: 'Clock' }, { id: 'subspace', name: 'Subspace Jump', sessions: true }]
      if (cmd === 'lid') return { supported: true, authorized: body.action !== 'revoke', sleepDisabled: body.action === 'on', ours: true }
      return true
    },
  }
}

describe('/screensaver', () => {
  it('不带参数开默认主题，带主题名先查有没有这个主题', async () => {
    const b = fakeBridge()
    await run('', b)
    await run(' subspace ', b)
    expect(b.sent).toEqual([['start', {}], ['themes', {}], ['start', { theme: 'subspace' }]])
    await expect(run('nope', b)).rejects.toThrow('No theme "nope"')
  })

  it('好几个主题名：每块屏幕一个（主屏第一），有一个没装就报错', async () => {
    const b = fakeBridge()
    await run('subspace basic', b)
    expect(b.sent).toEqual([['themes', {}], ['start', { screens: ['subspace', 'basic'] }]])
    await expect(run('subspace rain', b)).rejects.toThrow('No theme "rain"')
  })

  it('themes 列表、lid 子命令、help', async () => {
    const b = fakeBridge()
    expect(await run('themes', b)).toContain('subspace  Subspace Jump  (shows live agent sessions)')
    expect(await run('lid on', b)).toBe('Lid-closed awake: ON')
    expect(await run('lid revoke', b)).toContain('not authorized')
    expect(await run('help', b)).toBe(USAGE)
    await expect(run('lid sideways', b)).rejects.toThrow('Usage')
  })
})

describe('screensaver 工具', () => {
  it('开屏保；主题名不对就说装了哪些', async () => {
    const b = fakeBridge()
    expect(await start({}, b)).toContain('covered')
    expect(await start({ theme: 'rain' }, b)).toBe('No theme "rain". Installed: basic, subspace')
  })
})

describe('杂项', () => {
  it('插件配置只把屏保认的那几项传过去', () => {
    expect(saverConfig({ theme: 'subspace', idleMinutes: 5, desktop: true, shortcut: null })).toEqual({ theme: 'subspace', idleMinutes: 5 })
    expect(saverConfig({ screens: ['magic-tower', 'subspace'] })).toEqual({ screens: ['magic-tower', 'subspace'] })
  })

  it('子进程输出按行拼：一行被切成几块也认得出', () => {
    const lines = []
    const feed = lineReader((l) => lines.push(l))
    feed('tou')
    feed('ch\ntouch\r\nok')
    expect(lines).toEqual(['touch', 'touch'])
    feed('\n')
    expect(lines).toEqual(['touch', 'touch', 'ok'])
  })
})
