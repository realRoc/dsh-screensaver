// desk-unlock：Touch ID 解锁、电池和 Wi-Fi 状态的 Swift 小程序（native/unlock/ 下的 .swift，入口是 main.swift）。
//
// 从 GitHub 装的插件不跑安装脚本（pnpm 默认拦），所以不在安装时编，而是第一次用时在本机编：
// 有 Xcode 命令行工具（xcrun swiftc）就编到数据目录 bin/desk-unlock-<源码哈希前 8 位>，任何一个源文件变了都自动重编。
// 没装 Xcode 命令行工具也能用：退回 Electron 自带的 Touch ID 弹框，只是没有「直接摸就解开」和右上角电池、Wi-Fi。
// DSH_SCREENSAVER_UNLOCK 可以指到一个编好的 desk-unlock，跳过编译。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dataDir, PKG_DIR } from './dirs.js'

export const SOURCE_DIR = join(PKG_DIR, 'native', 'unlock')
export const SOURCE = join(SOURCE_DIR, 'main.swift')

/** 要一起编的源文件：目录下所有 .swift，按名字排好（哈希、编译顺序都稳定） */
export function helperSources(dir = SOURCE_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.swift'))
    .sort()
    .map((f) => join(dir, f))
}

/** 这份源码编出来该叫什么（放在数据目录 bin/ 下）；哈希算上每个文件的名字和内容 */
export function helperPath(env = process.env, sources = helperSources()) {
  const h = createHash('sha256')
  for (const f of sources) h.update(`${basename(f)}\0`).update(readFileSync(f)).update('\0')
  return join(dataDir(env), 'bin', `desk-unlock-${h.digest('hex').slice(0, 8)}`)
}

let building = null

/** 编好的 desk-unlock 路径；没编过就编（只编一次，并发调用共用一次编译）；编不了返回 null */
export function ensureHelper(env = process.env, log = console.error) {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  const given = env.DSH_SCREENSAVER_UNLOCK?.trim()
  if (given) return Promise.resolve(existsSync(given) ? given : null)
  let out
  let sources
  try {
    sources = helperSources()
    out = helperPath(env, sources)
  } catch {
    return Promise.resolve(null)
  }
  if (existsSync(out)) return Promise.resolve(out)
  building ??= new Promise((resolve) => {
    mkdirSync(join(out, '..'), { recursive: true })
    const tmp = `${out}.tmp-${process.pid}`
    log('[dsh-screensaver] first run: compiling the Touch ID helper with xcrun swiftc (10-20 s, once)')
    execFile('/usr/bin/xcrun', ['swiftc', '-O', '-o', tmp, ...sources], { timeout: 300_000 }, (err, _stdout, stderr) => {
      building = null
      if (err) {
        log(`[dsh-screensaver] could not compile the Touch ID helper, falling back to the system dialog: ${String(stderr || err.message).trim().split('\n')[0]}`)
        log('[dsh-screensaver] install the Xcode Command Line Tools (xcode-select --install) and restart to get touch-to-unlock')
        try {
          unlinkSync(tmp)
        } catch {}
        return resolve(null)
      }
      renameSync(tmp, out)
      // 旧版本编出来的删掉
      for (const f of readdirSync(join(out, '..'))) {
        if (f.startsWith('desk-unlock-') && join(out, '..', f) !== out) {
          try {
            unlinkSync(join(out, '..', f))
          } catch {}
        }
      }
      resolve(out)
    })
  })
  return building
}
