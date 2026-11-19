// 魔法书斋：没有会话在跑时，塔顶书房里骑士在月光下读书；有 Claude Code / Codex / DeepSeek Harness 会话开始跑，
// 镜头扎进书页、穿过符文漩涡进塔，骑士沿书阶上行；全部结束（宽限 GRACE 秒），一本书飞到镜头前打开，回到书房。
//
//   书房(idle) ──有会话在跑──▶ 进塔(enter, 4.2s) ──▶ 登塔(run, 不限时) ──全部结束──▶ 回书房(leave, 4s) ──▶ 书房
//
// 开屏保时已经有会话在跑：先在书房停 OPEN_HOLD 秒，让人看清画面再扎进书里（亚空间进场 8.5 秒够长，不用停）；
// 之后从塔里回到书房、又有会话开始，停 IDLE_HOLD 秒就走。
// 跟亚空间主题同一套逻辑：左侧列这一轮登塔里的会话，结束的留着；回到书房 18 秒后法卷收起。
// 屏保外壳是新版（saver.json 写了 "hud": true）时，右上角状态栏、底部提示、触控 ID 反馈也由主题画，位置跟外壳一样。
import { banner, demoSeal, renderLedger, setHint, setStatus, showHud, touched, TX, ZH } from './hud.js'
import { magicTower as tower } from './scene.js'
import { DEMO_SCORE } from './score.js'

const $ = (id) => document.getElementById(id)
const DEMO = location.hash.includes('demo')
const GRACE = DEMO ? 3 : 15
const OPEN_HOLD = 3, IDLE_HOLD = 1.5
const isLive = (s) => s.status === 'running' || s.status === 'waiting'
const ST = TX.st

// ============================================================ 会话
// { type: 'desk:sessions', primary, lowPower, sessions: [{ id, kind: 'claude'|'codex'|'dsh', name, status, progress, startedAt, endedAt? }] }
let sessions = []
function valid(s) {
  return s && typeof s.id === 'string' && (s.kind === 'claude' || s.kind === 'codex' || s.kind === 'dsh') && s.status in ST && typeof s.startedAt === 'number'
}
function setSessions(list) {
  sessions = list.filter(valid).map((s) => ({ ...s, name: String(s.name ?? ''), progress: String(s.progress ?? '') }))
}
// 副屏：只放画面，最多 30 帧、分辨率降一点；用电池：30 帧
let primary = true, lowPower = false
function setRender(p, low) {
  if (p === primary && low === lowPower) return
  primary = p
  lowPower = low
  document.body.classList.toggle('secondary', !p)
  tower.setQuality(!p ? 0.75 : low ? 1 : Math.min(devicePixelRatio, 1.25), p && !low ? 60 : 30)
}

addEventListener('message', (e) => {
  if (e.source !== parent || !e.data) return
  const d = e.data
  switch (d.type) {
    // 纯享：外壳 30 秒没人动就发 { on: true }，藏起法卷、横幅、状态栏、提示，只剩画面
    case 'desk:pure': return void document.body.classList.toggle('pure', d.on === true)
    case 'desk:sessions':
      if (!Array.isArray(d.sessions)) return
      setRender(d.primary !== false, d.lowPower === true)
      return void setSessions(d.sessions)
    // 下面三个只有新版外壳、而且主题声明了 "hud": true 才会发；收到提示说明外壳把状态栏和提示让给了主题
    case 'desk:hint': showHud(true); return void setHint(d)
    case 'desk:status': return void setStatus(d)
    case 'desk:touch': return void touched(d.result)
  }
})
if (parent !== window) parent.postMessage({ type: 'desk:ready' }, '*')

// ============================================================ 书房 ⇄ 塔
let prevMode = tower.mode, idleT = 0, hudAcc = 1
let climbWall = 0, climbStart = 0, climbEnd = 0, now = 0 // 本次登塔开始的钟点、时长（秒）
tower.onFrame((dt) => {
  now += dt
  demoTick(dt)
  const running = sessions.some(isLive)
  const mode = tower.mode
  if (mode === 'idle' && running && tower.modeT > (climbStart ? IDLE_HOLD : OPEN_HOLD)) tower.enter()
  else if (mode === 'run') {
    idleT = running ? 0 : idleT + dt
    if (idleT > GRACE && tower.modeT > 3) tower.leave()
  }
  if (tower.mode !== prevMode) {
    const m = tower.mode
    if (m === 'enter' && prevMode === 'idle') {
      climbWall = Date.now()
      climbStart = now
      banner(TX.bEnter)
    }
    if (m === 'leave') banner(TX.bLeave)
    if (m === 'idle') climbEnd = now
    if (m === 'run') idleT = 0
    prevMode = m
  }
  if ((hudAcc += dt) < 0.25) return
  hudAcc = 0
  const shown = sessions.filter((s) => isLive(s) || (s.endedAt ?? 0) >= climbWall)
  renderLedger(shown, {
    mode: tower.mode,
    running,
    on: shown.length > 0 && !(tower.mode === 'idle' && tower.modeT > 18),
    climbMs: climbStart ? ((tower.mode === 'idle' ? climbEnd : now) - climbStart) * 1000 : 0,
  })
  if (DEMO) $('devState').textContent = tower.mode
})

// ============================================================ 演示（地址带 #demo 才有：在浏览器里单独看主题用，屏保里不会出现）
let demoTick = () => {}
if (DEMO) {
  const pick = (arr) => arr[(Math.random() * arr.length) | 0]
  const dev = $('dev')
  // 浏览器里没有外壳：自己当外壳，给提示、电池、Wi-Fi
  showHud(true)
  demoSeal()
  setHint({ text: ZH ? '使用触控 ID 或输入密码' : 'Touch ID or Enter Password', state: 'idle' })
  setStatus({ battery: { percent: 82, plugged: false }, wifi: { on: true, connected: true, rssi: -52 } })
  const PROG = {
    claude: ZH ? ['读取 saver.ts', '搜索 "sessionStatus"', '编辑 main.ts', '写入 README.md', 'Bash npm test', 'subagent：查 Codex 日志格式', '思考中…'] : ['Read saver.ts', 'Search "sessionStatus"', 'Edit main.ts', 'Write README.md', 'Bash npm test', 'Subagent: check Codex log format', 'Thinking…'],
    codex: ['exec rg -n "saver" src', 'apply_patch', 'exec npm run build', 'exec gh pr view 10', ZH ? '推理中…' : 'Reasoning…', 'exec npx vitest run'],
    dsh: ['bash npm test', 'read_file agents.js', 'edit_file saver.js', ZH ? '思考中…' : 'Thinking…', 'web_search zstd frame format'],
  }
  const demo = []
  let seq = 0
  const add = (kind, name) => demo.push({ id: `demo:${++seq}`, kind, name, status: 'running', progress: PROG[kind][0], startedAt: Date.now() })
  const finish = (s, status) => { if (s && isLive(s)) Object.assign(s, { status, endedAt: Date.now(), progress: status === 'done' ? (ZH ? '本轮完成' : 'Turn finished') : ZH ? '被中断' : 'Stopped' }) }
  const D = ZH
    ? { a: '魔法塔屏保主题', b: 'api · PR #10 review', c: '给 dsh 插件补测试', d: '骑士精灵 Blender 管线', wait: '等你确认：Bash git push', wait2: '等你确认：编辑 .env' }
    : { a: 'Magic Tower screen saver theme', b: 'api · PR #10 review', c: 'Add tests to the dsh plugin', d: 'Knight sprite Blender pipeline', wait: 'Needs approval: Bash git push', wait2: 'Needs approval: Edit .env' }
  const SCRIPT = [
    [5, () => { add('claude', D.a); add('codex', D.b) }],
    [11, () => add('dsh', D.c)],
    [16, () => add('claude', D.d)],
    [30, () => { const s = demo.find((x) => x.kind === 'codex' && x.status === 'running'); if (s) Object.assign(s, { status: 'waiting', progress: D.wait }) }],
    [37, () => { const s = demo.find((x) => x.status === 'waiting'); if (s) Object.assign(s, { status: 'running', progress: 'exec git push' }) }],
    [46, () => finish(demo.find((x) => x.kind === 'codex'), 'done')],
    [54, () => finish(demo.find((x) => x.name === D.d), 'aborted')],
    [64, () => demo.filter(isLive).forEach((s) => finish(s, 'done'))],
  ]
  // #demo,fxgallery：进塔后每种乐器特效轮流放一遍，屏幕上写着名字；#demo,groove：按演示乐谱（src/score.js 的 DEMO_SCORE）打特效。
  // 这两种都一直待在塔里（会话不结束），方便看、方便录。
  const FX_SHOW = location.hash.includes('fxgallery') ? 'gallery' : location.hash.includes('groove') ? 'groove' : null
  if (FX_SHOW) SCRIPT.length = 1
  const FX_ZH = { beam: '天光坠落 · 底鼓', sigil: '法阵 · 军鼓', glitter: '星芒 · 镲', ripple: '地脉 · 贝斯', aurora: '极光 · 铺底/弦乐', comet: '流星 · 主旋律', chime: '灯链 · 琶音/钟琴', swell: '星辉脉冲 · 重音', slash: '光之巨剑 · 段落重拍', shower: '彗星齐射 · 过门' }
  const fxLabel = FX_SHOW && Object.assign(document.body.appendChild(document.createElement('div')), { id: 'fxLabel' })
  let fxStarted = false
  let demoT = 0, idx = 0, auto = true, progT = 0
  demoTick = (dt) => {
    if (FX_SHOW && !fxStarted && tower.mode === 'run') {
      fxStarted = true
      if (FX_SHOW === 'gallery') tower.fx.gallery((name) => { fxLabel.textContent = ZH ? FX_ZH[name] : name })
      else { tower.fx.play(DEMO_SCORE, 0.5); fxLabel.textContent = ZH ? '演示节奏 112 BPM' : 'Demo groove · 112 BPM' }
    }
    if (auto) {
      demoT += dt
      while (idx < SCRIPT.length && demoT >= SCRIPT[idx][0]) SCRIPT[idx++][1]()
      if (idx >= SCRIPT.length && tower.mode === 'idle' && tower.modeT > 20) { demoT = 0; idx = 0; demo.length = 0 }
    }
    if ((progT += dt) > 3) {
      progT = 0
      for (const s of demo) if (s.status === 'running') s.progress = pick(PROG[s.kind])
    }
    setSessions(demo)
  }
  const NAMES = ZH
    ? { claude: ['重构 IM 限流', '写屏保单测', '修书房月光'], codex: ['迁移 vite 6', 'review PR #11', '补 README'], dsh: ['整理 changelog', '修 CI', '写插件文档'] }
    : { claude: ['Refactor rate limiter', 'Write screen saver tests', 'Fix study moonlight'], codex: ['Migrate to Vite 6', 'review PR #11', 'Update README'], dsh: ['Tidy the changelog', 'Fix CI', 'Write plugin docs'] }
  dev.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a
    if (!a) return
    const live = demo.filter(isLive)
    if (a === 'pure') return void setPure(!document.body.classList.contains('pure'))
    if (a.startsWith('touch:')) return void touchedDemo(a.slice(6))
    auto = false
    if (a === 'claude' || a === 'codex' || a === 'dsh') add(a, pick(NAMES[a]))
    if (a === 'done') finish(live[0], 'done')
    if (a === 'abort') finish(live[0], 'aborted')
    if (a === 'wait' && live[0]) Object.assign(live[0], { status: 'waiting', progress: D.wait2 })
    if (a === 'all') live.forEach((s) => finish(s, 'done'))
  })
  addEventListener('keydown', (e) => { if (e.key === 'd' || e.key === 'D') dev.hidden = !dev.hidden })

  // 浏览器里没有外壳：照外壳的规矩自己算纯享，30 秒没人动就藏起界面，动鼠标、按键、摸指纹再露出来。
  // #demo,nopure 关掉（录演示动图时用）
  const PURE_AFTER_MS = 30_000
  let pureTimer = 0
  const setPure = (on) => document.body.classList.toggle('pure', on)
  const reveal = () => {
    setPure(false)
    clearTimeout(pureTimer)
    if (!location.hash.includes('nopure')) pureTimer = setTimeout(() => setPure(true), PURE_AFTER_MS)
  }
  let moved = 0
  addEventListener('mousemove', (e) => { if ((moved += Math.abs(e.movementX) + Math.abs(e.movementY)) > 40) { moved = 0; reveal() } })
  addEventListener('keydown', reveal)
  addEventListener('pointerdown', reveal)
  reveal()
  const touchedDemo = (r) => { reveal(); touched(r) }
  window.__magicTower = {
    tower, demo, add, finish, touched: touchedDemo, setHint, setStatus, setPure, sessions: () => sessions,
    get state() { return tower.mode },
    /** 不靠 requestAnimationFrame 往前推 sec 秒（页面在后台时用来截图检查），跟 __subspace.step 一样 */
    step: (sec, fps = 30) => tower.simulate(sec, fps),
  }
}

tower.start()
