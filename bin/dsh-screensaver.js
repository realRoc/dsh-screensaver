#!/usr/bin/env node
// 不装 dsh 也能用：
//   npx github:realRoc/dsh-screensaver            常驻，按 ⌃⌥⌘L 开屏保（Ctrl+C 退出）
//   npx github:realRoc/dsh-screensaver --now      马上开屏保，解开后退出（适合让 AI 代理在你走开前跑一下）
//   npx github:realRoc/dsh-screensaver --now subspace
// 配置用环境变量 DSH_SCREENSAVER_CONFIG（JSON，字段同 dsh 插件配置）。
import { launch } from '../lib/launcher.js'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`dsh-screensaver — a lock-screen-style screen saver that keeps AI coding agents running

Usage:
  dsh-screensaver                 stay in the background; press Ctrl+Option+Cmd+L to start
  dsh-screensaver --now [theme]   start right away and exit after you unlock

Unlock with Touch ID (just touch the sensor) or any key / click for the password dialog.
Config: DSH_SCREENSAVER_CONFIG='{"theme":"subspace","idleMinutes":10,"lidAwake":true}'`)
  process.exit(0)
}

let config = {}
try {
  config = JSON.parse(process.env.DSH_SCREENSAVER_CONFIG || '{}')
} catch {}

try {
  const child = await launch({ args, config })
  child.on('exit', (code) => process.exit(code ?? 0))
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
} catch (e) {
  console.error(`dsh-screensaver: ${e.message}`)
  process.exit(1)
}
