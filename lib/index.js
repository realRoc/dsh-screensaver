// dsh 宿主插件：dsh 一启动就在后台起屏保进程（Electron 子进程，不进程序坞），dsh 退出时一起收走。
// 平时什么都不显示；按 ⌃⌥⌘L、在 dsh 里输 /screensaver、让 agent 调 screensaver 工具、或者空闲够久才盖住屏幕。
//
// 配置（cordis.patch.yml 里 dsh-screensaver 的 config，或者 profile 自己覆盖）：
//   theme        默认主题 id：basic（时钟）、subspace（亚空间跃迁，要另装主题包）……
//   idleMinutes  键鼠空闲多少分钟自动开，0 不自动开（默认 0）
//   lidAwake     开屏保时顺便打开「合盖不睡」（要先 /screensaver lid authorize 授权一次；默认 false）
//   shortcut     全局快捷键，Electron accelerator 写法；空字符串不注册（默认 Control+Alt+Command+L）
//   desktop      false 就不起屏保进程（比如没图形界面的机器）
//
// 不 import dsh 的包：从 GitHub 装的插件在 profile 的 node_modules 里，解析不到全局装的 @deepseek-ai/*。
import { launch } from './launcher.js'
import { saver } from './bridge.js'

export const name = 'dsh-screensaver'

const KEYS = ['theme', 'idleMinutes', 'lidAwake', 'shortcut']

/** 插件配置里屏保进程认的那几项 */
export function saverConfig(config) {
  const out = {}
  for (const k of KEYS) if (config?.[k] !== undefined && config[k] !== null) out[k] = config[k]
  return out
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const log = (line) => logger.info(`[dsh-screensaver] ${String(line).replace(/^\[dsh-screensaver\]\s*/, '')}`)
  if (config.desktop === false) return
  if (process.platform !== 'darwin') {
    logger.warn('[dsh-screensaver] only macOS is supported for now; not starting')
    return
  }

  let child = null
  let disposed = false
  ctx.on('dispose', () => {
    disposed = true
    const proc = child
    if (!proc) return
    saver.detach(proc)
    // 关掉 stdin 屏保进程会自己收尾退出（合盖不睡恢复、屏保关掉）；3 秒还没走再强杀
    proc.stdin?.end()
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill()
    }, 3000).unref()
  })

  // 第一次可能要下 Electron（约 100 MB）：放后台，不挡 dsh 启动
  launch({ control: true, config: saverConfig(config), log })
    .then((proc) => {
      if (disposed) {
        proc.stdin?.end()
        return
      }
      child = proc
      saver.attach(proc, log)
      proc.stdin.on('error', () => {}) // 屏保进程先退了，再写就是 EPIPE，不用管
      proc.on('error', (err) => logger.warn(`[dsh-screensaver] failed to start: ${err.message}`))
      proc.on('exit', (code) => {
        saver.detach(proc)
        if (!disposed) log(`screen saver process exited (${code})`)
      })
      log('ready: Control+Option+Command+L or /screensaver to start')
    })
    .catch((err) => logger.warn(`[dsh-screensaver] not started: ${err.message}`))
}
