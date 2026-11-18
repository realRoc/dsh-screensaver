// Record a theme's README GIF from its #demo page: idle → running (enter) or running → idle (exit).
//
//   npm i -D playwright-core          # once; uses your installed Google Chrome (GPU), no browser download
//   brew install ffmpeg gifsicle      # once
//   python3 -m http.server 5190       # from the repo root, in another terminal
//   node skills/dsh-screensaver-theme/scripts/record-gif.mjs \
//     --url http://localhost:5190/themes/<id>/index.html --api __myTheme --idle idle --run run \
//     --dir enter --lang zh --out docs/images/<id>-enter.gif
//
// enter: 3 s idle → add three sessions → transition → 5 s after the running scene starts.
// exit:  three sessions running → finish all → 3 s grace (the demo's GRACE) → transition → 5 s idle.
// The theme's demo must follow the contract in SKILL.md: window[api].state, and #dev buttons data-a="claude" / "codex" /
// "dsh" / "done" / "all" (clicking one stops the scripted demo). Frames come from a real-time screencast and are
// resampled by timestamp, so the GIF plays at real speed. Default 480 px, 10 fps, lossy: about 4-6 MB for 12-17 s.
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: o } = parseArgs({
  options: {
    url: { type: 'string' }, api: { type: 'string' }, idle: { type: 'string', default: 'idle' }, run: { type: 'string', default: 'run' },
    dir: { type: 'string', default: 'enter' }, lang: { type: 'string', default: 'zh' }, out: { type: 'string' },
    fps: { type: 'string', default: '10' }, width: { type: 'string', default: '480' }, hash: { type: 'string', default: '#demo,nopure' },
  },
})
if (!o.url || !o.api || !o.out) throw new Error('need --url, --api and --out')
const FPS = Number(o.fps), VW = 1280, VH = 800

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('[page]', e.message))
await page.goto(`${o.url}?lang=${o.lang}${o.hash}`)
await page.waitForFunction((api) => !!window[api], o.api)
const state = () => page.evaluate((api) => window[api].state, o.api)
const click = (...as) => page.evaluate((as) => { for (const a of as) document.querySelector(`#dev button[data-a="${a}"]`).click() }, as)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitState(s, maxMs = 30000) {
  const t0 = Date.now()
  while ((await state()) !== s) { if (Date.now() - t0 > maxMs) throw new Error(`timed out waiting for state ${s}`); await wait(50) }
}

const cdp = await page.context().newCDPSession(page)
const frames = []
let recording = false
cdp.on('Page.screencastFrame', async (f) => {
  if (recording) frames.push({ t: f.metadata.timestamp, data: f.data })
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})
async function startRec() {
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: VW, maxHeight: VH, everyNthFrame: 1 })
  await wait(300)
  frames.length = 0
  recording = true
}

if (o.dir === 'enter') {
  await wait(1200) // let the first frames settle; the scripted demo adds its first session later
  await startRec()
  await wait(3000) // 3 s idle
  await click('claude', 'codex', 'dsh')
  await waitState(o.run)
  await wait(5000) // 5 s running
} else {
  await wait(800)
  await click('claude', 'codex', 'dsh')
  await waitState(o.run)
  await wait(6000)
  await click('done') // one finished, two still running
  await wait(2500)
  await startRec()
  await click('all') // all finished: the grace period is the "3 s running" part
  await waitState(o.idle)
  await wait(5000) // 5 s idle
}
recording = false
await cdp.send('Page.stopScreencast')
await browser.close()

const tmp = `${o.out}.frames`
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
const start = frames[0].t, dur = frames.at(-1).t - start
let j = 0, n = 0
for (let t = 0; t <= dur; t += 1 / FPS) {
  while (j + 1 < frames.length && frames[j + 1].t - start <= t) j++
  writeFileSync(`${tmp}/${String(n++).padStart(5, '0')}.jpg`, Buffer.from(frames[j].data, 'base64'))
}
console.log(`${frames.length} frames captured (${(frames.length / dur).toFixed(0)} fps), ${dur.toFixed(1)} s → ${n} frames at ${FPS} fps`)
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${tmp}/%05d.jpg`, '-vf',
  `scale=${o.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  `${o.out}.raw.gif`])
execFileSync('gifsicle', ['-O3', '--lossy=100', `${o.out}.raw.gif`, '-o', o.out])
rmSync(`${o.out}.raw.gif`)
rmSync(tmp, { recursive: true, force: true })
console.log('wrote', o.out)
