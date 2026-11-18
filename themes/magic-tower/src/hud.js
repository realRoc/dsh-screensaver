// 魔法塔的界面层：左侧星辉法卷（会话）、右上角星象（电池、Wi-Fi、月相、日期时间）、中间下方的触控 ID 法阵和提示。
// 位置和逻辑跟屏保外壳 / 亚空间主题一致：会话在左侧中间，状态栏在右上角，提示在底部正中离底边 7%，指纹在提示上面。
// 只管画；什么时候显示、显示什么由 main.js 决定。

export const ZH = new URLSearchParams(location.search).get('lang') !== 'en'
document.documentElement.lang = ZH ? 'zh-CN' : 'en'
const $ = (id) => document.getElementById(id)
const SVG = 'http://www.w3.org/2000/svg'

// 文案走书斋的口吻（古典、点到为止），但意思跟外壳和别的主题一一对应：
//   运行中 → 术式流转，等你确认 → 静候谕令，已完成 → 秘卷既成，已中断 → 术式中断
const CN = '零一二三四五六七八九'
const cnNum = (n) => (n === 2 ? '双' : n < 10 ? CN[n] : n < 20 ? `十${n % 10 ? CN[n % 10] : ''}` : n < 100 ? `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ''}` : String(n))
const EN_NUM = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']
export const TX = ZH
  ? {
      ledger: '此夜纪事',
      st: { running: '术式流转', waiting: '静候谕令', done: '秘卷既成', aborted: '术式中断' },
      tIdle: '诸卷沉寂', tEnter: '循星而往', tRun: '群星未眠', tLeave: '归返书斋',
      nRun: (n) => `· ${n === 1 ? '孤卷独行' : `${cnNum(n)}卷并行`}`, wrap: '· 封卷',
      foot: (d, a) => [`既成 ${d}`, `中断 ${a}`], climb: (t) => `此夜纪事 ${t}`,
      bEnter: '秘卷初启 · 循星而往', bLeave: '秘卷既成 · 归返书斋',
      enterHint: '月下入阁', verifying: '星辉渐明…', failed: '辉石黯灭',
      miss: '指印未合，再触一次',
      stage: '塔顶书斋里，骑士在月光下读书；有会话在跑时镜头扎进书页、进入魔法塔，骑士沿书阶上行。',
      // agents.js 给的进展是固定句式，只换表里有的几种，文件名、命令照原样
      prog: [
        [/^读取 /, '阅览典籍 · '], [/^写入 /, '封卷 · '], [/^本轮完成$/, '秘卷既成'], [/^被中断$/, '术式中断'],
        [/^出错了$/, '辉石黯灭'], [/^等你回答问题$/, '静候谕令'], [/^等你确认：/, '静候谕令 · '],
      ],
    }
  : {
      ledger: 'Chronicle of This Night',
      st: { running: 'The Spell Unfolds', waiting: 'Awaiting Your Command', done: 'The Tome Is Complete', aborted: 'The Spell Is Broken' },
      tIdle: 'The Tomes Lie Still', tEnter: 'Guided by the Stars', tRun: 'The Stars Keep Vigil', tLeave: 'Return to the Study',
      nRun: (n) => `· ${n < EN_NUM.length ? EN_NUM[n] : n} ${n === 1 ? 'Tome' : 'Tomes'} in Progress`, wrap: '· Sealing the Tomes',
      foot: (d, a) => [`Complete ${d}`, `Broken ${a}`], climb: (t) => `Chronicle of This Night ${t}`,
      bEnter: 'The Tome Unfolds · Guided by the Stars', bLeave: 'The Tome Is Complete · Return to the Study',
      enterHint: 'Enter the Moonlit Study', verifying: 'Starlight Awakens…', failed: 'The Glintstone Fades',
      miss: 'The Seal Does Not Match. Touch Again',
      stage: 'A knight reads by moonlight in a tower study. While sessions run, the camera dives into the book and the knight climbs the tower stairs.',
      prog: [
        [/^Read /, 'Consulting the Archives · '], [/^Write /, 'Seal the Tome · '], [/^Turn finished$/, 'The Tome Is Complete'],
        [/^Stopped$/, 'The Spell Is Broken'], [/^Failed$/, 'The Glintstone Fades'], [/^Waiting for your answer$/, 'Awaiting Your Command'],
        [/^Needs approval: /, 'Awaiting Your Command · '],
      ],
    }
/** 进展换成书斋的说法（只换认得的句式） */
const voice = (t) => { for (const [re, to] of TX.prog) if (re.test(t)) return t.replace(re, to); return t }
$('ledger').setAttribute('aria-label', TX.ledger)
$('stage').setAttribute('aria-label', TX.stage)

const pad = (n) => String(n).padStart(2, '0')
export const mmss = (ms) => {
  const s = Math.max(0, ms / 1000)
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s % 60))}` : `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`
}

// ============================================================ 月相（右上角和法卷顶上的徽记用同一个）
/** 0 新月 → 0.5 满月 → 1 新月；以 2000-01-06 18:14 UTC 的新月为起点，朔望月 29.530588853 天 */
export function moonPhase(t = Date.now()) {
  const days = (t - Date.UTC(2000, 0, 6, 18, 14)) / 86400000
  return (((days / 29.530588853) % 1) + 1) % 1
}
function drawMoon(g, r, p) {
  g.replaceChildren()
  const disc = document.createElementNS(SVG, 'circle')
  disc.setAttribute('r', r)
  disc.setAttribute('fill', '#141c38')
  disc.setAttribute('stroke', 'rgb(213 181 121 / 0.55)')
  disc.setAttribute('stroke-width', '0.7')
  const lit = document.createElementNS(SVG, 'path')
  const rx = Math.abs(Math.cos(2 * Math.PI * p)) * r
  // 北半球：上弦亮在右，下弦亮在左；明暗交界是一段椭圆
  const d = p < 0.5
    ? `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${rx} ${r} 0 0 ${p < 0.25 ? 0 : 1} 0 ${-r}Z`
    : `M0 ${-r}A${r} ${r} 0 0 0 0 ${r}A${rx} ${r} 0 0 ${p < 0.75 ? 0 : 1} 0 ${-r}Z`
  lit.setAttribute('d', d)
  lit.setAttribute('fill', '#dfeaff')
  const glow = document.createElementNS(SVG, 'circle')
  glow.setAttribute('r', r * 0.32)
  glow.setAttribute('cx', p < 0.5 ? r * 0.35 : -r * 0.35)
  glow.setAttribute('cy', -r * 0.25)
  glow.setAttribute('fill', '#fff')
  glow.setAttribute('opacity', String(0.35 * Math.sin(Math.PI * p)))
  g.append(disc, lit, glow)
}
function paintMoons() {
  const p = moonPhase()
  for (const g of document.querySelectorAll('.moonDraw')) drawMoon(g, g.closest('#moon') ? 6.6 : 8.4, p)
}

// ============================================================ 右上角：日期时间（照着菜单栏的写法）
function tick() {
  const d = new Date()
  const h = d.getHours(), h12 = h % 12 || 12, mm = pad(d.getMinutes())
  $('clockD').textContent = ZH
    ? `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')
  $('clockT').textContent = ZH ? `${h < 12 ? '上午' : '下午'}${h12}:${mm}` : `${h12}:${mm} ${h < 12 ? 'AM' : 'PM'}`
  if (d.getMinutes() % 30 === 0) paintMoons()
}
paintMoons()
tick()
setTimeout(() => { tick(); setInterval(tick, 60_000) }, 60_000 - (Date.now() % 60_000) + 50)

/** 外壳转来的电池、Wi-Fi（desk-unlock --status 读的） */
export function setStatus(st) {
  const b = st?.battery
  $('batt').hidden = !b
  if (b) {
    const pct = Math.max(0, Math.min(100, Math.round(b.percent)))
    $('pct').textContent = `${pct}%`
    const low = pct <= 20 && !b.plugged
    $('battFill').setAttribute('width', String(Math.max(pct > 0 ? 1.5 : 0, (20 * pct) / 100)))
    $('battFill').setAttribute('fill', low ? 'url(#blood)' : 'url(#mana)')
    $('batt').classList.toggle('low', low)
    $('bolt').toggleAttribute('hidden', !b.plugged)
  }
  const w = st?.wifi
  $('wifi').toggleAttribute('hidden', !w)
  if (w) {
    const bars = !w.on || !w.connected ? 0 : w.rssi >= -60 ? 3 : w.rssi >= -70 ? 2 : 1
    for (const n of [1, 2, 3]) $('wifi').querySelector(`.bar${n}`).style.opacity = n <= bars ? '1' : '0.3'
    $('wifiSlash').toggleAttribute('hidden', w.on)
  }
}

// ============================================================ 中间下方：触控 ID 法阵 + 提示
{
  // 外圈 24 个小符文，四种形状轮着来；内圈一颗八角星
  const g = $('sealRunes')
  const shapes = ['M0 -3v6M-2 -1h4', 'M-2.4 2 0 -2.6 2.4 2z', 'M0 -2.6a2.6 2.6 0 1 0 .01 0', 'M-2.4 -1.6 0 1.8 2.4 -1.6']
  for (let i = 0; i < 24; i++) {
    const p = document.createElementNS(SVG, 'path')
    p.setAttribute('d', shapes[i % 4])
    p.setAttribute('transform', `rotate(${i * 15} 64 64) translate(64 18)`)
    g.append(p)
  }
  const pts = Array.from({ length: 8 }, (_, i) => [64 + 34 * Math.sin((i * Math.PI) / 4), 64 - 34 * Math.cos((i * Math.PI) / 4)])
  $('sealStar').setAttribute('d', pts.map((_, i) => `${i ? 'L' : 'M'}${pts[(i * 3) % 8].join(' ')}`).join('') + 'Z')
}
const seal = $('seal'), hintEl = $('hint'), hintText = hintEl.querySelector('span')
let hint = { text: '', state: 'idle' }
let touchTimer = 0
function paintHint(text, cls) {
  hintText.textContent = text
  hintEl.className = cls
}
/** 外壳的原话（怎么解锁、为什么没解开）保留，前面加一句书斋的话 */
function hintLine(h) {
  if (!h.text) return ''
  if (h.state === 'verifying') return TX.verifying
  return `${h.state === 'failed' ? TX.failed : TX.enterHint} · ${h.text}`
}
/** 外壳的提示：平时「使用触控 ID 或输入密码」，验证中、没解开时换一句 */
export function setHint(h) {
  hint = { text: String(h?.text ?? ''), state: h?.state === 'verifying' || h?.state === 'failed' ? h.state : 'idle' }
  // 摸指纹的反馈还在显示：平时那句等它结束再换；验证中 / 没解开是人刚按了键，马上换
  if (touchTimer && hint.state === 'idle') return
  clearTimeout(touchTimer)
  touchTimer = 0
  paintHint(hintLine(hint), hint.state)
  seal.dataset.state = hint.state
}
/** 摸了 Touch ID：match 认出来了（屏保马上关），miss 没认出来，空字符串是老版本 desk-unlock（分不出来） */
export function touched(result) {
  const state = result === 'match' ? 'match' : result === 'miss' ? 'miss' : 'touch'
  seal.dataset.state = state
  if (state === 'miss') paintHint(TX.miss, 'miss')
  clearTimeout(touchTimer)
  // 系统的指纹图标 2.4 秒后淡掉，法阵跟着一起收
  touchTimer = setTimeout(() => {
    touchTimer = 0
    setHint(hint)
  }, 2400)
}
export function showHud(on) {
  document.body.classList.toggle('hud', on)
  $('astro').hidden = !on
}
export function demoSeal() { seal.dataset.demo = '' }

// ============================================================ 左侧：星辉法卷
const isLive = (s) => s.status === 'running' || s.status === 'waiting'
const rows = new Map()
const RING = `<svg class="ring" viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="16" r="15.2" fill="none" stroke="currentColor" stroke-width="0.6" opacity="0.5" />
  <g class="runes" fill="none" stroke="currentColor"><circle cx="16" cy="16" r="15.2" stroke-width="1.6" stroke-dasharray="2.2 3.8" />
  <path d="M16 .3l1.2 1.6-1.2 1.6-1.2-1.6zM16 28.5l1.2 1.6-1.2 1.6-1.2-1.6z" fill="currentColor" stroke="none" /></g>
  <circle class="seal" cx="16" cy="16" r="15.2" fill="none" stroke="currentColor" stroke-width="1.3" />
</svg>`

/** 要被去掉的行先淡出再删（淡出用 data-closing，不靠 display 过渡） */
function removeRow(li) {
  if (li.hasAttribute('data-closing')) return
  li.setAttribute('data-closing', '')
  const anims = li.getAnimations()
  const done = anims.length ? Promise.race([Promise.allSettled(anims.map((a) => a.finished)), new Promise((r) => setTimeout(r, 1500))]) : Promise.resolve()
  done.then(() => li.remove())
}

// 文字超长时末尾渐隐靠 scroll() 时间线；不支持的话由脚本量一下
const fadeFallback = !CSS.supports('animation-timeline', 'scroll()')
  ? new ResizeObserver((es) => { for (const { target } of es) target.style.setProperty('--fade', target.scrollWidth > target.clientWidth ? '2.2rem' : '0px') })
  : null

/**
 * @param {object[]} shown  这一轮要列出来的会话
 * @param {{ mode: string, running: boolean, on: boolean, climbMs: number }} o
 */
export function renderLedger(shown, o) {
  const ul = $('spells'), wall = Date.now()
  for (const s of shown) {
    let li = rows.get(s.id)
    if (!li) {
      li = document.createElement('li')
      li.innerHTML = `<span class="sigil ${s.kind}">${RING}<span class="disc"><i></i></span></span><div><div class="name"></div><div class="prog"></div></div><div class="meta"><span class="st"></span><span class="tm"><svg aria-hidden="true"><use href="#glass" /></svg><span></span></span></div><div class="thread" aria-hidden="true"></div>`
      ul.append(li)
      rows.set(s.id, li)
      fadeFallback?.observe(li.querySelector('.prog'))
    }
    li.className = s.status
    li.querySelector('.name').textContent = s.name
    const prog = li.querySelector('.prog')
    if (prog.dataset.t !== s.progress) {
      const caret = document.createElement('span')
      caret.className = 'caret'
      caret.setAttribute('aria-hidden', 'true')
      caret.textContent = '✦'
      prog.replaceChildren(caret, voice(s.progress))
      prog.dataset.t = s.progress
      prog.classList.remove('fresh')
      void prog.offsetWidth
      prog.classList.add('fresh')
    }
    const st = li.querySelector('.st')
    st.className = `st ${s.status}`
    st.textContent = TX.st[s.status]
    li.querySelector('.tm span').textContent = mmss((s.endedAt ?? wall) - s.startedAt)
  }
  for (const [id, li] of rows) if (!shown.some((s) => s.id === id)) { rows.delete(id); removeRow(li) }

  const nRun = shown.filter(isLive).length
  const nDone = shown.filter((s) => s.status === 'done').length
  const nAb = shown.filter((s) => s.status === 'aborted').length
  $('ledger').classList.toggle('on', o.on)
  $('ledger').classList.toggle('calm', !o.running)
  if (o.mode === 'idle' && !o.running) {
    $('lgTitle').textContent = TX.tIdle
    $('lgSub').textContent = ''
  } else {
    $('lgTitle').textContent = o.mode === 'leave' ? TX.tLeave : o.mode === 'enter' ? TX.tEnter : o.mode === 'idle' ? TX.tEnter : TX.tRun
    $('lgSub').textContent = nRun ? TX.nRun(nRun) : TX.wrap
  }
  // 每一项各占一段、段内不换行，放不下时在段与段之间换行
  const parts = [...TX.foot(nDone, nAb), ...(o.climbMs > 0 ? [TX.climb(mmss(o.climbMs))] : [])]
  const foot = $('lgFoot')
  if (foot.dataset.t !== parts.join('|')) {
    foot.dataset.t = parts.join('|')
    foot.replaceChildren(...parts.map((t) => Object.assign(document.createElement('span'), { textContent: t })))
  }
}

let bannerTimer = 0
export function banner(text, ms = 3600) {
  const b = $('banner')
  clearTimeout(bannerTimer)
  if (!text) return void b.classList.remove('on')
  b.textContent = text
  b.classList.add('on')
  bannerTimer = setTimeout(() => b.classList.remove('on'), ms)
}
