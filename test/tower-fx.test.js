// 魔法书斋的乐器特效和骑士精灵：场景跑在浏览器里（WebGL），这里只查几处容易对不上的地方。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FX_NAMES } from '../themes/magic-tower/src/score.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url))
const text = (p) => read(p).toString('utf8')
/** PNG 宽高：IHDR 紧跟在 8 字节签名后面 */
const pngSize = (p) => { const b = read(p); return [b.readUInt32BE(16), b.readUInt32BE(20)] }

describe('magic-tower instrument effects', () => {
  const scene = text('themes/magic-tower/src/scene.js')
  const main = text('themes/magic-tower/src/main.js')
  const html = text('themes/magic-tower/index.html')

  it('every effect named in score.js can be triggered and has a gallery slot in scene.js', () => {
    const trigger = scene.slice(scene.indexOf('function triggerFx('), scene.indexOf('function playScore('))
    const gallery = scene.slice(scene.indexOf('const GALLERY = {'), scene.indexOf('function playGallery('))
    for (const name of FX_NAMES) {
      expect(trigger).toContain(`case '${name}':`)
      expect(gallery).toMatch(new RegExp(`\\b${name}: \\[`))
    }
  })

  it('the demo gallery in main.js labels every effect', () => {
    const labels = main.slice(main.indexOf('const FX_ZH = {'), main.indexOf('}', main.indexOf('const FX_ZH = {')))
    for (const name of FX_NAMES) expect(labels).toMatch(new RegExp(`\\b${name}: '`))
  })

  it('the built index.html contains the effects code (only a marker check, not a full build comparison: rebuild with node scripts/build.mjs after editing src/)', () => {
    for (const marker of ['fxgallery', 'groove', '"glitter"', '"chime"']) expect(html).toContain(marker)   // 打包后字符串都是双引号
  })

  it('the demo effect label in src/index.html uses the theme type and fades out in pure mode like the rest of the interface', () => {
    const template = text('themes/magic-tower/src/index.html')
    const rule = template.match(/^\s*#fxLabel \{[^}]*\}/m)?.[0] ?? ''      // 它自己的那条规则（不是纯享模式那行合并选择器）
    expect(rule).toContain('var(--serif)')
    expect(rule).toContain('var(--gold-hi)')
    const pure = template.split('\n').find((l) => l.includes('body.pure #ledger')) ?? ''
    expect(pure).toContain('body.pure #fxLabel')
    expect(main).not.toContain('fxLabel.style')       // 样式只在模板里，不在脚本里写死
  })
})

describe('magic-tower knight sprites', () => {
  const meta = JSON.parse(text('themes/magic-tower/assets/knight.json'))

  it('walk sheet: one row per direction, one column per frame', () => {
    const { cell, frames = meta.frames } = meta.anims.walk
    for (const pass of ['index', 'normal']) expect(pngSize(`themes/magic-tower/assets/knight_walk_${pass}.png`)).toEqual([cell * frames, cell * meta.dirs])
  })

  it('sit sheet: one row per study-camera angle, one column per frame', () => {
    const { cell, frames, rows } = meta.anims.sit
    for (const pass of ['index', 'normal', 'depth']) expect(pngSize(`themes/magic-tower/assets/knight_sit_${pass}.png`)).toEqual([cell * frames, cell * rows.length])
  })
})
