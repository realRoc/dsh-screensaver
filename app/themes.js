// 屏保主题从哪来。主题就是一个目录：index.html（在沙盒 iframe 里跑，只管画）+ saver.json（名字、要不要会话）。
//
// 主题可以分开装，想要哪个装哪个：
// 1. 这个包自带的 themes/（基础版「时钟」）；
// 2. 装在旁边的主题包：package.json 里写了 "dsh-screensaver": { "theme": "<目录，默认 .>" } 的 npm 包，
//    比如 themes/subspace 单独装的 dsh-screensaver-theme-subspace。dsh 的 profile 是 hoisted 布局，
//    主题包和本包都在同一个 node_modules 下，看本包的上一层（带 @scope 的再往下一层）；
// 3. 环境变量 DSH_SCREENSAVER_THEMES 列的目录（: 分隔，每个是一个主题，或者装着好几个主题的目录）；
// 4. 数据目录下的 themes/<id>/，自己做着玩的主题放这里就行。
//
// saver.json：
//   { "id": "subspace", "name": { "zh": "亚空间跃迁", "en": "Subspace Jump" }, "sessions": true }
// id 不写就用目录名（主题包用包名去掉 dsh-screensaver-theme- 前缀）；name 可以是字符串；
// "sessions": true 的主题才拿得到本机 Claude Code / Codex / DeepSeek Harness 会话的名字和进展。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { dataDir, PKG_DIR } from './dirs.js'

export const DEFAULT_THEME = 'basic'
const PKG_PREFIX = 'dsh-screensaver-theme-'

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

/** 一个目录是不是主题；是的话读出 { id, name, sessions, dir } */
export function readTheme(dir, fallbackId = basename(dir), lang = 'en') {
  if (!existsSync(join(dir, 'index.html'))) return null
  const meta = readJson(join(dir, 'saver.json')) ?? {}
  const id = typeof meta.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(meta.id) ? meta.id : fallbackId
  let name = meta.name
  if (name && typeof name === 'object') name = name[lang] ?? name.en ?? name.zh ?? Object.values(name)[0]
  const theme = { id, name: typeof name === 'string' && name.trim() ? name.trim() : id, dir: resolve(dir) }
  if (meta.sessions === true) theme.sessions = true
  return theme
}

/** node_modules 里声明了 "dsh-screensaver" 主题的包 */
function packageThemes(nodeModules, lang) {
  const out = []
  const candidates = []
  for (const d of subdirs(nodeModules)) {
    if (basename(d).startsWith('@')) candidates.push(...subdirs(d))
    else candidates.push(d)
  }
  for (const pkgDir of candidates) {
    const pkg = readJson(join(pkgDir, 'package.json'))
    const decl = pkg?.['dsh-screensaver']
    if (!decl || typeof decl !== 'object' || typeof decl.theme !== 'string') continue
    const id = String(pkg.name ?? basename(pkgDir)).replace(/^@[^/]+\//, '').replace(PKG_PREFIX, '')
    const theme = readTheme(resolve(pkgDir, decl.theme), id, lang)
    if (theme) out.push(theme)
  }
  return out
}

/** 一个目录：要么自己是主题，要么里面每个子目录是一个主题 */
function dirThemes(dir, lang) {
  const self = readTheme(dir, basename(dir), lang)
  if (self) return [self]
  return subdirs(dir)
    .map((d) => readTheme(d, basename(d), lang))
    .filter(Boolean)
}

/** 所有能用的主题，id 重复时前面的优先（自带 > 主题包 > 环境变量 > 数据目录） */
export function listThemes({ env = process.env, lang = 'en', pkgDir = PKG_DIR } = {}) {
  const found = [
    ...dirThemes(join(pkgDir, 'themes'), lang).filter((t) => existsSync(join(t.dir, 'index.html'))),
    ...(basename(dirname(pkgDir)) === 'node_modules' ? packageThemes(dirname(pkgDir), lang) : []),
    ...(env.DSH_SCREENSAVER_THEMES ?? '')
      .split(delimiter)
      .filter(Boolean)
      .flatMap((d) => dirThemes(d, lang)),
    ...dirThemes(join(dataDir(env), 'themes'), lang),
  ]
  const seen = new Set()
  return found
    .filter((t) => !seen.has(t.id) && seen.add(t.id))
    .sort((a, b) => (a.id === DEFAULT_THEME ? -1 : b.id === DEFAULT_THEME ? 1 : a.id.localeCompare(b.id)))
}
