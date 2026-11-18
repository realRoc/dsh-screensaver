// 单独跑（不装 dsh）时的配置：数据目录下的 config.json，用 `dsh-screensaver setup` / `dsh-screensaver config` 改。
// 在 dsh 里跑时配置在 cordis.patch.yml，不读这个文件。
//
// 优先级：内置默认 < config.json < 环境变量 DSH_SCREENSAVER_CONFIG（调用方临时带的，比如桌宠开屏保时带的 lidAwake）。
// 不碰 Electron：bin/ 和测试直接用。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../app/dirs.js'

/** 屏保进程认的配置项 */
export const KEYS = ['theme', 'screens', 'idleMinutes', 'lidAwake', 'shortcut']

/** 内置默认。合盖不睡默认开：没授权时什么也不动，只提示一句怎么授权；screens 空着 = 所有屏幕都用 theme */
export const DEFAULTS = { theme: 'basic', screens: [], idleMinutes: 0, lidAwake: true }

export function configPath(env = process.env) {
  return join(dataDir(env), 'config.json')
}

/** 只留认得的那几项、值也对得上类型的 */
export function pick(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const k of KEYS) {
    if (raw[k] === undefined || raw[k] === null) continue
    try {
      out[k] = parseValue(k, raw[k])
    } catch {}
  }
  return out
}

/** 命令行 / 文件里的值转成配置值；不对抛错 */
export function parseValue(key, raw) {
  const s = String(raw).trim()
  switch (key) {
    case 'lidAwake': {
      if (typeof raw === 'boolean') return raw
      const v = s.toLowerCase()
      if (['true', 'on', 'yes', 'y', '1'].includes(v)) return true
      if (['false', 'off', 'no', 'n', '0'].includes(v)) return false
      throw new Error('lidAwake must be on or off')
    }
    case 'idleMinutes': {
      const n = Number(s)
      if (!Number.isInteger(n) || n < 0) throw new Error('idleMinutes must be a whole number of minutes (0 = never)')
      return n
    }
    case 'theme':
      if (!s) throw new Error('theme must be a theme id (see `dsh-screensaver themes`)')
      return s
    case 'screens': {
      // 主屏第一，其余从左到右（app/screens.js）；数组或逗号 / 空格分开都行，空的 = 所有屏幕同一个主题
      const list = Array.isArray(raw) ? raw.map((x) => String(x).trim()) : s.split(/[\s,]+/)
      return list.filter(Boolean)
    }
    case 'shortcut':
      return s // 空字符串 = 不注册快捷键
    default:
      throw new Error(`unknown setting "${key}"; known: ${KEYS.join(', ')}`)
  }
}

export function readSettings(path = configPath()) {
  try {
    return pick(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

export function writeSettings(settings, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(pick(settings), null, 2)}\n`)
  renameSync(tmp, path) // 先写临时文件再换名：写到一半被杀也不会留半个 JSON
}

/** DSH_SCREENSAVER_CONFIG 里带的 */
export function envSettings(env = process.env) {
  try {
    return pick(JSON.parse(env.DSH_SCREENSAVER_CONFIG || '{}'))
  } catch {
    return {}
  }
}

/**
 * 用户真写了的（config.json + DSH_SCREENSAVER_CONFIG），不含默认。起屏保进程只传这个：
 * 没写的项由屏保进程自己按默认走，`--now` 交给已经在跑的那个时，没写的 lidAwake 也就不会盖过它的配置。
 */
export function explicitConfig(env = process.env) {
  return { ...readSettings(configPath(env)), ...envSettings(env) }
}

/** 单独跑时真正用的配置（给人看的：默认 + 写了的） */
export function standaloneConfig(env = process.env) {
  return { ...DEFAULTS, ...explicitConfig(env) }
}
