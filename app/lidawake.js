// 合盖不睡（只有 macOS）：合上盖子时 Mac 照样睡，阻止睡眠的断言（caffeinate、powerSaveBlocker）都管不了合盖，
// 能管的只有 `pmset -a disablesleep 1`，要 root。做法：
//
// - 授权：用户点一次，系统弹管理员密码框，往 /etc/sudoers.d/ 装一条规则，只放行
//   `/usr/bin/pmset -a disablesleep 1` 和 `... 0` 这两条，免密。之后开关不用再输密码。撤销授权就删掉这个文件。
// - 打开：先看 SleepDisabled 原来是不是已经是 1（用户自己开的就不归我们管，关的时候也不动它）。
//   是我们开的就在数据目录留个记号文件，再起一个脱离屏保进程的小 shell 盯着它：屏保进程没了（崩溃、被杀），它把睡眠恢复回来。
//   SleepDisabled 是持久设置，不恢复的话电脑塞进包里也不睡。
// - 屏保启动时看到记号文件（上次没收尾）就先恢复。
// - 用电池时电量掉到 LOW_BATTERY 以下自动恢复睡眠。
//
// 这里不碰 Electron，命令都走注入的 run，好测。
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
export const PMSET = '/usr/bin/pmset'
export const SUDO = '/usr/bin/sudo'
export const RULE_FILE = '/etc/sudoers.d/dsh-screensaver-pmset'
export const LOW_BATTERY = 20
const MARKER = 'lid-awake.on'
const BATTERY_POLL_MS = 60_000
export const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
/** `pmset -g` 的输出里 SleepDisabled 那一行；没有这行当作 false */
export function parseSleepDisabled(out) {
  const m = /^\s*SleepDisabled\s+(\d+)/m.exec(out)
  return !!m && m[1] !== '0'
}
/** `pmset -g batt`：用不用电池、剩多少电。读不出来返回 null */
export function parseBattery(out) {
  const pct = /(\d+)%/.exec(out)
  if (!pct) return null
  return { onBattery: /'Battery Power'/.test(out), percent: Number(pct[1]) }
}
/** 用户名只认 macOS 短名能用的字符：拼进 sudoers 的东西不能带空格、逗号、换行 */
export function safeUser(name) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`用户名不能用来写授权规则：${name}`)
  return name
}
export function sudoersRule(user) {
  const u = safeUser(user)
  return (
    '# dsh-screensaver「合盖不睡」：只放行开关合盖睡眠这两条，删掉这个文件就撤销授权\n' +
    `${u} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1, ${PMSET} -a disablesleep 0\n`
  )
}
/** AppleScript 字符串字面量 */
const asString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
/** 用系统的管理员密码框跑一段 shell（osascript … with administrator privileges） */
async function asAdmin(runner, shell, prompt) {
  const script = `do shell script ${asString(shell)} with prompt ${asString(prompt)} with administrator privileges`
  const r = await runner('/usr/bin/osascript', ['-e', script])
  if (r.code !== 0) {
    // -128：用户点了取消
    throw new Error(/-128/.test(r.stderr) ? '取消了授权' : r.stderr.trim() || '授权失败')
  }
}
export class LidAwake {
  dataDir
  onAutoOff
  runner
  supported
  /** 现在的 disablesleep 是不是我们开的 */
  ours = false
  watchdog = null
  batteryTimer = null
  constructor(dataDir, onAutoOff = () => {}, runner = run, supported = process.platform === 'darwin') {
    this.dataDir = dataDir
    this.onAutoOff = onAutoOff
    this.runner = runner
    this.supported = supported
  }
  get marker() {
    return join(this.dataDir, MARKER)
  }
  get active() {
    return this.ours
  }
  async sleepDisabled() {
    const r = await this.runner(PMSET, ['-g'])
    return parseSleepDisabled(r.stdout)
  }
  /** 装没装授权规则：sudo -n -l 能列出这条命令就是免密放行了 */
  async authorized() {
    if (!this.supported) return false
    const r = await this.runner(SUDO, ['-n', '-l', PMSET, '-a', 'disablesleep', '1'])
    return r.code === 0
  }
  async state() {
    if (!this.supported) return { supported: false, authorized: false, sleepDisabled: false, ours: false }
    const [authorized, sleepDisabled] = await Promise.all([this.authorized(), this.sleepDisabled()])
    return { supported: true, authorized, sleepDisabled, ours: this.ours }
  }
  /** 装授权规则：弹一次系统的管理员密码框。先用 visudo 检查，检查不过不装 */
  async authorize(user = userInfo().username) {
    if (!this.supported) throw new Error('只有 macOS 要这一步')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-screensaver-'))
    const tmp = join(dir, 'rule')
    try {
      writeFileSync(tmp, sudoersRule(user), { mode: 0o644 })
      if (/'/.test(tmp)) throw new Error(`临时文件路径有单引号：${tmp}`)
      await asAdmin(
        this.runner,
        `/usr/sbin/visudo -cf '${tmp}' && /usr/bin/install -m 0440 -o root -g wheel '${tmp}' '${RULE_FILE}'`,
        'dsh-screensaver 要装一条规则：以后开关「合盖不睡」不用再输密码（只放行 pmset disablesleep）。',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    if (!(await this.authorized()))
      throw new Error(`规则装上了但没生效，看看 /etc/sudoers 里有没有 #includedir /private/etc/sudoers.d`)
  }
  /** 撤销授权：先把睡眠恢复，再删规则（也要管理员密码） */
  async revoke() {
    if (!this.supported) return
    await this.off()
    await asAdmin(this.runner, `/bin/rm -f '${RULE_FILE}'`, 'dsh-screensaver 要删掉「合盖不睡」的免密规则。')
  }
  async pmset(on) {
    const r = await this.runner(SUDO, ['-n', PMSET, '-a', 'disablesleep', on ? '1' : '0'])
    if (r.code !== 0) throw new Error(r.stderr.trim() || `pmset 失败（${r.code}）`)
  }
  /** 打开合盖不睡。没授权抛错；用户自己已经开着的话什么也不做（也不会替他关） */
  async on() {
    if (!this.supported) throw new Error('只有 macOS 支持合盖不睡')
    if (this.ours) return
    if (!(await this.authorized())) throw new Error('还没授权：先在菜单里点「授权合盖不睡」')
    if (await this.sleepDisabled()) return
    writeFileSync(this.marker, String(process.pid)) // 先留记号再开：开到一半崩了，下次启动也会去恢复
    await this.pmset(true)
    this.ours = true
    this.startWatchdog()
    this.startBatteryWatch()
  }
  /** 关掉合盖不睡（只关我们开的） */
  async off() {
    this.stopBatteryWatch()
    this.stopWatchdog()
    if (!this.ours) return
    this.ours = false
    try {
      await this.pmset(false)
    } finally {
      try {
        unlinkSync(this.marker)
      } catch {}
    }
  }
  /** 启动时调：上次是我们开的、没来得及关，现在关掉 */
  async recover() {
    if (!this.supported || !existsSync(this.marker)) return false
    try {
      if (await this.sleepDisabled()) await this.pmset(false)
      unlinkSync(this.marker)
      return true
    } catch (e) {
      console.error('恢复合盖睡眠失败:', e)
      return false
    }
  }
  /**
   * 脱离屏保进程的小 shell：每 3 秒看一眼屏保进程还在不在，不在了（崩溃、被强杀）就恢复睡眠、删记号。
   * 正常关的时候 off() 会先把它杀掉。
   */
  startWatchdog() {
    this.stopWatchdog()
    const script =
      'while kill -0 "$1" 2>/dev/null; do sleep 3; done; ' + `[ -f "$2" ] && ${SUDO} -n ${PMSET} -a disablesleep 0; rm -f "$2"`
    const child = spawn('/bin/sh', ['-c', script, 'dsh-screensaver-lid-watchdog', String(process.pid), this.marker], {
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', (e) => console.error('合盖守护没起来:', e))
    child.unref()
    this.watchdog = child
  }
  stopWatchdog() {
    if (this.watchdog && this.watchdog.exitCode === null) this.watchdog.kill()
    this.watchdog = null
  }
  startBatteryWatch() {
    this.stopBatteryWatch()
    this.batteryTimer = setInterval(() => void this.checkBattery(), BATTERY_POLL_MS)
    this.batteryTimer.unref?.()
    void this.checkBattery()
  }
  stopBatteryWatch() {
    if (this.batteryTimer) clearInterval(this.batteryTimer)
    this.batteryTimer = null
  }
  async checkBattery() {
    if (!this.ours) return
    const b = parseBattery((await this.runner(PMSET, ['-g', 'batt'])).stdout)
    if (b?.onBattery && b.percent <= LOW_BATTERY) {
      await this.off().catch((e) => console.error(e))
      this.onAutoOff(`电量只剩 ${b.percent}%，合盖不睡已经关了`)
    }
  }
}
