// 屏保本体：人临时离开、Claude Code / Codex / DeepSeek Harness 之类的 AI 编程代理还在跑时用，不走系统的屏保和锁屏。
//
// - 每块屏幕盖一层最顶上的窗口（app/shell/），主屏那块开 kiosk：藏程序坞和菜单栏、禁 Cmd+Tab、禁强制退出。
//   先进 simpleFullScreen（老式全屏，不新开桌面空间）再开 kiosk，不然 kiosk 会走原生全屏，把屏保放进单独的空间。
// - 窗口不是完全不透明（网页背景留一点点透明）：完全挡住的话 Chrome 会把被挡的窗口当成隐藏，定时器和动画降频，
//   被挡住的浏览器里的代理（扩展驱动的那种）也跟着降频。
// - 屏保开着时不让系统睡、也不关屏；配置了 lidAwake 再把合盖睡眠关掉（lidawake.js）。
// - 解锁两条路（都是 native/unlock/ 的 desk-unlock，LocalAuthentication）：
//   1. 直接摸 Touch ID：屏保一开就起 `desk-unlock --listen`。它在主屏上盖一层看不见的窗口（屏保上一层），
//      底部放系统的指纹小图标，并且自己当前台程序（Touch ID 只认前台程序，所以这期间屏保不抢焦点，
//      Cmd+Tab 由它自己禁）。摸对了就解开；没摸对、被取消就重新等。指纹被锁、没录指纹就不再等，只剩第 2 条路。
//   2. 按键或点一下（主屏上由 desk-unlock 收到后转过来，退出码 3）：先停掉第 1 条（传感器同一时间只给一个人用），
//      弹系统验证框，Touch ID 不行就登录密码。
//      验证框在 1000 层，跟屏保同一层，验证期间把屏保降到 pop-up-menu（101 层），验证框肯定在上面。没解开再回到第 1 条。
// - 主屏右上角跟系统菜单栏一样放电池、Wi-Fi、日期时间：`desk-unlock --status` 读（IOKit + CoreWLAN），每 20 秒一次。
// - 屏保里放什么由主题决定（themes.js 找到的目录，沙盒 iframe 里跑）。
//   saver.json 写了 "sessions": true 的主题，屏保开着时才去读本机代理会话（agents.js），推给它显示。
//
// 这不是安全边界：长按电源键之类的拦不住。它挡的是路过的人看屏幕、碰键盘。
import { execFile, spawn } from 'node:child_process'
import { app, BrowserWindow, globalShortcut, ipcMain, powerMonitor, powerSaveBlocker, screen, systemPreferences } from 'electron'
import { lineReader } from '../lib/lines.js'
import { AgentWatcher } from './agents.js'
import { dataDir } from './dirs.js'
import { ensureHelper } from './helper.js'
import { LidAwake } from './lidawake.js'
import { loadShell, mountTheme, preloadPath, themeUrl } from './paths.js'
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
}

export class Screensaver {
  /**
   * @param {{ theme?: string, lidAwake?: boolean, idleMinutes?: number, shortcut?: string }} config
   * @param {{ say?: (text: string) => void, onState?: (active: boolean) => void }} hooks
   *   say：给人看的一句话（dsh 里打到日志）；onState：屏保开了 / 关了
   */
  constructor(config = {}, hooks = {}) {
    this.config = {}
    this.hooks = hooks
    this.wins = new Map() // display.id → 窗口
    this.kioskWin = null
    this.current = null
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
    this.onDisplayAdded = (_e, d) => this.cover(d)
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

  async start(themeId) {
    if (this.active) return
    const theme = this.theme(themeId)
    if (!theme) return this.say('[dsh-screensaver] no theme found')
    mountTheme(theme.id, theme.dir)
    this.current = theme
    if (!this.canAuthenticate()) this.say(SAY.noAuth[saverLang()])
    if (this.config.lidAwake && !this.lid.active) {
      try {
        if (await this.lid.authorized()) {
          await this.lid.on()
          this.lidBySaver = this.lid.active
        }
      } catch (e) {
        this.say(`[dsh-screensaver] lid-awake failed: ${e?.message ?? e}`)
      }
    }
    if (this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-display-sleep')
    this.wantsSessions = !!theme.sessions
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
    if (this.wins.has(d.id) || !this.current) return
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
    void loadShell(win, { theme: themeUrl(this.current.id), primary: primary ? '1' : '', lang: saverLang() }).catch((e) =>
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
      win.show()
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
    // 摸到传感器（认没认出来都算）打一行 touch：让主屏把 30 秒后藏起来的提示、状态栏露出来。
    // 输出一块块来，一行可能被切成两块，所以先拼成整行再认
    const readLine = lineReader((line) => {
      if (line !== 'touch') return
      const win = this.kioskWin
      if (win && !win.isDestroyed()) win.webContents.send('saver:touch')
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
      if (code !== 0) console.error(`[dsh-screensaver] Touch ID listener exited ${code}: ${out.trim()}`)
      if (code === 0) void this.stop()
      else if (code === 3) void this.unlock() // 有人按键 / 点了一下：弹系统验证框，可以输密码
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
    await this.stopListening()
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null
    screen.off('display-added', this.onDisplayAdded)
    screen.off('display-removed', this.onDisplayRemoved)
    this.agents.stop()
    powerMonitor.off('on-battery', this.onPowerChange)
    powerMonitor.off('on-ac', this.onPowerChange)
    this.wantsSessions = false
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
