// 文件放哪，网页怎么读到它们。
//
// 网页走自己的 app:// 协议，不用 file://（file:// 下每个文件各算一个来源，主题之间、外壳和主题之间说不清）：
//   app://saver/ui/...            → app/shell/（屏保外壳）
//   app://saver/theme/<id>/...    → 那个主题的目录（themes.js 找到的，可能在别的 npm 包里）
// 只认这几个根目录，../ 出不去。
import { net, protocol } from 'electron'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PKG_DIR } from './dirs.js'

export const SCHEME = 'app'
const ORIGIN = `${SCHEME}://saver`

export function preloadPath() {
  return join(PKG_DIR, 'app', 'preload.cjs')
}

const roots = new Map([['ui', join(PKG_DIR, 'app', 'shell')]])

/** 主题目录挂到 app://saver/theme/<id>/ 下 */
export function mountTheme(id, dir) {
  roots.set(`theme/${id}`, resolve(dir))
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
}

export function themeUrl(id) {
  return `${ORIGIN}/theme/${encodeURIComponent(id)}/index.html`
}

export function loadShell(win, query = {}) {
  const qs = new URLSearchParams(query).toString()
  return win.loadURL(`${ORIGIN}/ui/index.html${qs ? `?${qs}` : ''}`)
}

/** 要在 app ready 之前调 */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

/** app ready 之后调 */
export function serveScheme() {
  protocol.handle(SCHEME, (req) => {
    const url = new URL(req.url)
    if (url.host !== 'saver') return new Response('not found', { status: 404 })
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
    const key = parts[0] === 'theme' ? `theme/${parts[1]}` : parts[0]
    const root = roots.get(key)
    if (!root) return new Response('not found', { status: 404 })
    const path = resolve(root, ...parts.slice(parts[0] === 'theme' ? 2 : 1))
    if (!inside(root, path)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(path).href, { headers: req.headers, bypassCustomProtocolHandlers: true })
  })
}
