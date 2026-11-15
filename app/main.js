// Electron 入口。两种跑法：
//
// 1. dsh 插件的子进程（lib/index.js 起的，DSH_SCREENSAVER_CONTROL=stdin）：
//    stdin 一行一条 JSON 指令，stdout 回 JSON（都带 "$" 字段，别的输出当日志），stdin 断了（dsh 退出）就收尾退出。
//      → { "$": "start", "theme": "subspace" }           开屏保（theme 可省）
//      → { "$": "config", "config": { ... } }            改配置
//      → { "$": "themes", "id": 1 }                      列主题        ← { "$": "reply", "id": 1, "result": [...] }
//      → { "$": "lid", "action": "status|authorize|revoke|on|off", "id": 2 }
//      ← { "$": "state", "active": true }               屏保开了 / 关了
// 2. 单独跑（bin/dsh-screensaver.js）：`--now [主题]` 马上开，解开后退出；不带就常驻，等快捷键 / 空闲自动开。
//    配置从 DSH_SCREENSAVER_CONFIG（JSON）读。
import { app, dialog } from 'electron'
import { registerScheme, serveScheme } from './paths.js'
import { saverLang, Screensaver } from './saver.js'

const argv = process.argv.slice(2)
const nowAt = argv.indexOf('--now')
const now = nowAt >= 0
const nowTheme = now && argv[nowAt + 1] && !argv[nowAt + 1].startsWith('-') ? argv[nowAt + 1] : undefined
const controlled = process.env.DSH_SCREENSAVER_CONTROL === 'stdin'

// 同一时间只开一个：第二次 `dsh-screensaver --now` 交给已经在跑的那个去开
if (!app.requestSingleInstanceLock({ now, theme: nowTheme })) app.exit(0)
registerScheme()
app.dock?.hide() // 不进程序坞，不抢 Cmd+Tab

function readConfig() {
  try {
    return JSON.parse(process.env.DSH_SCREENSAVER_CONFIG || '{}')
  } catch {
    return {}
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
let saver = null
let quitting = false

async function quit(code = 0) {
  if (quitting) return
  quitting = true
  await saver?.shutdown().catch(() => {})
  app.exit(code)
}

async function handle(msg) {
  const reply = (result) => msg.id !== undefined && send({ $: 'reply', id: msg.id, result })
  const fail = (e) => msg.id !== undefined && send({ $: 'reply', id: msg.id, error: String(e?.message ?? e) })
  try {
    switch (msg.$) {
      case 'start':
        await saver.start(msg.theme)
        return reply(true)
      case 'config':
        saver.applyConfig(msg.config ?? {})
        return reply(true)
      case 'themes':
        return reply(saver.themes().map(({ id, name, sessions }) => ({ id, name, sessions: !!sessions })))
      case 'lid': {
        const act = {
          status: () => saver.lidState(),
          authorize: () => saver.authorizeLid(),
          revoke: () => saver.revokeLid(),
          on: () => saver.setLidManual(true),
          off: () => saver.setLidManual(false),
        }[msg.action]
        if (!act) throw new Error(`unknown lid action ${msg.action}`)
        return reply(await act())
      }
      default:
        throw new Error(`unknown command ${msg.$}`)
    }
  } catch (e) {
    fail(e)
  }
}

function attachStdin() {
  let rest = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    rest += chunk
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        void handle(JSON.parse(line))
      } catch {
        console.error(`[dsh-screensaver] bad command: ${line.slice(0, 200)}`)
      }
    }
  })
  // dsh 退出 / 插件被卸：管道断了就收尾退出（屏保开着也关掉：没人能再收到指令）
  process.stdin.on('end', () => void quit())
  process.stdin.on('error', () => void quit())
}

async function main() {
  await app.whenReady()
  serveScheme()
  saver = new Screensaver(readConfig(), {
    say: (text) => (controlled ? send({ $: 'log', text }) : console.log(text)),
    onState: (active) => {
      if (controlled) send({ $: 'state', active })
      // 单独跑、--now 开的：解开就退出
      if (!active && now && !controlled) void quit()
    },
  })
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    if (data?.now) void saver.start(data.theme)
  })
  app.on('window-all-closed', () => {}) // 屏保关了程序不退：等下一次快捷键 / 指令
  app.on('before-quit', (e) => {
    if (!quitting) {
      e.preventDefault()
      void quit()
    }
  })
  if (controlled) attachStdin()
  if (now) await saver.start(nowTheme)
  else if (!controlled) {
    const zh = saverLang() === 'zh'
    console.log(
      zh
        ? `[dsh-screensaver] 在后台等着：按 ${saver.shortcut ?? '（快捷键没注册上）'} 开屏保，Ctrl+C 退出`
        : `[dsh-screensaver] running: press ${saver.shortcut ?? '(no shortcut registered)'} to start, Ctrl+C to quit`,
    )
  }
}

process.on('SIGINT', () => void quit())
process.on('SIGTERM', () => void quit())

main().catch((e) => {
  console.error(e)
  dialog.showErrorBox('dsh-screensaver', String(e?.stack ?? e))
  app.exit(1)
})
