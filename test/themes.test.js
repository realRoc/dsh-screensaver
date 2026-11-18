// 主题从哪来：自带的、旁边装的主题包、环境变量、数据目录；名字中英文；id 重复时前面的优先。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { listThemes, readTheme } from '../app/themes.js'

const TMP = fileURLToPath(new URL('../node_modules/.cache/themes-test', import.meta.url))
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

function theme(dir, meta) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), '')
  if (meta) writeFileSync(join(dir, 'saver.json'), JSON.stringify(meta))
}

describe('主题', () => {
  it('没有 index.html 的不算；名字按语言挑；sessions 要写 true', () => {
    theme(join(TMP, 'a'), { name: { zh: '时钟', en: 'Clock' }, sessions: 'yes' })
    expect(readTheme(join(TMP, 'a'), 'a', 'zh')).toEqual({ id: 'a', name: '时钟', dir: join(TMP, 'a') })
    expect(readTheme(join(TMP, 'a'), 'a', 'en').name).toBe('Clock')
    mkdirSync(join(TMP, 'empty'))
    expect(readTheme(join(TMP, 'empty'))).toBeNull()
  })

  it('本包自带的 + node_modules 里声明了 dsh-screensaver 主题的包 + 数据目录，基础版排第一', () => {
    const nm = join(TMP, 'node_modules')
    const pkg = join(nm, 'dsh-screensaver')
    theme(join(pkg, 'themes', 'basic'), { name: 'Clock' })
    const sub = join(nm, 'dsh-screensaver-theme-subspace')
    theme(sub, { id: 'subspace', name: 'Subspace Jump', sessions: true })
    writeFileSync(join(sub, 'package.json'), JSON.stringify({ name: 'dsh-screensaver-theme-subspace', 'dsh-screensaver': { theme: '.' } }))
    const scoped = join(nm, '@me', 'dsh-screensaver-theme-rain')
    theme(scoped)
    writeFileSync(join(scoped, 'package.json'), JSON.stringify({ name: '@me/dsh-screensaver-theme-rain', 'dsh-screensaver': { theme: '.' } }))
    mkdirSync(join(nm, 'unrelated'))
    writeFileSync(join(nm, 'unrelated', 'package.json'), '{}')
    theme(join(TMP, 'data', 'themes', 'mine'), { name: 'Mine' })
    theme(join(TMP, 'data', 'themes', 'basic'), { name: 'Shadowed' })

    const list = listThemes({ pkgDir: pkg, env: { DSH_SCREENSAVER_HOME: join(TMP, 'data') } })
    expect(list.map((t) => [t.id, t.name, !!t.sessions])).toEqual([
      ['basic', 'Clock', false],
      ['mine', 'Mine', false],
      ['rain', 'rain', false],
      ['subspace', 'Subspace Jump', true],
    ])
  })

  it('仓库里每个主题都随 npm 包发出去（files 里有它的 index.html 和 saver.json），自带的不靠另装主题包', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const { files } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const shipped = (p) => files.some((f) => p === f || p.startsWith(`${f}/`))
    const dirs = readdirSync(join(root, 'themes')).filter((d) => existsSync(join(root, 'themes', d, 'index.html')))
    expect(dirs).toEqual(expect.arrayContaining(['basic', 'subspace']))
    for (const d of dirs) {
      expect(shipped(`themes/${d}/index.html`), d).toBe(true)
      expect(shipped(`themes/${d}/saver.json`), d).toBe(true)
    }
    const ids = listThemes({ pkgDir: root, env: { DSH_SCREENSAVER_HOME: join(TMP, 'none') } }).map((t) => t.id)
    expect(ids.slice(0, 2)).toEqual(['basic', 'subspace'])
  })
})
