// 找 Electron、起屏保进程。dsh 插件那边（lib/index.js）和单独跑（bin/）共用。
//
// electron 是本包的依赖，但从 GitHub 装插件时 pnpm 默认不跑依赖的安装脚本，electron 的二进制（约 100 MB）就没下。
// 所以第一次起的时候看一眼，没有就自己跑一遍 electron 包里的 install.js 把它下下来（从 Electron 官方的 GitHub Release，
// 设了 ELECTRON_MIRROR 就走镜像）。下过一次以后就不用了。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PKG_DIR } from '../app/dirs.js'

function electronDir(pkgDir = PKG_DIR) {
  try {
    return dirname(createRequire(join(pkgDir, 'package.json')).resolve('electron/package.json'))
  } catch {
    return null
  }
}

/** 下好了的 Electron 可执行文件；没装 / 没下返回 null */
export function electronBinary(pkgDir = PKG_DIR) {
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    try {
      return createRequire(join(pkgDir, 'package.json'))('electron')
    } catch {
      return null
    }
  }
  const dir = electronDir(pkgDir)
  if (!dir) return null
  try {
    const rel = readFileSync(join(dir, 'path.txt'), 'utf8').trim()
    const bin = join(dir, 'dist', rel)
    return rel && existsSync(bin) ? bin : null
  } catch {
    return null
  }
}

let installing = null

/** 确保 Electron 下好了，返回可执行文件路径 */
export function ensureElectron(log = console.error, pkgDir = PKG_DIR) {
  const bin = electronBinary(pkgDir)
  if (bin) return Promise.resolve(bin)
  const dir = electronDir(pkgDir)
  if (!dir) return Promise.reject(new Error(`electron is not installed next to ${pkgDir}; reinstall dsh-screensaver`))
  installing ??= new Promise((resolve, reject) => {
    log('[dsh-screensaver] first run: downloading the Electron runtime (~100 MB, once)')
    const child = spawn(process.execPath, [join(dir, 'install.js')], {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (b) => (err += b))
    child.on('error', (e) => {
      installing = null
      reject(e)
    })
    child.on('exit', (code) => {
      installing = null
      const done = electronBinary(pkgDir)
      if (code === 0 && done) resolve(done)
      else reject(new Error(`Electron download failed (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
  return installing
}

/**
 * 起屏保进程。
 * @param {{ control?: boolean, args?: string[], config?: object, log?: (line: string) => void }} opts
 *   control：dsh 子进程模式，stdin 收指令（app/main.js 开头有格式）
 */
export async function launch({ control = false, args = [], config = {}, log = console.error } = {}) {
  const electron = await ensureElectron(log)
  const env = { ...process.env, DSH_SCREENSAVER_CONFIG: JSON.stringify(config) }
  if (control) env.DSH_SCREENSAVER_CONTROL = 'stdin'
  // 从 Node 进程里起 electron 时这个变量会让它当成普通 Node 跑，别带过去
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(electron, [PKG_DIR, ...args], {
    cwd: PKG_DIR,
    env,
    stdio: control ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  })
}
