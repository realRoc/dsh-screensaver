// 每块屏幕放哪个主题（app/screens.js）：排顺序、列表比屏幕短、没配。
import { describe, expect, it } from 'vitest'
import { assignThemes, orderDisplays, themeForScreen } from '../app/screens.js'

const d = (id, x, y = 0) => ({ id, bounds: { x, y } })
// 主屏 1 在中间，左边 2，右边 3，右边上面 4
const displays = [d(3, 1920), d(1, 0), d(4, 1920, -1080), d(2, -1440)]

describe('每块屏幕的主题', () => {
  it('主屏第一，其余从左到右，左右一样从上到下', () => {
    expect(orderDisplays(displays, 1).map((x) => x.id)).toEqual([1, 2, 4, 3])
    expect(orderDisplays(displays, 99).map((x) => x.id)).toEqual([2, 1, 4, 3]) // 找不到主屏就只按位置
  })

  it('列表比屏幕短：多出来的屏幕用最后一个；空列表用 fallback', () => {
    expect([0, 1, 2, 3].map((i) => themeForScreen(i, ['magic-tower', 'subspace'], 'basic'))).toEqual([
      'magic-tower',
      'subspace',
      'subspace',
      'subspace',
    ])
    expect(themeForScreen(2, [], 'basic')).toBe('basic')
    expect(themeForScreen(0, undefined, 'basic')).toBe('basic')
    expect(themeForScreen(1, ['', 'subspace', 7], 'basic')).toBe('subspace')
  })

  it('assignThemes：按屏幕 id 给主题', () => {
    const plan = assignThemes(displays, 1, { theme: 'basic', screens: ['magic-tower', 'subspace', 'basic'] })
    expect(Object.fromEntries(plan)).toEqual({ 1: 'magic-tower', 2: 'subspace', 4: 'basic', 3: 'basic' })
    expect([...assignThemes(displays, 1, { theme: 'subspace' }).values()]).toEqual(['subspace', 'subspace', 'subspace', 'subspace'])
  })
})
