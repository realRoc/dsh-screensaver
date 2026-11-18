// 不装 dsh 时的配置入口：config.json 读写和优先级、`dsh-screensaver config / lid / setup` 子命令。
// 合盖授权走假的 LidAwake，不真碰 sudo。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../lib/cli.js'
import { DEFAULTS, configPath, explicitConfig, parseValue, readSettings, standaloneConfig } from '../lib/settings.js'

const DIR = fileURLToPath(new URL('../node_modules/.cache/cli-test', import.meta.url))
const PATH = join(DIR, 'config.json')
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

function fakeLid(authorized = false) {
  const calls = []
  return {
    calls,
    supported: true,
    authorized: async () => authorized,
    authorize: async () => (calls.push('authorize'), (authorized = true)),
    revoke: async () => (calls.push('revoke'), (authorized = false)),
    state: async () => ({ supported: true, authorized, sleepDisabled: false, ours: false }),
  }
}

function deps(answers = [], lid = fakeLid()) {
  const lines = []
  const errors = []
  return {
    lines,
    errors,
    lid,
    path: PATH,
    themes: () => [{ id: 'basic', name: 'Clock' }, { id: 'subspace', name: 'Subspace Jump', sessions: true }],
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    ask: async () => answers.shift() ?? '',
  }
}

describe('配置文件', () => {
  it('合盖不睡默认开；config.json 盖过默认，DSH_SCREENSAVER_CONFIG 再盖过 config.json', () => {
    expect(DEFAULTS.lidAwake).toBe(true)
    const env = { DSH_SCREENSAVER_HOME: DIR }
    expect(configPath(env)).toBe(PATH)
    expect(standaloneConfig(env)).toEqual(DEFAULTS)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(PATH, JSON.stringify({ lidAwake: false, theme: 'subspace', junk: 1 }))
    expect(standaloneConfig(env)).toEqual({ ...DEFAULTS, lidAwake: false, theme: 'subspace' })
    expect(standaloneConfig({ ...env, DSH_SCREENSAVER_CONFIG: '{"lidAwake":true}' }).lidAwake).toBe(true)
  })

  it('起屏保进程只传写了的项：没写 lidAwake 就不带，交给常驻实例时不会盖过它的配置', () => {
    const env = { DSH_SCREENSAVER_HOME: DIR }
    expect(explicitConfig(env)).toEqual({})
    expect(explicitConfig({ ...env, DSH_SCREENSAVER_CONFIG: '{"lidAwake":false}' })).toEqual({ lidAwake: false })
    mkdirSync(DIR, { recursive: true })
    writeFileSync(PATH, JSON.stringify({ theme: 'subspace' }))
    expect(explicitConfig(env)).toEqual({ theme: 'subspace' })
  })

  it('值的写法：on/off、整数分钟，认不出来的报错', () => {
    expect(parseValue('lidAwake', 'off')).toBe(false)
    expect(parseValue('lidAwake', 'YES')).toBe(true)
    expect(parseValue('idleMinutes', '10')).toBe(10)
    expect(parseValue('shortcut', '')).toBe('')
    expect(() => parseValue('lidAwake', 'maybe')).toThrow()
    expect(() => parseValue('idleMinutes', '-1')).toThrow()
    expect(() => parseValue('color', 'red')).toThrow(/unknown setting/)
  })
})

describe('dsh-screensaver 子命令', () => {
  it('不是子命令交回给屏保本体', async () => {
    expect(await runCli(['--now'], deps())).toBeNull()
    expect(await runCli([], deps())).toBeNull()
  })

  it('config：改一项存进文件，没授权时提醒去授权；unset 改回默认', async () => {
    const d = deps()
    expect(await runCli(['config', 'idleMinutes', '5'], d)).toBe(0)
    expect(await runCli(['config', 'lidAwake', 'on'], d)).toBe(0)
    expect(readSettings(PATH)).toEqual({ idleMinutes: 5, lidAwake: true })
    expect(d.lines.at(-1)).toMatch(/lid authorize/)
    expect(await runCli(['config', 'unset', 'idleMinutes'], d)).toBe(0)
    expect(readSettings(PATH)).toEqual({ lidAwake: true })
  })

  it('config：主题要装着，值不对返回 1 不写文件', async () => {
    const d = deps()
    expect(await runCli(['config', 'theme', 'nope'], d)).toBe(1)
    expect(await runCli(['config', 'lidAwake', 'maybe'], d)).toBe(1)
    expect(d.errors).toHaveLength(2)
    expect(readSettings(PATH)).toEqual({})
  })

  it('config 不带参数：列出每项，标出哪些是默认', async () => {
    const d = deps()
    await runCli(['config', 'theme', 'subspace'], d)
    d.lines.length = 0
    await runCli(['config'], d)
    expect(d.lines).toContain('theme       subspace')
    expect(d.lines).toContain('lidAwake    on  (default)')
    expect(d.lines.at(-1)).toBe(`Saved in ${PATH}`)
  })

  it('lid：authorize 没授权才弹密码框，revoke 撤销', async () => {
    const lid = fakeLid()
    expect(await runCli(['lid', 'authorize'], deps([], lid))).toBe(0)
    expect(await runCli(['lid', 'authorize'], deps([], lid))).toBe(0)
    expect(await runCli(['lid', 'revoke'], deps([], lid))).toBe(0)
    expect(lid.calls).toEqual(['authorize', 'revoke'])
    const d = deps([], lid)
    await runCli(['lid'], d)
    expect(d.lines[0]).toMatch(/not authorized yet/)
  })

  it('setup：全回车就是默认（合盖不睡开），顺手授权', async () => {
    const lid = fakeLid()
    const d = deps(['', '', '', ''], lid)
    expect(await runCli(['setup'], d)).toBe(0)
    expect(lid.calls).toEqual(['authorize'])
    expect(JSON.parse(readFileSync(PATH, 'utf8'))).toEqual({ lidAwake: true })
  })

  it('setup：关掉合盖不睡、选第 2 个主题、空闲 10 分钟', async () => {
    const lid = fakeLid()
    const d = deps(['n', '2', '', '10'], lid)
    expect(await runCli(['setup'], d)).toBe(0)
    expect(lid.calls).toEqual([])
    expect(readSettings(PATH)).toEqual({ lidAwake: false, theme: 'subspace', idleMinutes: 10 })
  })

  it('setup：每块屏幕不同（编号、id 混着写），same 改回所有屏幕一样，写错了不改', async () => {
    let d = deps(['n', '', '2,basic', ''])
    expect(await runCli(['setup'], d)).toBe(0)
    expect(readSettings(PATH).screens).toEqual(['subspace', 'basic'])
    d = deps(['n', '', 'rain, 1', ''])
    await runCli(['setup'], d)
    expect(readSettings(PATH).screens).toEqual(['subspace', 'basic'])
    expect(d.lines.join('\n')).toMatch(/not installed themes/)
    d = deps(['n', '', 'same', ''])
    await runCli(['setup'], d)
    expect(readSettings(PATH).screens).toEqual([])
  })

  it('config screens：逗号 / 空格分开，查主题装没装，空的 = 所有屏幕一样', async () => {
    let d = deps()
    expect(await runCli(['config', 'screens', 'subspace, basic'], d)).toBe(0)
    expect(d.lines).toEqual(['screens = subspace, basic'])
    expect(readSettings(PATH).screens).toEqual(['subspace', 'basic'])
    d = deps()
    expect(await runCli(['config', 'screens', 'subspace rain'], d)).toBe(1)
    expect(d.errors[0]).toMatch('No theme "rain"')
    d = deps()
    expect(await runCli(['config', 'screens', ''], d)).toBe(0)
    expect(d.lines).toEqual(['screens = (same theme on every screen)'])
    expect(parseValue('screens', ['a', ' b ', ''])).toEqual(['a', 'b'])
  })
})
