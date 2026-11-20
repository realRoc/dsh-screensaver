// 屏保本体：人临时离开、Claude Code / Codex / DeepSeek Harness 之类的 AI coding agent 还在跑时用，不走系统的屏保和锁屏。
//
// - 每块屏幕盖一层最顶上的窗口（app/shell/），主屏那块开 kiosk：藏程序坞和菜单栏、禁 Cmd+Tab、禁强制退出。
//   先进 simpleFullScreen（老式全屏，不新开桌面空间）再开 kiosk，不然 kiosk 会走原生全屏，把屏保放进单独的空间。
// - 窗口不是完全不透明（网页背景留一点点透明）：完全挡住的话 Chrome 会把被挡的窗口当成隐藏，定时器和动画降频，
//   被挡住的浏览器里的 agent（靠扩展驱动的那种）也跟着降频。
// - 屏保开着时不让系统睡、也不关屏；合盖睡眠也关掉（lidawake.js，lidAwake 默认开，写 false 才不管；没授权只提示一句）。
// - 解锁照着系统锁屏，指纹和密码同时都能用（都是 native/unlock/ 的 desk-unlock）：
//   屏保一开就起 `desk-unlock --listen`。它在主屏上盖一层看不见的窗口（屏保上一层），自己当前台程序
//   （Touch ID 只认前台程序，所以这期间屏保不抢焦点，Cmd+Tab 由它自己禁），一边等指纹，一边收键鼠：
//   按键或点一下就在底部那行字上面出一个它自己画的密码框，回车用系统账户核对。指纹一直在等，不用先停。
//   摸对了 / 密码对了退出码 0，关屏保；没摸对、被系统取消退出码 1，歇一秒重新起。
//   指纹被锁、没录指纹（退出码 2）就不再起，按键或点一下改弹系统验证框（Touch ID 不行就登录密码）：
//   验证框在 1000 层，跟屏保同一层，验证期间把屏保降到 pop-up-menu（101 层），验证框肯定在上面。
// - 主屏右上角跟系统菜单栏一样放电池、Wi-Fi、日期时间：`desk-unlock --status` 读（IOKit + CoreWLAN），每 20 秒一次。
// - 屏保里放什么由主题决定（themes.js 找到的目录，沙盒 iframe 里跑）。
//   saver.json 写了 "sessions": true 的主题，屏保开着时才去读本机 agent 会话（agents.js），推给它显示。
// - 每块屏幕可以放不同的主题：配置 screens（主屏第一，其余从左到右；屏幕多出来的用最后一个），见 screens.js。
//
// 这不是安全边界：长按电源键之类的拦不住。它挡的是路过的人看屏幕、碰键盘。
import { execFile, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, powerMonitor, powerSaveBlocker, screen, systemPreferences } from 'electron'
import { lineReader, listenerEvent } from '../lib/lines.js'
import { AgentWatcher } from './agents.js'
import { dataDir } from './dirs.js'
import { ensureHelper } from './helper.js'
import { LidAwake } from './lidawake.js'
import { loadShell, mountTheme, preloadPath, themeUrl } from './paths.js'
import { assignThemes } from './screens.js'
import { DEFAULT_THEME, listThemes } from './themes.js'

export const DEFAULT_SHORTCUT = process.platform === 'darwin' ? 'Control+Alt+Command+L' : 'Control+Alt+Shift+L'
const AUTH_TIMEOUT_MS = 3 * 60_000
const STATUS_EVERY_MS = 20_000
const IDLE_CHECK_MS = 15_000

/** 屏保上的字跟系统语言走：中文系统用中文，别的都用英文 */
export function saverLang(langs = app.getPreferredSystemLanguages()) {
  return (langs[0] ?? app.getLocale()).toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const REASON = { zh: '解锁屏保', en: 'Unlock the screen saver' }
const NOT_PASSED = { zh: '没验证通过', en: 'Not verified' }
const SAY = {
  noAuth: {
    zh: '这台电脑验证不了身份，屏保只能挡一挡，点一下就开',
    en: "This Mac can't verify your identity, so the screen saver only covers the screen: a click opens it",
  },
  lidRecovered: { zh: '上次合盖不睡没关掉，已经恢复睡眠了', en: 'Lid-closed sleep was left disabled last time; restored it' },
  lidUnauthorized: {
    zh: '合盖不睡还没授权，合上盖子电脑照样睡：dsh 里输 /screensaver lid authorize，或终端跑 dsh-screensaver lid authorize（输一次管理员密码）',
    en: 'Lid-closed awake is not authorized, so closing the lid still sleeps the Mac: run /screensaver lid authorize in dsh, or dsh-screensaver lid authorize in a terminal (admin password once)',
  },
}

export class Screensaver {
  /**
   * @param {{ theme?: string, screens?: string[], lidAwake?: boolean, idleMinutes?: number, shortcut?: string }} config
   * @param {{ say?: (text: string) => void, onState?: (active: boolean) => void }} hooks
   *   say：给人看的一句话（dsh 里打到日志）；onState：屏保开了 / 关了
   */
  constructor(config = {}, hooks = {}) {
    this.config = {}
    this.hooks = hooks
    this.wins = new Map() // display.id → 窗口
    this.kioskWin = null
    /** 这次屏保的安排：明说的主题、每块屏幕的列表（屏幕插拔时按它重排） */
    this.plan = null
    this.blocker = null
    this.authing = false
    this.agents = new AgentWatcher()
    this.wantsSessions = false
    /** 等着摸指纹的 desk-unlock --listen */
    this.listener = null
    this.listenTimer = null
    /** 这次屏保里指纹直接解锁用不了（指纹被锁、没录……），别再起了 */
    this.listenOff = false
    this.statusTimer = null
    this.idleTimer = null
    /** 这次屏保顺手开的合盖不睡（退出屏保时关掉）；手动开的不归屏保管 */
    this.lidBySaver = false
    this.lidManual = false
    this.helper = null
    this.shortcut = null
    this.onDisplayAdded = (_e, d) => this.cover(d, d.id === screen.getPrimaryDisplay().id)
    this.onDisplayRemoved = (_e, d) => {
      this.wins.get(d.id)?.destroy()
      this.wins.delete(d.id)
    }
    this.onPowerChange = () => this.sendSessions(this.agents.sessions)

    this.lid = new LidAwake(dataDir(), (why) => {
      this.lidBySaver = this.lidManual = false
      this.say(why)
    })
    void this.lid.recover().then((did) => did && this.say(SAY.lidRecovered[saverLang()]))

    ipcMain.handle('saver:unlock', (e) => (this.owns(e.sender) ? this.unlock() : { ok: false, msg: '' }))
    ipcMain.handle('saver:info', (e) => {
      if (!this.owns(e.sender)) return null
      return { canAuth: this.canAuthenticate(), touch: process.platform === 'darwin' && !!this.helper }
    })
    void ensureHelper(process.env, (line) => this.say(line)).then((p) => (this.helper = p))
    this.applyConfig(config)
  }

  say(text) {
    // DSH_SCREENSAVER_DEBUG：同时写进数据目录的 debug.log（程序退得快时 stdout 来不及刷出去）
    if (process.env.DSH_SCREENSAVER_DEBUG) {
      try {
        appendFileSync(join(dataDir(), 'debug.log'), `${new Date().toISOString()} ${text}\n`)
      } catch {}
    }
    if (this.hooks.say) this.hooks.say(text)
    else console.log(text)
  }

  get active() {
    return this.wins.size > 0
  }

  canAuthenticate() {
    return process.platform === 'darwin' && (!!this.helper || systemPreferences.canPromptTouchID())
  }

  /** 改配置（dsh 里改了插件配置会再发一次）：主题、快捷键、空闲自动开、合盖不睡 */
  applyConfig(config) {
    this.config = { ...this.config, ...config }
    const key = this.config.shortcut === undefined ? DEFAULT_SHORTCUT : this.config.shortcut
    if (key !== this.shortcut) {
      if (this.shortcut) globalShortcut.unregister(this.shortcut)
      this.shortcut = null
      if (key) {
        if (globalShortcut.register(key, () => void this.start())) this.shortcut = key
        else this.say(`[dsh-screensaver] shortcut ${key} is taken by another app`)
      }
    }
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    const minutes = Number(this.config.idleMinutes) || 0
    if (minutes > 0) {
      this.idleTimer = setInterval(() => {
        if (!this.active && powerMonitor.getSystemIdleTime() >= minutes * 60) void this.start()
      }, IDLE_CHECK_MS)
    }
  }

  themes() {
    return listThemes({ lang: saverLang() })
  }

  /** 要用的主题：可以临时指定 id（/screensaver subspace），否则看配置，都没有用基础版 */
  theme(id) {
    const themes = this.themes()
    return themes.find((x) => x.id === (id || this.config.theme || DEFAULT_THEME)) ?? themes[0]
  }

  owns(sender) {
    for (const w of this.wins.values()) if (!w.isDestroyed() && w.webContents.id === sender.id) return true
    return false
  }

  /** 推给屏保：会话列表，外加是不是在用电池（主题用电池时降帧率、降分辨率） */
  sendSessions(list, win) {
    const payload = { sessions: list, lowPower: powerMonitor.isOnBatteryPower() }
    for (const w of win ? [win] : this.wins.values()) if (!w.isDestroyed()) w.webContents.send('saver:sessions', payload)
  }

  /** 这次屏保每块屏幕的主题：Map(display.id → 主题)；明说了主题就所有屏幕都用它，否则按 screens（screens.js） */
  screenThemes(plan = this.plan) {
    const ids = assignThemes(screen.getAllDisplays(), screen.getPrimaryDisplay().id, {
      theme: plan?.theme,
      screens: plan?.theme ? undefined : plan?.screens,
    })
    const out = new Map()
    for (const [id, themeId] of ids) {
      const theme = this.theme(themeId)
      if (theme) out.set(id, theme)
    }
    return out
  }

  /**
   * 开屏保。themeId：这一次所有屏幕都用这个主题（不给就按配置的 screens / theme）。
   * opts.lidAwake：这一次要不要合盖不睡（`--now` 交给已经在跑的这个时带过来的），不给就看配置，配置没写算开。
   * opts.screens：这一次每块屏幕的主题（同上，交给已经在跑的这个时带过来的），不给就看配置。
   */
  async start(themeId, opts = {}) {
    if (this.active) return
    this.plan = { theme: themeId, screens: opts.screens ?? this.config.screens }
    const themes = [...this.screenThemes().values()]
    if (!themes.length) {
      this.plan = null
      return this.say('[dsh-screensaver] no theme found')
    }
    for (const t of themes) mountTheme(t.id, t.dir)
    if (!this.canAuthenticate()) this.say(SAY.noAuth[saverLang()])
    if ((opts.lidAwake ?? this.config.lidAwake) !== false && !this.lid.active && this.lid.supported) {
      try {
        if (await this.lid.authorized()) {
          await this.lid.on()
          this.lidBySaver = this.lid.active
        } else if (!this.lidHinted) {
          this.lidHinted = true
          this.say(SAY.lidUnauthorized[saverLang()])
        }
      } catch (e) {
        this.say(`[dsh-screensaver] lid-awake failed: ${e?.message ?? e}`)
      }
    }
    if (this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-display-sleep')
    this.wantsSessions = themes.some((t) => t.sessions)
    if (this.wantsSessions) {
      this.agents.lang = saverLang()
      this.agents.start((list) => this.sendSessions(list))
      powerMonitor.on('on-battery', this.onPowerChange)
      powerMonitor.on('on-ac', this.onPowerChange)
    }
    const primary = screen.getPrimaryDisplay()
    for (const d of screen.getAllDisplays()) this.cover(d, d.id === primary.id)
    screen.on('display-added', this.onDisplayAdded)
    screen.on('display-removed', this.onDisplayRemoved)
    this.hooks.onState?.(true)
  }

  cover(d, primary = false) {
    if (this.wins.has(d.id) || !this.plan) return
    // 插上的屏幕会改变排序，所以每次按现在的屏幕重排一遍；只给还没盖的这块用，已经开着的不动
    const theme = this.screenThemes().get(d.id) ?? this.theme(this.plan.theme)
    if (!theme) return
    mountTheme(theme.id, theme.dir)
    if (process.env.DSH_SCREENSAVER_DEBUG) this.say(`[debug] screen ${d.id}${primary ? ' (main)' : ''} → ${theme.id}`)
    if (theme.sessions && !this.wantsSessions) {
      this.wantsSessions = true
      this.agents.lang = saverLang()
      this.agents.start((list) => this.sendSessions(list))
      powerMonitor.on('on-battery', this.onPowerChange)
      powerMonitor.on('on-ac', this.onPowerChange)
    }
    const b = d.bounds
    const win = new BrowserWindow({
      ...b,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      closable: false,
      fullscreenable: false,
      simpleFullscreen: true,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      backgroundColor: '#00000000',
      webPreferences: { preload: preloadPath(), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    this.wins.set(d.id, win)
    void loadShell(win, { theme: themeUrl(theme.id), primary: primary ? '1' : '', lang: saverLang(), hud: theme.hud ? '1' : '' }).catch((e) =>
      this.say(`[dsh-screensaver] screen failed to load: ${e?.message ?? e}`),
    )
    win.webContents.on('render-process-gone', (_e, d) => this.say(`[dsh-screensaver] screen renderer gone: ${d.reason}`))
    if (process.env.DSH_SCREENSAVER_DEBUG) {
      win.webContents.on('console-message', (e) => this.say(`[page] ${e.message}`))
      win.webContents.on('did-fail-load', (_e, code, desc, url) => this.say(`[page] failed ${code} ${desc} ${url}`))
    }
    // 页面开好先给一份现成的会话列表，之后有变化再推
    if (this.wantsSessions) win.webContents.on('did-finish-load', () => this.sendSessions(this.agents.sessions, win))
    win.once('ready-to-show', () => {
      win.setBounds(b)
      // 副屏不激活程序：show() 在 Mac 上会把整个 Electron 拉到前台，要是主屏的 desk-unlock --listen 已经在等指纹，
      // 前台就被抢走了（Touch ID 只认前台程序），摸了没反应。两块屏谁先好不一定，屏保中途插上屏幕也一样
      if (primary) win.show()
      else win.showInactive()
      if (primary) {
        // 先老式全屏，再 kiosk（kiosk 看到已经全屏就不再进原生全屏），只开在一个窗口上：presentation options 是整个程序的
        if (process.platform === 'darwin') win.setSimpleFullScreen(true)
        win.setKiosk(true)
        this.kioskWin = win
        app.focus({ steal: true })
        win.focus()
        this.listenOff = false
        this.listen()
        this.watchStatus(win)
      }
    })
    // 别的程序抢走焦点就抢回来。验证身份、等指纹时不抢：验证框要焦点，等指纹的 desk-unlock 也得在前台
    win.on('blur', () => {
      if (!this.active || this.authing || this.listener) return
      setTimeout(() => {
        if (this.active && !this.authing && !this.listener && !BrowserWindow.getFocusedWindow()) {
          app.focus({ steal: true })
          ;(this.kioskWin ?? win).focus()
        }
      }, 50)
    })
  }

  async authenticate(reason) {
    if (this.helper) {
      const r = await runHelper(this.helper, reason)
      if (r !== 'unavailable') return r
    }
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID(reason)
        return { ok: true }
      } catch (e) {
        return { ok: false, msg: e?.message || NOT_PASSED[saverLang()] }
      }
    }
    // 这台电脑上验证不了身份：屏保只能当遮挡用，开屏保时已经提醒过
    return { ok: true }
  }

  async unlock() {
    if (!this.active) return { ok: true }
    if (this.authing) return { ok: false, msg: '' }
    this.authing = true
    await this.stopListening()
    for (const w of this.wins.values()) if (!w.isDestroyed()) w.setAlwaysOnTop(true, 'pop-up-menu')
    let r
    try {
      r = await this.authenticate(REASON[saverLang()])
    } finally {
      this.authing = false
    }
    if (r.ok) await this.stop()
    else {
      for (const w of this.wins.values()) if (!w.isDestroyed()) w.setAlwaysOnTop(true, 'screen-saver')
      app.focus({ steal: true })
      this.kioskWin?.focus()
      this.listen()
    }
    return r
  }

  /** 主屏右上角的电池、Wi-Fi：先读一次，之后每 20 秒一次 */
  watchStatus(win) {
    if (this.statusTimer) clearInterval(this.statusTimer)
    const push = async () => {
      const st = this.helper ? await readStatus(this.helper) : null
      if (st && !win.isDestroyed()) win.webContents.send('saver:status', st)
    }
    void push()
    this.statusTimer = setInterval(() => void push(), STATUS_EVERY_MS)
  }

  /** 起 desk-unlock --listen 等指纹；摸对了退出码 0，直接关屏保 */
  listen() {
    if (!this.active || this.authing || this.listener || this.listenOff || !this.helper) return
    const lang = saverLang()
    const child = spawn(this.helper, ['--listen', '--lang', lang, REASON[lang]], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.listener = child
    let out = ''
    // 摸到传感器打一行 touch match（认出来了）/ touch miss（没认出来）：让主屏把 30 秒后藏起来的提示、状态栏露出来，
    // 自己画提示的主题（"hud": true）还拿它做反馈。老版本只打 touch。
    // 输出一块块来，一行可能被切成两块，所以先拼成整行再认
    // 密码框出来、收起、输错、核对超时、上一次还没回来打 typing on / typing off / password wrong / timeout / busy：
    // 转成 saver:typing（on / off / wrong / timeout / busy），屏保把提示、状态栏露出来，打字期间不进纯享，输错、超时底部那行字说一声
    const readLine = lineReader((line) => {
      const ev = listenerEvent(line)
      const win = this.kioskWin
      if (ev && win && !win.isDestroyed()) win.webContents.send(ev.channel, ev.value)
    })
    child.stdout?.on('data', (b) => {
      out += b
      readLine(b)
    })
    child.stderr?.on('data', (b) => (out += b))
    child.on('error', (e) => {
      console.error('[dsh-screensaver] Touch ID listener failed to start:', e)
      if (this.listener === child) this.listener = null
      this.listenOff = true
    })
    child.on('exit', (code) => {
      if (this.listener !== child) return // 我们自己停的
      this.listener = null
      if (process.env.DSH_SCREENSAVER_DEBUG) this.say(`[debug] Touch ID listener exited ${code}: ${out.trim()}`)
      if (code !== 0) console.error(`[dsh-screensaver] Touch ID listener exited ${code}: ${out.trim()}`)
      if (code === 0) void this.stop()
      else if (code === 3) void this.unlock() // 老版本 desk-unlock：有人按键 / 点了一下，弹系统验证框
      else if (code === 2) this.listenOff = true
      else this.listenTimer = setTimeout(() => this.listen(), 1000) // 没摸对、被系统取消：歇一秒再等
    })
  }

  async stopListening() {
    if (this.listenTimer) clearTimeout(this.listenTimer)
    this.listenTimer = null
    const child = this.listener
    this.listener = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve) => {
      child.once('exit', () => resolve())
      child.kill()
      setTimeout(resolve, 1000).unref()
    })
  }

  /** 关屏保（验证过了才调；退出程序时也调） */
  async stop() {
    const was = this.active
    if (process.env.DSH_SCREENSAVER_DEBUG && was) this.say(`[debug] stop from ${new Error().stack.split('\n').slice(2, 4).join(' <- ').trim()}`)
    await this.stopListening()
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null
    screen.off('display-added', this.onDisplayAdded)
    screen.off('display-removed', this.onDisplayRemoved)
    this.agents.stop()
    powerMonitor.off('on-battery', this.onPowerChange)
    powerMonitor.off('on-ac', this.onPowerChange)
    this.wantsSessions = false
    this.plan = null
    if (this.kioskWin && !this.kioskWin.isDestroyed()) {
      this.kioskWin.setKiosk(false)
      if (process.platform === 'darwin') this.kioskWin.setSimpleFullScreen(false)
    }
    this.kioskWin = null
    for (const w of this.wins.values()) if (!w.isDestroyed()) w.destroy()
    this.wins.clear()
    if (this.blocker !== null) powerSaveBlocker.stop(this.blocker)
    this.blocker = null
    if (this.lidBySaver && !this.lidManual) await this.lid.off().catch((e) => console.error(e))
    this.lidBySaver = false
    if (was) this.hooks.onState?.(false)
  }

  // ---- 合盖不睡：授权、手动开关（dsh 命令 /screensaver lid ...） ----

  async lidState() {
    return this.lid.state()
  }

  async setLidManual(on) {
    if (on) {
      await this.lid.on()
      this.lidManual = this.lid.active
    } else {
      this.lidManual = this.lidBySaver = false
      await this.lid.off()
    }
    return this.lid.state()
  }

  async authorizeLid() {
    await this.lid.authorize()
    return this.lid.state()
  }

  async revokeLid() {
    this.lidManual = this.lidBySaver = false
    await this.lid.revoke()
    return this.lid.state()
  }

  async shutdown() {
    if (this.shortcut) globalShortcut.unregister(this.shortcut)
    if (this.idleTimer) clearInterval(this.idleTimer)
    await this.stop()
    this.lidManual = false
    await this.lid.off().catch((e) => console.error(e))
  }
}

function runHelper(path, reason) {
  return new Promise((resolve) => {
    const child = spawn(path, ['--lang', saverLang(), reason], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (b) => (out += b))
    const timer = setTimeout(() => child.kill(), AUTH_TIMEOUT_MS)
    child.on('error', () => {
      clearTimeout(timer)
      resolve('unavailable')
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true })
      else if (code === 2) resolve('unavailable')
      else resolve({ ok: false, msg: out.replace(/^denied\s*/, '').trim() || NOT_PASSED[saverLang()] })
    })
  })
}

/** 电池、Wi-Fi；读不到的是 null（台式机没电池、没无线网卡） */
function readStatus(helper) {
  return new Promise((resolve) => {
    execFile(helper, ['--status'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}
