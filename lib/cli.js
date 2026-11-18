// 不装 dsh 时的配置入口（bin/dsh-screensaver.js 的子命令）：
//   dsh-screensaver setup                    一问一答：合盖不睡（顺手授权）、默认主题、每块屏幕的主题、空闲几分钟自动开
//   dsh-screensaver config                   看现在的配置和文件在哪
//   dsh-screensaver config <项> <值>          改一项，比如 config lidAwake off、config idleMinutes 10
//   dsh-screensaver config unset <项>         改回默认
//   dsh-screensaver lid [status|authorize|revoke]   合盖不睡的授权（弹一次管理员密码框）
//   dsh-screensaver themes                   装了哪些主题
// 在 dsh 里同样的事用 /screensaver 命令和 cordis.patch.yml。
//
// 不碰 Electron；依赖都能注入，好测。
import { createInterface } from 'node:readline/promises'
import { LidAwake } from '../app/lidawake.js'
import { dataDir } from '../app/dirs.js'
import { listThemes } from '../app/themes.js'
import { DEFAULTS, KEYS, configPath, parseValue, readSettings, writeSettings } from './settings.js'

export const SUBCOMMANDS = ['setup', 'config', 'lid', 'themes']

export const CLI_USAGE = `Settings (used when running without dsh):
  dsh-screensaver setup                    walk through the settings (lid-closed awake, theme, idle start)
  dsh-screensaver config                   show the settings and where they are saved
  dsh-screensaver config <key> <value>     change one: lidAwake on|off, theme <id>, idleMinutes <n>, shortcut <accelerator>,
                                           screens <id,id,...> (a theme per screen: main screen first, then left to right;
                                           extra screens use the last one; '' = the same theme everywhere)
  dsh-screensaver config unset <key>       back to the default
  dsh-screensaver lid [status|authorize|revoke]
                                           allow lid-closed awake (asks for an admin password once)
  dsh-screensaver themes                   list installed themes
A screen saver already running in the background picks up changes after a restart.`

function show(v) {
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(same theme on every screen)'
  if (v === '') return "'' (none)"
  return String(v)
}

function lidLine(st) {
  if (!st.supported) return 'Lid-closed awake: macOS only'
  if (!st.authorized) return 'Lid-closed awake: not authorized yet. Run `dsh-screensaver lid authorize` (asks for an admin password once).'
  return `Lid-closed awake: authorized; sleep is ${st.sleepDisabled ? 'disabled right now' : 'normal right now'}`
}

/** 默认的依赖：真的配置文件、真的 LidAwake、终端问答 */
function defaults(env) {
  return {
    path: configPath(env),
    lid: new LidAwake(dataDir(env)),
    themes: () => listThemes({ env }),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    ask: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await rl.question(q)
      } finally {
        rl.close()
      }
    },
  }
}

const yes = (answer, dflt) => {
  const a = String(answer ?? '').trim().toLowerCase()
  return a ? ['y', 'yes', '是', '好'].includes(a) : dflt
}

/**
 * 跑一个子命令；不是子命令返回 null（交给屏保本体），否则返回退出码。
 * @param {string[]} args
 */
export async function runCli(args, deps = {}) {
  const [cmd, ...rest] = args
  if (!SUBCOMMANDS.includes(cmd)) return null
  const d = { ...defaults(deps.env ?? process.env), ...deps }
  const { out } = d
  try {
    if (cmd === 'themes') {
      const list = d.themes()
      out(list.map((t) => `${t.id}  ${t.name}${t.sessions ? '  (shows live agent sessions)' : ''}`).join('\n') || 'No themes installed')
      return 0
    }

    if (cmd === 'lid') {
      const action = rest[0] ?? 'status'
      if (action === 'authorize') {
        if (!(await d.lid.authorized())) await d.lid.authorize()
        out('Lid-closed awake is authorized. The screen saver turns it on while it is up (lidAwake is on by default).')
      } else if (action === 'revoke') {
        await d.lid.revoke()
        out('Authorization removed. The Mac sleeps with the lid closed again.')
      } else if (action === 'status') {
        out(lidLine(await d.lid.state()))
      } else {
        throw new Error(CLI_USAGE)
      }
      return 0
    }

    if (cmd === 'config') {
      const saved = readSettings(d.path)
      if (rest.length === 0) {
        for (const k of KEYS) {
          const from = k in saved ? '' : '  (default)'
          const v = k in saved ? saved[k] : DEFAULTS[k]
          out(`${k.padEnd(12)}${v === undefined ? '(default)' : `${show(v)}${from}`}`)
        }
        out(`Saved in ${d.path}`)
        return 0
      }
      if (rest[0] === 'unset' && rest.length === 2) {
        if (!KEYS.includes(rest[1])) throw new Error(`unknown setting "${rest[1]}"; known: ${KEYS.join(', ')}`)
        delete saved[rest[1]]
        writeSettings(saved, d.path)
        out(`${rest[1]} is back to the default`)
        return 0
      }
      if (rest.length !== 2) throw new Error(CLI_USAGE)
      const [key, raw] = rest
      const value = parseValue(key, raw)
      const ids = key === 'theme' ? [value] : key === 'screens' ? value : []
      const missing = ids.find((id) => !d.themes().some((t) => t.id === id))
      if (missing) throw new Error(`No theme "${missing}". Installed: ${d.themes().map((t) => t.id).join(', ') || 'none'}`)
      writeSettings({ ...saved, [key]: value }, d.path)
      out(`${key} = ${show(value)}`)
      if (key === 'lidAwake' && value && !(await d.lid.authorized())) out(lidLine({ supported: d.lid.supported, authorized: false }))
      return 0
    }

    // setup：一问一答，回车用方括号里的
    const saved = readSettings(d.path)
    const cur = { ...DEFAULTS, ...saved }
    const next = { ...saved }

    next.lidAwake = yes(await d.ask(`Keep the Mac awake with the lid closed while the screen saver is up? [${cur.lidAwake ? 'Y/n' : 'y/N'}] `), cur.lidAwake)
    if (next.lidAwake && d.lid.supported && !(await d.lid.authorized())) {
      if (yes(await d.ask('That needs a one-time admin password (a sudoers rule that only allows pmset disablesleep). Authorize now? [Y/n] '), true)) {
        await d.lid.authorize()
        out('Authorized.')
      } else {
        out('Skipped. Run `dsh-screensaver lid authorize` later; until then the lid still puts the Mac to sleep.')
      }
    }

    const themes = d.themes()
    if (themes.length > 1) {
      out(themes.map((t, i) => `  ${i + 1}. ${t.name} (${t.id})`).join('\n'))
      const a = String(await d.ask(`Theme? [${cur.theme}] `)).trim()
      const t = themes[Number(a) - 1] ?? themes.find((x) => x.id === a)
      if (a && !t) out(`No theme "${a}", keeping ${cur.theme}`)
      if (t) next.theme = t.id

      // 每块屏幕不同：主屏第一，其余从左到右；回车不改，写 same 改回所有屏幕一样
      const curScreens = cur.screens?.length ? cur.screens.join(',') : 'same'
      const s = String(
        await d.ask(`A different theme on each screen? List them main screen first (numbers or ids, comma-separated), or "same" [${curScreens}] `),
      ).trim()
      if (s.toLowerCase() === 'same') next.screens = []
      else if (s) {
        const picked = s.split(/[\s,]+/).filter(Boolean).map((a) => themes[Number(a) - 1] ?? themes.find((x) => x.id === a))
        if (picked.some((x) => !x)) out(`Some of "${s}" are not installed themes, keeping ${curScreens}`)
        else next.screens = picked.map((x) => x.id)
      }
    }

    const idle = String(await d.ask(`Start by itself after how many idle minutes? 0 = never [${cur.idleMinutes}] `)).trim()
    if (idle) {
      try {
        next.idleMinutes = parseValue('idleMinutes', idle)
      } catch (e) {
        out(`${e.message}; keeping ${cur.idleMinutes}`)
      }
    }

    writeSettings(next, d.path)
    out(`Saved in ${d.path}. Start with \`dsh-screensaver --now\`, or run \`dsh-screensaver\` to wait for ⌃⌥⌘L.`)
    return 0
  } catch (e) {
    d.err(e?.message ?? String(e))
    return 1
  }
}
