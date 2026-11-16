#!/usr/bin/env node
// 不装 dsh 也能用：
//   npx github:realRoc/dsh-screensaver            常驻，按 ⌃⌥⌘L 开屏保（Ctrl+C 退出）
//   npx github:realRoc/dsh-screensaver --now      马上开屏保，解开后退出（适合让 AI agent 在你走开前跑一下）
//   npx github:realRoc/dsh-screensaver --now subspace
//   npx dsh-screensaver setup                       改配置（合盖不睡、主题、空闲自动开），别的子命令见 lib/cli.js
// 配置存在数据目录的 config.json（lib/settings.js）；环境变量 DSH_SCREENSAVER_CONFIG（JSON）临时盖过它。
import { CLI_USAGE, runCli } from '../lib/cli.js'
import { launch } from '../lib/launcher.js'
import { explicitConfig } from '../lib/settings.js'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`dsh-screensaver — a lock-screen-style screen saver that keeps AI coding agents running

Usage:
  dsh-screensaver                 stay in the background; press Ctrl+Option+Cmd+L to start
  dsh-screensaver --now [theme]   start right away and exit after you unlock

Unlock with Touch ID (just touch the sensor) or any key / click for the password dialog.
Lid-closed awake is on by default once you allow it: dsh-screensaver lid authorize

${CLI_USAGE}

One-off overrides: DSH_SCREENSAVER_CONFIG='{"theme":"subspace","idleMinutes":10,"lidAwake":false}'`)
  process.exit(0)
}

const code = await runCli(args)
if (code !== null) process.exit(code)

// 只传写了的项：默认值交给屏保进程（saver.js），不然交给常驻实例时会把默认的 lidAwake 当成这次的要求
const config = explicitConfig()

try {
  const child = await launch({ args, config })
  child.on('exit', (code) => process.exit(code ?? 0))
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
} catch (e) {
  console.error(`dsh-screensaver: ${e.message}`)
  process.exit(1)
}
