// 宿主插件（起屏保进程）和 /screensaver 命令、screensaver 工具共用的一根线。
// 挂在 globalThis 上：dsh 热重载会重新加载插件模块，几边拿到的还得是同一个屏保进程。
import { lineReader } from './lines.js'

const KEY = Symbol.for('dsh-screensaver.bridge')
const REPLY_TIMEOUT_MS = 5 * 60_000 // 授权合盖不睡要等人输管理员密码
const CHROMIUM_NOISE = /^\[\d+:\d+\/\d+\.\d+:(?:ERROR|WARNING|INFO|VERBOSE\d*):|^\d{4}-\d\d-\d\d [\d:.]+ Electron\[\d+:\d+\]/

export const saver = (globalThis[KEY] ??= {
  child: null,
  active: false,
  seq: 0,
  pending: new Map(),
  log: (line) => console.error(line),

  /** 接上新起的屏保进程：stdout 里带 "$" 的是回复 / 事件，别的当日志 */
  attach(child, log) {
    this.child = child
    this.active = false
    if (log) this.log = log
    const onLine = lineReader((line) => {
      if (!line.trim()) return
      let msg = null
      if (line.startsWith('{"$"')) {
        try {
          msg = JSON.parse(line)
        } catch {}
      }
      if (!msg) return this.log(line)
      if (msg.$ === 'reply') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      } else if (msg.$ === 'state') this.active = !!msg.active
      else if (msg.$ === 'log') this.log(String(msg.text ?? ''))
    })
    child.stdout?.on('data', onLine)
    // Chromium 自己的诊断行（[pid:tid/time:ERROR:file.cc:123] …、task_policy_set 之类）不进 dsh 日志
    const onErr = lineReader((line) => line.trim() && !CHROMIUM_NOISE.test(line) && this.log(line))
    child.stderr?.on('data', onErr)
  },

  detach(child) {
    if (child && this.child !== child) return
    this.child = null
    this.active = false
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('screen saver process exited'))
    }
    this.pending.clear()
  },

  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed
  },

  /** 发一条指令，等它回复 */
  request(cmd, body = {}) {
    if (!this.running) return Promise.reject(new Error('the screen saver process is not running (it may still be starting)'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('the screen saver did not answer in time'))
      }, REPLY_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ $: cmd, id, ...body })}\n`)
    })
  },
})
