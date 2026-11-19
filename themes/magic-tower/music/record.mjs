// 把《星井》+ 特效 + 镜头录成视频：本机 Chrome（无头）打开 index.html#demo,bgm,record，
// 一帧一帧推（不靠真实时间，所以画面和音乐严丝合缝、机器慢也不掉帧），每帧截画布交给 ffmpeg，最后把整曲音轨合进去。
//
//   node music/record.mjs                         竖屏 3:4（1080×1440，小红书）92 秒，出 music/out/star-well-3x4.mp4
//   node music/record.mjs --size 1920x1080 --out music/out/star-well-16x9.mp4
//   node music/record.mjs --still 10,30,45,58,70  只截这几秒的画面（PNG，放在 music/out/stills/），调机位用
//   node music/record.mjs --from 36 --to 50       只录一段（看某个段落），音轨也截同一段
//
// 先 npm run build（录的是打包好的 index.html）；要本机装了 Google Chrome 和 ffmpeg。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const THEME = join(HERE, '..')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const [W, H] = arg('size', '1080x1440').split('x').map(Number)
const FPS = Number(arg('fps', 30))
const FROM = Number(arg('from', 0)), TO = Number(arg('to', 92))
const OUT = arg('out', join(HERE, 'out', `star-well-${W > H ? '16x9' : '3x4'}.mp4`))
const AUDIO = arg('audio', join(HERE, 'out', 'star-well-full.m4a'))
const STILLS = arg('still', null)?.split(',').map(Number).sort((a, b) => a - b)

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(pathToFileURL(join(THEME, 'index.html')).href + '#demo,bgm,record')
await page.waitForFunction(() => window.__magicTower?.rec, null, { timeout: 30_000 })
await page.waitForTimeout(3000)                     // 贴图、模型是异步加载的
const gl = await page.evaluate(() => {
  const c = window.__magicTower.rec.canvas, g = c.getContext('webgl2')
  const d = g?.getExtension('WEBGL_debug_renderer_info')
  return { w: c.width, h: c.height, gpu: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?' }
})
console.log(`canvas ${gl.w}×${gl.h} · ${gl.gpu}`)

const grab = (type, q) => page.evaluate(({ dt, type, q }) => {
  const info = window.__magicTower.rec.frame(dt)
  return { info, url: window.__magicTower.rec.canvas.toDataURL(type, q) }
}, { dt: 1 / FPS, type, q })
const b64 = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')

let t = 0
const skipTo = async (target) => {
  const n = Math.round((target - t) * FPS) - 1
  if (n > 0) { await page.evaluate(({ n, fps }) => window.__magicTower.rec.skip(n / fps, fps), { n, fps: FPS }); t += n / FPS }
}

if (STILLS) {
  const dir = join(HERE, 'out', 'stills')
  mkdirSync(dir, { recursive: true })
  for (const s of STILLS) {
    await skipTo(s)
    const { info, url } = await grab('image/png')
    t += 1 / FPS
    const file = join(dir, `t${s.toFixed(1).padStart(5, '0')}.png`)
    writeFileSync(file, b64(url))
    console.log(`${s}s  ${info.mode} ${info.section ?? ''}  → ${file}`)
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  await skipTo(FROM)
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-ss', String(FROM), '-t', String(TO - FROM), '-i', AUDIO,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise((res, rej) => ff.on('close', (c) => (c ? rej(new Error(`ffmpeg ${c}`)) : res())))
  const n = Math.round((TO - FROM) * FPS), t0 = Date.now()
  for (let i = 0; i < n; i++) {
    const { info, url } = await grab('image/jpeg', 0.95)
    if (!ff.stdin.write(b64(url))) await new Promise((r) => ff.stdin.once('drain', r))
    if (i % (FPS * 5) === 0) console.log(`${info.t.toFixed(1)}s  ${info.mode} ${info.section ?? ''}  (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`)
  }
  ff.stdin.end()
  await done
  console.log(`→ ${OUT}`)
}
await browser.close()
