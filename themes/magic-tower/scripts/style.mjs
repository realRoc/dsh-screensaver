// 风格检查（《Pixel Magic》视觉圣经 §6）：录一圈关键帧，按圣经的指标打分，不靠感觉。
//
//   lights  亮度 > 0.9、面积 ≥ 6 px 的独立亮点个数：同时在抢眼的光点有几个
//   hi%     亮度 > 0.85 的像素占比：过曝 / 辉光核心
//   gold%   金色像素占比（色相 28–58°、饱和 > 0.35、明度 > 0.45）
//   sat     平均饱和度
//   edges%  强边缘像素占比（|亮度梯度| > 0.12）：画面有多「碎」
//   rank    主角对比排名：骑士外接框里的亮度标准差（局部对比），在整幅画面同样大小、而且不含光源（没有亮度 > 0.95 的像素）的
//           格子里排第几（1 = 最抢眼）。光源本身（月亮窗、烛台、灯球）可以比他亮——圣经要的就是光照着他
//   ring    骑士外接框外一圈（框放大到 2 倍）的平均亮度 ÷ 框内平均亮度：< 1 说明他身后比他暗（「安静区」）
//   cover%  塔里：骑士本人的像素里，被特效盖住（改了颜色）的比例。同一时刻多画两张：藏掉特效的、只藏掉骑士精灵的；
//           后者和原图的差就是骑士的像素（遮罩），前者和原图的差就是特效碰到的地方
//
// 目标见 docs/pixel-magic/BIBLE.md §6：书房（静）管亮点、过曝、碎度；塔（动）只管无大事件时的过曝，其余只记录；
// 转场（扎进书页、传送门、回书房）要炸，只记录不判。
//
//   node scripts/style.mjs                    1280×800，结果在 scripts/out/style/（每帧 PNG + report.json）
//   node scripts/style.mjs --size 1080x1440   竖屏
//
// 先 npm run build（测的是打包好的 index.html）；要本机装了 Google Chrome。退出码：都达标 0，有不达标的 1。
// 主角两项（rank、cover%）都有了；书房里还没量 cover%（书房的特效只在转场里出现）。录制模式的时间线会自己加会话、再进塔，所以只在开头取书房帧。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const THEME = join(HERE, '..')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const [W, H] = arg('size', '1280x800').split('x').map(Number)
const OUT = arg('out', join(HERE, 'out', 'style'))
mkdirSync(OUT, { recursive: true })

// 圣经 §6 的目标（无事件时）；不在表里的指标只记录
const BUDGET = {
  study: { lights: 15, 'hi%': 1, 'edges%': 4, rank: 1 },
  tower: { 'hi%': 3, rank: 3, 'cover%': 10 },
}
// [名字, 往前走几秒, 走之前做什么, 场景（判哪套预算；event = 只记录）]
const PLAN = [
  ['01-study-idle', 2, null, 'study'],
  ['02-study-pageturn', 2.75, null, 'study'],
  ['03-study-late', 6, null, 'study'],
  ['04-dive', 1.2, 'enter', 'event'],
  ['05-dive-portal', 1.3, null, 'event'],
  ['06-tower-arrive', 3, null, 'tower'],
  ['07-tower-climb-a', 6, null, 'tower'],
  ['08-tower-climb-b', 10, null, 'tower'],
  ['09-tower-climb-c', 14, null, 'tower'],
  ['10-tower-climb-d', 18, null, 'event'],      // 这一刻落着光之巨剑
  ['11-leave', 1.0, 'leave', 'event'],
]

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(pathToFileURL(join(THEME, 'index.html')).href + '?lang=en#demo,record' + (process.argv.includes('--splat') ? ',splat' : ''))
await page.waitForFunction(() => window.__magicTower?.rec, null, { timeout: 30_000 })
await page.waitForTimeout(3000)                       // 贴图、模型是异步加载的

const measurer = await browser.newPage()
async function measure(png, rect, noFx = null, noKnight = null) {
  return measurer.evaluate(async ([b64, rect, layers]) => {
    const img = new Image()
    await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + b64 })
    const w = img.width, h = img.height, c = new OffscreenCanvas(w, h), g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, w, h).data, n = w * h
    const lum = new Float32Array(n)
    let sumL = 0, hi = 0, gold = 0, sumS = 0
    for (let i = 0; i < n; i++) {
      const r = d[i * 4] / 255, gg = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255
      const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b
      lum[i] = L; sumL += L; if (L > 0.85) hi++
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), s = mx > 0 ? (mx - mn) / mx : 0
      sumS += s
      let hue = 0
      if (mx > mn) {
        if (mx === r) hue = 60 * (((gg - b) / (mx - mn)) % 6)
        else if (mx === gg) hue = 60 * ((b - r) / (mx - mn) + 2)
        else hue = 60 * ((r - gg) / (mx - mn) + 4)
        if (hue < 0) hue += 360
      }
      if (hue >= 28 && hue <= 58 && s > 0.35 && mx > 0.45) gold++
    }
    // 独立亮点：4 邻接连通块
    const seen = new Uint8Array(n), stack = []
    let lights = 0
    for (let i = 0; i < n; i++) {
      if (seen[i] || lum[i] <= 0.9) continue
      let area = 0
      stack.push(i); seen[i] = 1
      while (stack.length) {
        const p = stack.pop(); area++
        const x = p % w, y = (p / w) | 0
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
          if (q >= 0 && !seen[q] && lum[q] > 0.9) { seen[q] = 1; stack.push(q) }
        }
      }
      if (area >= 6) lights++
    }
    // 强边缘（中心差分，和 numpy.gradient 一致）
    let edges = 0
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, gx = (lum[i + 1] - lum[i - 1]) / 2, gy = (lum[i + w] - lum[i - w]) / 2
      if (Math.hypot(gx, gy) > 0.12) edges++
    }
    const pct = (v) => +(v / n * 100).toFixed(2)
    const out = { lum: +(sumL / n).toFixed(3), 'hi%': pct(hi), lights, 'gold%': pct(gold), sat: +(sumS / n).toFixed(3), 'edges%': pct(edges) }
    if (rect) {
      // 主角：框内亮度标准差 vs 全画面同样大小的格子（步长半格）
      const bx0 = Math.max(0, Math.round(rect.x0 * w)), by0 = Math.max(0, Math.round(rect.y0 * h))
      const bx1 = Math.min(w, Math.round(rect.x1 * w)), by1 = Math.min(h, Math.round(rect.y1 * h))
      const bw = Math.max(4, bx1 - bx0), bh = Math.max(4, by1 - by0)
      const stats = (x0, y0, x1, y1) => {
        let s = 0, s2 = 0, k = 0, mx = 0
        for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) { const L = lum[y * w + x]; s += L; s2 += L * L; k++; if (L > mx) mx = L }
        const m = k ? s / k : 0
        return { mean: m, std: k ? Math.sqrt(Math.max(0, s2 / k - m * m)) : 0, n: k, s, max: mx }
      }
      const me = stats(bx0, by0, bx0 + bw, by0 + bh)
      let better = 0
      for (let y = 0; y + bh <= h; y += Math.max(1, bh >> 1)) for (let x = 0; x + bw <= w; x += Math.max(1, bw >> 1)) {
        if (Math.abs(x - bx0) < bw / 2 && Math.abs(y - by0) < bh / 2) continue     // 跟主角框重叠一半以上的不算
        const o = stats(x, y, x + bw, y + bh)
        if (o.max <= 0.95 && o.std > me.std) better++                           // 含光源的格子不比
      }
      const big = stats(Math.round(bx0 - bw / 2), Math.round(by0 - bh / 2), Math.round(bx0 + bw * 1.5), Math.round(by0 + bh * 1.5))
      const ringMean = (big.s - me.s) / Math.max(1, big.n - me.n)
      out.rank = better + 1
      out.ring = +(ringMean / Math.max(1e-3, me.mean)).toFixed(2)
    }
    if (rect && layers) {
      // 骑士遮罩：只藏骑士精灵后变了的像素（框外扩 30% 找，免得框紧了漏掉剑和披风）；覆盖：其中藏掉特效后也变了的
      const [fx, kn] = await Promise.all(layers.map(async (b) => {
        const im = new Image(); await new Promise((r) => { im.onload = r; im.src = 'data:image/png;base64,' + b })
        const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, w, h).data
      }))
      // 遮罩门槛 16 / 255；「盖住」门槛 28 / 255：淡淡一层光晕不算，真把他盖掉一块才算
      const T = 16, TC = 28, diff = (a, b, i) => Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
      const ex = 0.3, x0 = Math.max(0, Math.floor((rect.x0 - (rect.x1 - rect.x0) * ex) * w)), x1 = Math.min(w, Math.ceil((rect.x1 + (rect.x1 - rect.x0) * ex) * w))
      const y0 = Math.max(0, Math.floor((rect.y0 - (rect.y1 - rect.y0) * ex) * h)), y1 = Math.min(h, Math.ceil((rect.y1 + (rect.y1 - rect.y0) * ex) * h))
      let mask = 0, cov = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4
        if (diff(d, kn, i) > T) { mask++; if (diff(d, fx, i) > TC) cov++ }
      }
      out['cover%'] = mask ? +(cov / mask * 100).toFixed(1) : null
      out.knightPx = mask
    }
    return out
  }, [png.toString('base64'), rect, noFx && noKnight ? [noFx.toString('base64'), noKnight.toString('base64')] : null])
}

const report = []
let failed = 0
console.log(`${'frame'.padEnd(20)} ${'scene'.padEnd(6)} ${'lum'.padStart(5)} ${'hi%'.padStart(6)} ${'lights'.padStart(6)} ${'gold%'.padStart(6)} ${'sat'.padStart(5)} ${'edges%'.padStart(7)} ${'rank'.padStart(5)} ${'ring'.padStart(5)} ${'cover%'.padStart(7)}`)
for (const [name, sec, action, scene] of PLAN) {
  await page.evaluate(([sec, action]) => {
    const m = window.__magicTower, r = m.rec
    if (action === 'enter') m.tower.enter()
    if (action === 'leave') m.tower.leave()
    r.skip(sec)
    r.frame(1 / 30)
  }, [sec, action])
  await page.waitForTimeout(150)
  await page.evaluate(() => window.__magicTower.rec.frame(0))
  const png = await page.screenshot()
  writeFileSync(join(OUT, `${name}.png`), png)
  const rect = await page.evaluate(() => window.__magicTower.tower.knightRect?.() ?? null)
  // 塔里的帧：同一时刻再画两张（藏特效、藏骑士），量「特效盖住主角」
  let noFx = null, noKnight = null
  if (rect && name.includes('tower')) {
    const shot = async (v) => { await page.evaluate((v) => { window.__magicTower.tower.setDebugView(v); window.__magicTower.rec.frame(0) }, v); await page.waitForTimeout(80); return page.screenshot() }
    noFx = await shot({ fx: false })
    noKnight = await shot({ knight: false })
    writeFileSync(join(OUT, `${name}-nofx.png`), noFx)          // 方便对着看：藏掉特效 / 藏掉骑士各是什么样
    writeFileSync(join(OUT, `${name}-noknight.png`), noKnight)
    await page.evaluate(() => { window.__magicTower.tower.setDebugView(null); window.__magicTower.rec.frame(0) })
  }
  const m = await measure(png, rect, noFx, noKnight)
  const budget = BUDGET[scene]
  const over = budget ? Object.keys(budget).filter((k) => m[k] > budget[k]) : []
  if (over.length) failed++
  report.push({ name, scene, ...m, over, rect })
  const cell = (k, width) => {
    const s = String(m[k]).padStart(width)
    return over.includes(k) ? `\x1b[31m${s}\x1b[0m` : s
  }
  console.log(`${name.padEnd(20)} ${scene.padEnd(6)} ${cell('lum', 5)} ${cell('hi%', 6)} ${cell('lights', 6)} ${cell('gold%', 6)} ${cell('sat', 5)} ${cell('edges%', 7)} ${m.rank === undefined ? '    -' : cell('rank', 5)} ${m.ring === undefined ? '    -' : cell('ring', 5)} ${m['cover%'] === undefined || m['cover%'] === null ? '      -' : cell('cover%', 7)}`)
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ size: `${W}x${H}`, budget: BUDGET, frames: report }, null, 2))
console.log(failed ? `\n✗ ${failed} 帧超出圣经 §6 的目标（红色）· 帧和 report.json 在 ${OUT}` : `\n✓ 都在预算内 · 帧和 report.json 在 ${OUT}`)
await browser.close()
process.exit(failed ? 1 : 0)
