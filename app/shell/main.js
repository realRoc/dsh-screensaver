// 屏保外壳：盖住整块屏幕，里面的画面交给主题（沙盒 iframe，地址在 ?theme=）。
// 主进程一直在等指纹（直接摸 Touch ID 就解开）；按任意键、点一下则请主进程弹系统验证框（Touch ID / 登录密码）。
// 通过了主进程会关掉所有屏保窗口。
// 主屏照着系统锁屏：底部一行「使用触控 ID 或输入密码」，右上角电池、Wi-Fi、菜单栏样式的日期时间；副屏只放主题画面。
// 纯享：30 秒没人动，这些连同主题里的会话播报都淡掉，只剩画面；动鼠标、按键、摸 Touch ID 再露出来。
const desk = window.desk // preload.cjs 给的
const q = new URLSearchParams(location.search)
const primary = q.get('primary') === '1'
const frame = document.getElementById('theme')
const hint = document.getElementById('hint')
const $ = (id) => document.getElementById(id)
const theme = q.get('theme')
// 主题也拿到语言（?lang=zh|en），自己决定日期之类怎么写
if (theme) frame.src = `${theme}?lang=${q.get('lang') === 'zh' ? 'zh' : 'en'}`
// 文案照抄系统锁屏
const T = {
  zh: {
    idle: '输入密码',
    idleTouch: '使用触控 ID 或输入密码',
    verifying: '请验证身份…',
    failed: (msg) => `没解开：${msg}`,
    noAuth: '这台电脑验证不了身份，点一下就开',
  },
  en: {
    idle: 'Enter Password',
    idleTouch: 'Touch ID or Enter Password',
    verifying: 'Verifying…',
    failed: (msg) => `Still locked: ${msg}`,
    noAuth: "This Mac can't verify identity. Click to open",
  },
}
const t = T[q.get('lang') === 'zh' ? 'zh' : 'en']
document.documentElement.lang = q.get('lang') === 'zh' ? 'zh-CN' : 'en'
let IDLE_HINT = ''
let busy = false
let hideTimer = 0
let hintTimer = 0
/** 底部那行字：平时是 IDLE_HINT，验证中、没解开时临时换一句，过一会儿换回来 */
function say(text, ms = 0) {
  if (!primary) return
  hint.textContent = text
  clearTimeout(hintTimer)
  if (ms) hintTimer = window.setTimeout(() => (hint.textContent = IDLE_HINT), ms)
}
// ---- 纯享：PURE_AFTER_MS 没人动就藏起提示、状态栏，告诉主题也藏起它的播报 ----
const PURE_AFTER_MS = 30_000
let pure = false
let pureTimer = 0
function setPure(on) {
  pure = on
  document.body.classList.toggle('pure', on)
  frame.contentWindow?.postMessage({ type: 'desk:pure', on }, '*')
}
/** 有人动了（或刚进屏保）：都露出来，重新数 30 秒 */
function reveal() {
  if (pure) setPure(false)
  clearTimeout(pureTimer)
  pureTimer = window.setTimeout(() => (busy ? reveal() : setPure(true)), PURE_AFTER_MS)
}
reveal()
/** 鼠标动了：露出指针和提示，指针一会儿再藏 */
function wake() {
  reveal()
  document.body.classList.add('awake')
  clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => !busy && document.body.classList.remove('awake'), 4000)
}
// 摸了 Touch ID（主进程转过来的）：同样露出来
desk.on('saver:touch', () => reveal())
async function unlock() {
  if (busy) return
  busy = true
  wake()
  say(t.verifying)
  try {
    const r = await desk.invoke('saver:unlock')
    if (!r.ok) say(r.msg ? t.failed(r.msg) : IDLE_HINT, r.msg ? 4000 : 0)
  } finally {
    busy = false
  }
}
addEventListener('keydown', (e) => {
  e.preventDefault()
  void unlock()
})
addEventListener('mousedown', (e) => {
  e.preventDefault()
  void unlock()
})
addEventListener('contextmenu', (e) => e.preventDefault())
// 鼠标晃一下只显示提示，不弹验证框（桌子被碰一下不至于弹窗）
let moved = 0
addEventListener('mousemove', (e) => {
  moved += Math.abs(e.movementX) + Math.abs(e.movementY)
  if (moved > 40) {
    moved = 0
    if (!busy) wake()
  }
})
// 本机 Claude Code / Codex 会话：主进程只给声明了要的主题推（saver.json 的 "sessions": true），这里转给主题。
// 主题是沙盒 iframe（没有同源），只能 postMessage；主题开好后会发 desk:ready 来要一份。
// 一起带上：是不是主屏（副屏主题只放画面）、是不是在用电池（主题降帧率、降分辨率）。
let latest = null
function forward() {
  if (latest && frame.contentWindow) frame.contentWindow.postMessage({ type: 'desk:sessions', primary, ...latest }, '*')
}
desk.on('saver:sessions', (p) => {
  latest = p
  forward()
})
frame.addEventListener('load', forward)
addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || e.data?.type !== 'desk:ready') return
  forward()
  if (pure) setPure(true) // 主题开得晚：补一句
})
void desk.invoke('saver:info').then((info) => {
  if (!info || !primary) return
  IDLE_HINT = !info.canAuth ? t.noAuth : info.touch ? t.idleTouch : t.idle
  if (!busy) say(IDLE_HINT)
})
const svgEl = (sel) => document.querySelector(sel)
desk.on('saver:status', (st) => {
  const b = st.battery
  $('batt').hidden = !b
  if (b) {
    const pct = Math.max(0, Math.min(100, b.percent))
    $('pct').textContent = `${pct}%`
    const fill = svgEl('#battFill')
    fill.setAttribute('width', String(Math.max(pct > 0 ? 1.5 : 0, (20 * pct) / 100)))
    // 跟系统一样：电量低（20% 及以下）且没插电是红的，插着电不变色、中间一道闪电
    fill.style.fill = pct <= 20 && !b.plugged ? '#ff453a' : ''
    svgEl('#bolt').toggleAttribute('hidden', !b.plugged)
    if (b.plugged) svgEl('#battBody').setAttribute('mask', 'url(#boltCut)')
    else svgEl('#battBody').removeAttribute('mask')
  }
  const w = st.wifi
  svgEl('#wifi').toggleAttribute('hidden', !w) // svg 上没有 .hidden，得设属性
  if (w) {
    // 信号格数：-60 dBm 以上 3 格，-70 以上 2 格，再弱 1 格；没连上 / 关了全灰，关了再加一道斜杠
    const bars = !w.on || !w.connected ? 0 : w.rssi >= -60 ? 3 : w.rssi >= -70 ? 2 : 1
    for (const n of [1, 2, 3]) svgEl(`#wifi .bar${n}`).style.opacity = n <= bars ? '1' : '0.3'
    svgEl('#wifiSlash').toggleAttribute('hidden', w.on)
  }
})
// ---- 右上角日期时间：照着菜单栏，「11月15日 周日 下午6:10」/「Sun Nov 15  6:10 PM」 ----
const zh = q.get('lang') === 'zh'
function tick() {
  const d = new Date()
  const h = d.getHours()
  const h12 = h % 12 || 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  $('clockD').textContent = zh
    ? `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')
  $('clockT').textContent = zh ? `${h < 12 ? '上午' : '下午'}${h12}:${mm}` : `${h12}:${mm} ${h < 12 ? 'AM' : 'PM'}`
}
if (primary) {
  $('status').hidden = false
  tick()
  // 对准整分钟换
  window.setTimeout(
    () => {
      tick()
      window.setInterval(tick, 60_000)
    },
    60_000 - (Date.now() % 60_000) + 50,
  )
}
