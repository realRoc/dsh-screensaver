// 合盖不睡：解析 pmset 输出、sudoers 规则只放行两条、开关只动自己开的、启动时收拾上次没关的、低电量自动关。
// 命令都走假的 runner，不真碰 sudo 和 pmset。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LidAwake, parseBattery, parseSleepDisabled, safeUser, sudoersRule } from '../app/lidawake.js'

const DIR = fileURLToPath(new URL('../node_modules/.cache/lidawake-test', import.meta.url))

function fake(opts = {}) {
  const state = {
    authorized: opts.authorized ?? true,
    sleepDisabled: opts.sleepDisabled ?? false,
    batt: opts.batt ?? "Now drawing from 'AC Power'\n -InternalBattery-0 80%; charging",
  }
  const calls = []
  const runner = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (line === '/usr/bin/pmset -g') return ok(`System-wide power settings:\n SleepDisabled\t\t${state.sleepDisabled ? 1 : 0}\n`)
    if (line === '/usr/bin/pmset -g batt') return ok(state.batt)
    if (line.startsWith('/usr/bin/sudo -n -l'))
      return state.authorized
        ? ok('/usr/bin/pmset -a disablesleep 1\n')
        : { code: 1, stdout: '', stderr: 'sudo: a password is required' }
    const m = /^\/usr\/bin\/sudo -n \/usr\/bin\/pmset -a disablesleep ([01])$/.exec(line)
    if (m && state.authorized) {
      state.sleepDisabled = m[1] === '1'
      return ok()
    }
    return { code: 1, stdout: '', stderr: `unexpected ${line}` }
  }
  return { state, calls, runner }
}

function lid(f, onAutoOff) {
  mkdirSync(DIR, { recursive: true })
  return new LidAwake(DIR, onAutoOff, f.runner, true)
}

afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('合盖不睡', () => {
  it('解析 pmset', () => {
    expect(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:')).toBe(true)
    expect(parseSleepDisabled(' SleepDisabled\t\t0\n')).toBe(false)
    expect(parseSleepDisabled('Currently in use:\n sleep 1')).toBe(false)
    expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t18%; discharging")).toEqual({
      onBattery: true,
      percent: 18,
    })
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t81%; charged")).toEqual({
      onBattery: false,
      percent: 81,
    })
    expect(parseBattery('')).toBeNull()
  })

  it('sudoers 规则只放行 disablesleep 的两条，用户名带怪字符就不写', () => {
    const rule = sudoersRule('wuyupeng')
    expect(rule).toContain('wuyupeng ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0\n')
    expect(rule.split('\n').filter((l) => l && !l.startsWith('#'))).toHaveLength(1)
    for (const bad of ['a b', 'x,ALL', 'u\nALL ALL=(ALL) ALL', '', '-x']) expect(() => safeUser(bad)).toThrow()
  })

  it('开了再关：留记号文件、关掉后删掉，pmset 回到 0', async () => {
    const f = fake()
    const l = lid(f)
    await l.on()
    expect(f.state.sleepDisabled).toBe(true)
    expect(l.active).toBe(true)
    expect(existsSync(join(DIR, 'lid-awake.on'))).toBe(true)
    await l.off()
    expect(f.state.sleepDisabled).toBe(false)
    expect(existsSync(join(DIR, 'lid-awake.on'))).toBe(false)
  })

  it('没授权开不了；用户自己开着的不接管，关的时候也不动', async () => {
    await expect(lid(fake({ authorized: false })).on()).rejects.toThrow(/授权/)
    const f = fake({ sleepDisabled: true })
    const l = lid(f)
    await l.on()
    expect(l.active).toBe(false)
    await l.off()
    expect(f.state.sleepDisabled).toBe(true)
    expect(f.calls.some((c) => c.endsWith('disablesleep 0'))).toBe(false)
  })

  it('启动时看到上次的记号：把睡眠恢复', async () => {
    const f = fake({ sleepDisabled: true })
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, 'lid-awake.on'), '123')
    expect(await lid(f).recover()).toBe(true)
    expect(f.state.sleepDisabled).toBe(false)
    expect(existsSync(join(DIR, 'lid-awake.on'))).toBe(false)
    expect(await lid(f).recover()).toBe(false)
  })

  it('用电池、电量低：自动关并告诉用户', async () => {
    const f = fake()
    const why = []
    const l = lid(f, (w) => why.push(w))
    await l.on()
    f.state.batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t20%; discharging"
    await l.checkBattery()
    expect(f.state.sleepDisabled).toBe(false)
    expect(why[0]).toMatch(/20%/)
  })
})
