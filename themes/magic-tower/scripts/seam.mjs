// 接缝检测：塔是「无尽」的——静态几何按一圈（SPT 级台阶）周期排布，镜头每爬一圈，整座塔往上挪一圈。
// 挪的那一下就是接缝：塔真是周期的，挪了看不出来；哪里不周期（贴图没对齐整圈、某样东西只摆了一份、
// 塔底露出来了），那一帧就会「跳」一下。这个脚本用数字说跳没跳，不靠眼睛。
//
// 两种检查（做法学自 akella 的 codevember-2026/17-kelp 的 tools/seam.mjs）：
//
//   一、相邻帧：跨接缝的两帧（相隔一帧、中间正好挪了塔）跟一圈里别处的相邻两帧比，差得一样多才算没跳。
//       另外画「同一帧两遍」（应该是 0，说明画面是确定的）和「故意做坏的接缝」（塔多挪 0.4%，应该被抓出来），
//       证明这把尺子本身是准的。
//   二、换一圈塔：同一个镜头、同一个时刻，塔往下（或往上）多挪一整圈再画。镜头没动，什么都没动，
//       只换了你看到的是第几圈 —— 塔是周期的就该一个像素都不差。不差的地方是黑的，差的地方标出来。
//
//   node scripts/seam.mjs                    1280×800，结果在 scripts/out/seam/（PNG + report.json）
//   node scripts/seam.mjs --size 1080x1440   竖屏
//
// 先 npm run build（测的是打包好的 index.html）；要本机装了 Google Chrome。退出码：都过 0，有一项没过 1。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const THEME = join(HERE, '..')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const [W, H] = arg('size', '1280x800').split('x').map(Number)
const OUT = arg('out', join(HERE, 'out', 'seam'))
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(pathToFileURL(join(THEME, 'index.html')).href + '#demo,nopure')
await page.waitForFunction(() => window.__magicTower?.tower, null, { timeout: 30_000 })
await page.waitForTimeout(3000)                       // 贴图、模型是异步加载的

// 进塔、藏起界面；之后由 pose() 摆每一帧（动画循环停掉，时间不再自己走）
const loop = await page.evaluate(() => {
  const m = window.__magicTower
  m.setPure(true)
  document.getElementById('dev').hidden = true
  m.tower.setQuality(1, 60)
  m.tower.enter()
  m.step(6)
  return { mode: m.tower.mode, ...m.tower.loop }
})
if (loop.mode !== 'run') throw new Error(`没进到塔里（mode = ${loop.mode}）`)

// 页面里的小工具：画一帧存成像素、两帧比差多少、拼对比图
await page.evaluate(() => {
  const frames = {}
  const grab = (name, s, t, shift = 0) => {
    const m = window.__magicTower
    m.tower.pose(s, t, shift)                           // 画两遍、取第二遍：上一帧留下的东西（脚下辉光、拖尾）先换成这一帧的
    m.tower.pose(s, t, shift)
    const src = m.tower.canvas
    const c = new OffscreenCanvas(src.width, src.height), g = c.getContext('2d')
    g.drawImage(src, 0, 0)                              // 跟 pose() 同一个任务里读，画布还没被清掉
    frames[name] = g.getImageData(0, 0, c.width, c.height)
  }
  // 每个像素取 RGB 三个通道里差得最多的那个（0..255）
  const diff = (a, b) => {
    const A = frames[a].data, B = frames[b].data, n = A.length / 4, d = new Uint8Array(n)
    let sum = 0, jumps = 0
    const hist = new Uint32Array(256)
    for (let i = 0; i < n; i++) {
      const j = i * 4
      const v = Math.max(Math.abs(A[j] - B[j]), Math.abs(A[j + 1] - B[j + 1]), Math.abs(A[j + 2] - B[j + 2]))
      d[i] = v; sum += v; hist[v]++
      if (v > 24) jumps++
    }
    let acc = 0, p999 = 0
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.999) { p999 = v; break } }
    let worst = 255; while (worst > 0 && !hist[worst]) worst--
    return { d, mean: sum / n, p999, worst, jumps: jumps / n }
  }
  // 差的地方：放大 8 倍、按热度上色（黑 → 品红 → 黄 → 白），叠在压暗的原图上
  const heat = (base, d, w, h) => {
    const img = new ImageData(w, h), o = img.data, B = base.data
    for (let i = 0; i < d.length; i++) {
      const v = Math.min(1, d[i] * 8 / 255), j = i * 4, dim = 0.18
      o[j] = B[j] * dim * (1 - v) + 255 * Math.min(1, v * 2)
      o[j + 1] = B[j + 1] * dim * (1 - v) + 255 * Math.max(0, v * 2 - 1)
      o[j + 2] = B[j + 2] * dim * (1 - v) + 255 * (v < 0.5 ? v * 1.6 : Math.max(0, v * 2 - 1))
      o[j + 3] = 255
    }
    return img
  }
  // 拼图：[A | B | 差 ×8]，下面一行字
  const sheet = async (a, b, title) => {
    const A = frames[a], B = frames[b], w = A.width, h = A.height, r = diff(a, b)
    const c = new OffscreenCanvas(w * 3, h + 64), g = c.getContext('2d')
    g.fillStyle = '#0b0f17'; g.fillRect(0, 0, c.width, c.height)
    g.putImageData(A, 0, 0); g.putImageData(B, w, 0); g.putImageData(heat(A, r.d, w, h), w * 2, 0)
    g.fillStyle = '#e8e2d0'; g.font = '26px -apple-system, "PingFang SC", sans-serif'
    g.fillText(title, 20, h + 42)
    g.fillStyle = '#9aa4b2'; g.font = '22px -apple-system, "PingFang SC", sans-serif'
    g.fillText(`平均差 ${r.mean.toFixed(3)} / 255 · 99.9% 像素差 ≤ ${r.p999} · 跳变像素 ${(r.jumps * 100).toFixed(2)}%`, w * 2 + 20, h + 42)
    const blob = await c.convertToBlob({ type: 'image/png' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  }
  window.__seam = { grab, sheet, stats: (a, b) => { const { d, ...r } = diff(a, b); return r }, drop: () => { for (const k in frames) delete frames[k] } }
})

const { SPT, back, SPEED } = loop
const FPS = 60, step = SPEED / FPS                     // 屏保主屏 60 帧：相邻两帧骑士走 step 级台阶
const seamAt = (k) => k * SPT + back                   // 骑士在这一级时塔正好挪一圈
const T0 = 20                                          // 时钟：跟着台阶一起走（相邻帧时间也差 1/60 秒），从 20 秒起
const tAt = (s) => T0 + (s - seamAt(2)) / SPEED
const grab = (name, s, shift = 0, t = tAt(s)) => page.evaluate(([n, s, t, sh]) => window.__seam.grab(n, s, t, sh), [name, s, t, shift])
const stats = (a, b) => page.evaluate(([a, b]) => window.__seam.stats(a, b), [a, b])
const save = async (a, b, title, file) => {
  const b64 = await page.evaluate(([a, b, t]) => window.__seam.sheet(a, b, t), [a, b, title])
  writeFileSync(join(OUT, file), Buffer.from(b64, 'base64'))
  return file
}
const fmt = (r) => `平均 ${r.mean.toFixed(3).padStart(6)}  99.9% ≤ ${String(r.p999).padStart(3)}  最大 ${String(r.worst).padStart(3)}  跳变 ${(r.jumps * 100).toFixed(2).padStart(5)}%`
const report = { size: `${W}x${H}`, loop, fps: FPS, pairs: [], swaps: [], checks: [] }
let failed = 0
const check = (ok, what) => { report.checks.push({ ok, what }); if (!ok) failed++; console.log(`${ok ? '  ✓' : '  ✗'} ${what}`) }

// ---------------------------------------------------------------- 一、相邻帧
console.log(`\n一、相邻两帧（相隔 1/${FPS} 秒，骑士走 ${step.toFixed(4)} 级），塔每 ${SPT} 级挪一圈\n`)
const S = seamAt(2)
const PAIRS = [
  ['跨接缝（塔挪了一圈）', S - step / 2, S + step / 2, 0, 'seam-pair.png'],
  ['一圈的 1/4 处', S + SPT / 4 - step / 2, S + SPT / 4 + step / 2, 0, null, true],
  ['一圈的一半', S + SPT / 2 - step / 2, S + SPT / 2 + step / 2, 0, null, true],
  ['一圈的 3/4 处', S + SPT * 3 / 4 - step / 2, S + SPT * 3 / 4 + step / 2, 0, null, true],
  ['下一圈的接缝', S + SPT - step / 2, S + SPT + step / 2],
  ['同一帧画两遍', S + 5.3, S + 5.3, 0, 'same-frame.png'],
  ['故意做坏：接缝处塔多挪 0.4%', S - step / 2, S + step / 2, 0.004, 'seam-broken.png'],
]
for (const [name, a, b, bug = 0, file = null, elsewhere = false] of PAIRS) {
  await grab('a', a); await grab('b', b, bug)
  const r = await stats('a', 'b')
  report.pairs.push({ name, a, b, bug, elsewhere, ...r, file })
  if (file) await save('a', 'b', `${name}：第 ${a.toFixed(3)} 级 → 第 ${b.toFixed(3)} 级`, file)
  console.log(`${name.padEnd(18, '　')} ${fmt(r)}${file ? `   → ${file}` : ''}`)
}
const P = Object.fromEntries(report.pairs.map((p) => [p.name, p]))
const normal = report.pairs.filter((p) => p.elsewhere)
const most = (k) => Math.max(...normal.map((p) => p[k]))
const ok = (p) => p.mean <= most('mean') * 1.5 + 0.05 && p.jumps <= most('jumps') * 1.5 + 0.001
console.log('')
const floor = P['同一帧画两遍']
// 天井里有几颗光点每次画出来亮度差一点（GPU 上叠加混合），算作噪声底：后面「换一圈塔」的差别跟它比
check(floor.jumps < 0.0002 && floor.p999 <= 4, `画面基本是确定的：同一帧画两遍，99.9% 的像素差 ≤ ${floor.p999}（这是噪声底）`)
check(ok(P['跨接缝（塔挪了一圈）']), '跨接缝那两帧跟别处的相邻两帧差得一样多（不超过别处最多的 1.5 倍）')
check(ok(P['下一圈的接缝']), '下一圈的接缝也一样')
check(!ok(P['故意做坏：接缝处塔多挪 0.4%']), '尺子是准的：故意做坏的接缝被抓出来了')

// ---------------------------------------------------------------- 二、换一圈塔
console.log(`\n二、同一帧，只把塔多挪一圈（镜头、时间、一切都不动）\n`)
for (const [name, s, shift] of [
  ['接缝刚过，换成上一圈（就是接缝前那一刻的塔）', S + step / 2, -1],
  ['一圈的一半，塔往下一圈', S + SPT / 2, -1],
  ['一圈的一半，塔往上一圈', S + SPT / 2, 1],
]) {
  await grab('a', s, 0); await grab('b', s, shift)
  const r = await stats('a', 'b')
  const file = `swap-${report.swaps.length + 1}.png`
  await save('a', 'b', `${name}（第 ${s.toFixed(2)} 级，塔 ${shift > 0 ? '+' : ''}${shift} 圈）`, file)
  report.swaps.push({ name, s, shift, ...r, file })
  console.log(`${name.padEnd(24, '　')} ${fmt(r)}   → ${file}`)
}
console.log('')
const sw = report.swaps
const quiet = (r) => r.p999 <= floor.p999 + 4 && r.jumps <= floor.jumps + 0.0003
check(quiet(sw[0]), '接缝前后的两圈塔看不出差别（不超过噪声底：99.9% 像素差多 4 以内、跳变像素多 0.03% 以内）')
check(sw.every(quiet), '塔是周期的：往上、往下换一圈都看不出差别')

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\n${failed ? `✗ ${failed} 项没过` : '✓ 都过了'} · 图和 report.json 在 ${OUT}`)
await browser.close()
process.exit(failed ? 1 : 0)
