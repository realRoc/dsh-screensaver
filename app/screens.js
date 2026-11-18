// 每块屏幕放哪个主题。不碰 Electron，好测。
//
// 配置 screens 是一串主题 id，按屏幕顺序排：第一个给主屏，后面的给其余屏幕（从左到右，左右一样再从上到下）。
// 屏幕比列表多时，多出来的用最后一个：["magic-tower", "subspace"] 就是「主屏魔法书斋，别的屏都是亚空间」。
// screens 空着（默认）所有屏幕用同一个主题（theme）。
// 开屏保时明说了一个主题（`--now subspace`、/screensaver subspace），这一次所有屏幕都用它，不看 screens。

/**
 * 屏幕排顺序：主屏第一，其余从左到右，左右一样再从上到下。
 * @param {{ id: number, bounds: { x: number, y: number } }[]} displays
 * @param {number} primaryId
 */
export function orderDisplays(displays, primaryId) {
  const rest = displays.filter((d) => d.id !== primaryId).sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  const primary = displays.find((d) => d.id === primaryId)
  return primary ? [primary, ...rest] : rest
}

/** 第 index 块屏幕（0 = 主屏）用哪个主题 id；screens 空着就是 fallback */
export function themeForScreen(index, screens, fallback) {
  const list = Array.isArray(screens) ? screens.filter((s) => typeof s === 'string' && s) : []
  if (!list.length) return fallback
  return list[Math.min(index, list.length - 1)]
}

/**
 * 每块屏幕的主题 id：Map(display.id → 主题 id)。
 * @param {{ id: number, bounds: { x: number, y: number } }[]} displays
 * @param {number} primaryId
 * @param {{ theme?: string, screens?: string[] }} plan  theme：明说的 / 配置的主题；screens：每块屏幕的
 */
export function assignThemes(displays, primaryId, { theme, screens } = {}) {
  const out = new Map()
  orderDisplays(displays, primaryId).forEach((d, i) => out.set(d.id, themeForScreen(i, screens, theme)))
  return out
}
