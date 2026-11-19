// 把 song.mjs 编成三样东西，三者出自同一份音符表，所以永远对齐：
//   out/spiral-stair.mid          多轨 MIDI：拖进 GarageBand / Logic / FL Studio / MuseScore 换音色、改音符
//   out/spiral-stair.score.json   塔里特效用的「视觉谱」（src/score.js 的格式；src/main.js 打包进主题）
//   out/spiral-stair-loop.m4a     演示页 index.html#demo,bgm 用：正好 40 小节 = 80 秒，首尾无缝（混响尾巴已经接到开头）
//   out/spiral-stair-full.m4a     MV 用：完整一遍 + 收尾
// 用法：node music/build.mjs [--no-audio] [--stems]（在 themes/magic-tower 下）
// 渲染要 fluidsynth + ffmpeg（brew install fluid-synth ffmpeg）和一个 GM 音色库（默认 GeneralUser GS）。

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import * as S from './song.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')
mkdirSync(out, { recursive: true })
const NAME = 'spiral-stair'
const BEATS = S.BARS * 4
const at = (bar, beat = 0) => bar * 4 + beat
const sec = (name) => S.SECTIONS.find((s) => s.name === name)
const inSec = (bar, ...names) => names.includes(S.sectionAt(bar))

// 固定种子的随机数：力度的人味儿，每次 build 一样
let seed = 20261119
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const hv = (v, amt = 0.06) => Math.min(1, Math.max(0.05, v + (rnd() * 2 - 1) * amt))

// ── 声部 ────────────────────────────────────────────────────────────────
// 每个声部是 [{ b, p, d, v }]（拍位、MIDI 音高、时值拍、力度 0..1）
const parts = {}
const add = (name, b, p, d, v) => (parts[name] ??= []).push({ b, p, d, v: hv(v) })

// 旋律：A、B 段长笛；副歌起弦乐唱旋律、圆号低八度托着
for (const [barStr, notes] of Object.entries(S.MELODY)) {
  const bar = Number(barStr); let b = at(bar)
  const total = notes.reduce((s, [, d]) => s + d, 0)
  if (Math.abs(total - 4) > 1e-9) throw new Error(`melody bar ${bar} has ${total} beats`)
  for (const [n, d] of notes) {
    if (n !== '-') {
      const p = S.m(n), v = d >= 1.5 ? 0.85 : 0.75
      add('lead', b, p, d, v)
    }
    b += d
  }
}
for (const [a, z] of S.TIES) {                         // 跨小节延音：同音高首尾相接就并成一个音
  const L = parts.lead, last = L.findLast((n) => n.b < at(z)), next = L.find((n) => n.b === at(z))
  if (last && next && last.p === next.p && Math.abs(last.b + last.d - next.b) < 1e-9) { last.d += next.d; L.splice(L.indexOf(next), 1) }
}
for (const [barStr, notes] of Object.entries(S.BELL)) {
  let b = at(Number(barStr))
  for (const [n, d] of notes) { if (n !== '-') add('bell', b, S.m(n), d, 0.8); b += d }
}

// 铺底弦乐 + 合唱：每小节一个和弦，相邻小节的共同音直接延长（弦乐的保持音 = 塔里一条持续的极光）
const padVel = (bar) => {
  const s = S.sectionAt(bar)
  if (s === 'intro') return 0.45
  if (s === 'A') return 0.55
  if (s === 'B') return 0.55 + (bar - sec('B').from) * 0.035
  return s === 'final' ? 0.8 : 0.72
}
function sustained(name, bars, vel) {
  const open = new Map()                               // 音高 → 正在响的音
  for (let bar = 0; bar < S.BARS; bar++) {
    const want = bars(bar) ? S.CHORDS[bar].pad : []
    for (const [p, n] of open) if (!want.includes(p)) open.delete(p)
    for (const p of want) {
      if (open.has(p)) open.get(p).d += 4
      else { const n = { b: at(bar), p, d: 4, v: hv(vel(bar), 0.03) }; (parts[name] ??= []).push(n); open.set(p, n) }
    }
  }
  for (const n of parts[name]) n.d -= 0.1                // 换和弦前留一点点气口
}
sustained('pad', (bar) => !inSec(bar, 'break'), padVel)
sustained('choir', (bar) => inSec(bar, 'chorus', 'final') || bar === 28 || bar === 29 || bar === 31, (bar) => (bar === 31 ? 0.55 : 0.62))

// 琶音：和弦音往上一个八度，八分音符按 3+3+2 排（重音落在第 1、4、7 个八分音符上）
const ARP_ORDER = [0, 1, 2, 0, 1, 2, 3, 2]
for (let bar = 0; bar < S.BARS; bar++) {
  if (inSec(bar, 'break')) continue
  const pad = S.CHORDS[bar].pad
  const tones = (pad.length >= 4 ? pad : [...pad, pad[0] + 12]).map((p) => p + 12)
  const up = inSec(bar, 'chorus', 'final') ? 12 : 0
  ARP_ORDER.forEach((k, i) => {
    const accent = i === 0 || i === 3 || i === 6
    add(bar < 4 || bar === 39 ? 'celesta' : 'arp', at(bar, i * 0.5), tones[k] + up, 0.45, accent ? 0.72 : 0.5)
  })
}

// 贝斯
for (let bar = 0; bar < S.BARS; bar++) {
  const r = S.CHORDS[bar].bass, s = S.sectionAt(bar)
  if (s === 'A') {
    [[0, 1.4, 0], [1.5, 1.4, 0], [3, 0.45, 0], [3.5, 0.45, 12]].forEach(([b, d, o], i) => add('bass', at(bar, b), r + o, d, (i ? 0.62 : 0.78) + (bar >= 8 ? 0.08 : 0)))
  } else if (s === 'B') {
    for (let i = 0; i < 8; i++) add('bass', at(bar, i * 0.5), r + (i % 2 && bar >= 16 ? 12 : 0), 0.42, 0.62 + (bar - 12) * 0.03 + (i % 2 ? 0 : 0.08))
  } else if (s === 'chorus' || (s === 'final' && bar < 39)) {
    [[0, 0], [0.75, 0], [1.5, 12], [2, 0], [2.75, 0], [3.5, 12]].forEach(([b, o], i) => add('bass', at(bar, b), r + o, 0.6, i % 3 === 0 ? 0.95 : 0.75))
  } else if (bar === 39) {
    add('bass', at(39), r, 2, 0.85)
  }
}
add('bass', at(28), S.m('D1'), 3.5, 1)                  // 间奏重击下面的低音
for (const b of [0, 0.75, 1.5]) add('bass', at(30, b), S.m('D1'), 0.5, 1)

// 鼓
const DR = { kick: 36, snare: 38, clap: 39, hihat: 42, openhat: 46, crash: 49, toms: [50, 48, 47, 45, 43, 41] }
// 鼓的力度随段落走：A 收着 → B 一路推 → 副歌满 → 终副歌最满（压缩放轻了，这条曲线才听得出来）
const drumGain = (bar) => {
  const s = S.sectionAt(bar)
  if (s === 'A') return bar < 8 ? 0.68 : 0.8
  if (s === 'B') return 0.8 + (bar - 12) * 0.028
  return s === 'final' ? 1 : 0.92
}
const fillAt = (bar) => S.FILLS.find((f) => f.bar === bar)
for (let bar = 0; bar < S.BARS; bar++) {
  const s = S.sectionAt(bar)
  const g = s === 'A' ? S.GROOVES.A : s === 'B' ? S.GROOVES.B : (s === 'chorus' || (s === 'final' && bar < 39)) ? S.GROOVES.chorus : null
  if (!g) continue
  const f = fillAt(bar)
  for (const [inst, beats] of Object.entries(g)) {
    let bs = beats
    if (inst === 'hihat' && s === 'B' && bar >= 16) bs = Array.from({ length: 16 }, (_, i) => i / 4)     // 后半段 B 换成十六分镲
    if (s === 'A' && bar < 8) {                                // A 前四小节收着：军鼓只打第 4 拍（半速感），镲只打反拍
      if (inst === 'snare') bs = [3]
      if (inst === 'hihat') bs = bs.filter((b) => b % 1 === 0.5)
    }
    for (const b of bs) {
      if (f && b >= f.from) continue
      const v = inst === 'hihat' ? (b % 1 === 0.5 ? 0.62 : 0.45) : inst === 'kick' && b % 2 !== 0 ? 0.82 : 0.95
      add(inst, at(bar, b), DR[inst], 0.25, v * drumGain(bar))
    }
  }
}
add('kick', at(39), DR.kick, 0.25, 1)
for (const bar of S.CRASHES) add('crash', at(bar), DR.crash, 2, 1)
add('crash', at(38), DR.crash, 2, 0.9)
for (const f of S.FILLS) {
  const steps = (4 - f.from) * 4
  for (let i = 0; i < steps; i++) {
    const v = 0.55 + (0.45 * i) / Math.max(1, steps - 1)
    const p = f.kind === 'toms' ? DR.toms[Math.min(DR.toms.length - 1, Math.floor((i / steps) * DR.toms.length))] : DR.snare
    add('fill', at(f.bar, f.from + i / 4), p, 0.25, v)
  }
}
for (const [bar, b] of S.IMPACTS) {
  const v = bar === 30 ? 0.85 + b * 0.1 : 1
  for (const p of ['D3', 'A3', 'D4']) add('impact', at(bar, b), S.m(p), 0.6, v)
  add('timpani', at(bar, b), S.m('D2'), 1.5, v)
  add('kick', at(bar, b), DR.kick, 0.25, 1)
}

for (const k in parts) parts[k].sort((a, b) => a.b - b.b || a.p - b.p)

// ── MIDI 轨道（音色 = General MIDI 编号；换音色只改这里）────────────────────
const TRACKS = [
  // 音量（vol = CC7）按分轨实测配平过：副歌的旋律要是全曲最响的东西，A 段的长笛不能抢过它
  { name: 'Lead · Flute', ch: 0, prog: 73, vol: 76, pan: 64, rev: 55, notes: () => parts.lead.map((n) => (n.b < at(20) ? n : { ...n, v: n.v * 0.72 })) },   // 副歌里同度叠在弦乐上，给旋律一个清楚的头
  { name: 'Lead · Strings', ch: 1, prog: 48, vol: 127, pan: 60, rev: 70, notes: () => parts.lead.filter((n) => n.b >= at(20)).map((n) => ({ ...n, v: n.v * (n.b < at(28) ? 0.88 : 1) })) },
  { name: 'Lead · Horns (8vb)', ch: 2, prog: 60, vol: 100, pan: 70, rev: 70, notes: () => parts.lead.filter((n) => n.b >= at(20)).map((n) => ({ ...n, p: n.p - 12, v: n.v * (n.b < at(28) ? 0.7 : 0.95) })) },
  { name: 'Bell · Celesta', ch: 3, prog: 8, vol: 100, pan: 64, rev: 95, notes: () => [...parts.bell, ...parts.celesta] },
  { name: 'Arp · Harp', ch: 4, prog: 46, vol: 96, pan: 84, rev: 60, notes: () => parts.arp },
  { name: 'Pad · Strings', ch: 5, prog: 49, vol: 72, pan: 44, rev: 85, notes: () => parts.pad },
  { name: 'Pad · Choir', ch: 6, prog: 52, vol: 76, pan: 64, rev: 95, notes: () => parts.choir },
  { name: 'Bass · Synth', ch: 7, prog: 38, vol: 84, pan: 64, rev: 8, notes: () => parts.bass },
  { name: 'Impact · Orchestra Hit', ch: 8, prog: 55, vol: 92, pan: 64, rev: 70, notes: () => parts.impact },
  { name: 'Impact · Timpani', ch: 10, prog: 47, vol: 112, pan: 64, rev: 60, notes: () => parts.timpani },
  { name: 'Drums (Power kit)', ch: 9, prog: 16, vol: 88, pan: 64, rev: 28, notes: () => ['kick', 'snare', 'clap', 'hihat', 'openhat', 'crash', 'fill'].flatMap((k) => parts[k] ?? []) },
]

// ── 极简 MIDI 写入（format 1, 480 tick/拍）───────────────────────────────────
const PPQ = 480
const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b }
const str = (s) => [...Buffer.from(s, 'utf8')]
const chunk = (id, data) => [...str(id), (data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...data]
function trackBytes(events) {                               // events: [{ t(tick), order, bytes }]
  events.sort((a, b) => a.t - b.t || a.order - b.order)
  const data = []; let last = 0
  for (const e of events) { data.push(...vlq(e.t - last), ...e.bytes); last = e.t }
  data.push(0, 0xff, 0x2f, 0)
  return chunk('MTrk', data)
}
function writeMidi(file, repeats = 1, only = null) {
  const usPerBeat = Math.round(60e6 / S.BPM)
  const conductor = [
    { t: 0, order: 0, bytes: [0xff, 0x03, ...vlq(Buffer.byteLength('Spiral Stair')), ...str('Spiral Stair')] },
    { t: 0, order: 0, bytes: [0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255] },
    { t: 0, order: 0, bytes: [0xff, 0x58, 4, 4, 2, 24, 8] },
    { t: 0, order: 0, bytes: [0xff, 0x59, 2, 0xff, 1] },     // 调号：1 个降号、小调（D 小调记谱；多利亚的 B 用还原号）
    ...S.SECTIONS.map((s) => ({ t: s.from * 4 * PPQ, order: 1, bytes: [0xff, 0x06, ...vlq(s.name.length), ...str(s.name)] })),
  ]
  const tracks = [trackBytes(conductor)]
  for (const tr of TRACKS) {
    if (only && tr !== only) continue
    const ev = [
      { t: 0, order: 0, bytes: [0xff, 0x03, ...vlq(Buffer.byteLength(tr.name)), ...str(tr.name)] },
      { t: 0, order: 2, bytes: [0xc0 | tr.ch, tr.prog] },
      { t: 0, order: 3, bytes: [0xb0 | tr.ch, 7, tr.vol] },
      { t: 0, order: 3, bytes: [0xb0 | tr.ch, 10, tr.pan] },
      { t: 0, order: 3, bytes: [0xb0 | tr.ch, 91, tr.rev] },
    ]
    for (let r = 0; r < repeats; r++) {
      for (const n of tr.notes()) {
        const on = Math.round((n.b + r * BEATS) * PPQ), off = Math.round((n.b + n.d + r * BEATS) * PPQ)
        const vel = Math.max(1, Math.min(127, Math.round(n.v * 127)))
        ev.push({ t: on, order: 5, bytes: [0x90 | tr.ch, n.p, vel] }, { t: off, order: 4, bytes: [0x80 | tr.ch, n.p, 0] })
      }
    }
    tracks.push(trackBytes(ev))
  }
  const header = chunk('MThd', [0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255])
  writeFileSync(file, Buffer.from([...header, ...tracks.flat()]))
}

// ── 塔里的特效乐谱（score.js 格式；乐器名就是 INSTRUMENT_FX 的键）────────────
// 这是「视觉谱」，不是把每个音都打成特效：音乐里铺满的织体（琶音、镲、贝斯的八分音符）只取 3+3+2 的重音，
// 让画面的密度跟着曲子的起伏走（A 收着 → B 推 → 副歌满），而不是从头到尾一样满。
const r3 = (x) => +x.toFixed(3), r2 = (x) => +x.toFixed(2)
const pick = (k, keep = () => true) => (parts[k] ?? []).filter(keep).map(({ b, p, d, v }) => ({ b: r3(b), p, d: r3(d), v: r2(v) }))
const beatsOnly = (k, keep = () => true) => (parts[k] ?? []).filter(keep).map(({ b, v }) => ({ b: r3(b), v: r2(v) }))
const barOf = (n) => Math.floor(n.b / 4), pos = (n) => n.b - barOf(n) * 4, onPos = (...ps) => (n) => ps.some((x) => Math.abs(pos(n) - x) < 1e-6)
const ACCENT = onPos(0, 1.5, 3)                     // 一小节八个八分音符里的 3+3+2 重音
const bars = (from, to) => (n) => barOf(n) >= from && barOf(n) < to
const ones = (...list) => list.map(([bar, beat = 0]) => ({ b: at(bar, beat) }))
// 段落 → 塔里的状态（scene.js 的 MOODS）：骑士走多快、灯多亮、颜色多暖
const MOOD = { intro: 'calm', A: 'walk', B: 'climb', chorus: 'full', break: 'freeze', final: 'full' }
const score = {
  title: 'Spiral Stair · 螺旋书阶',
  bpm: S.BPM,
  offset: 0,
  loopBeats: BEATS,
  sections: [...S.SECTIONS.map((s) => ({ name: s.name, b: s.from * 4, mood: MOOD[s.name] })), { name: 'picardy', b: at(38), mood: 'gold' }],
  tracks: [
    { instrument: 'kick', notes: beatsOnly('kick', (n) => !S.IMPACTS.some(([bar, beat]) => Math.abs(n.b - at(bar, beat)) < 1e-6)) },
    { instrument: 'snare', notes: beatsOnly('snare') },
    { instrument: 'clap', notes: beatsOnly('clap') },
    // 镲：只在 B 段后半（十六分镲那几小节，取反拍八分音符）和副歌的开镲上闪，A 段不闪
    { instrument: 'hihat', notes: [...beatsOnly('hihat', (n) => bars(16, 20)(n) && pos(n) % 1 === 0.5), ...beatsOnly('openhat')].sort((a, b) => a.b - b.b) },
    // 贝斯：一小节两次（A 段 0、1.5 拍；B 段和副歌 0、2 拍），间奏的低音重击全留
    { instrument: 'bass', notes: pick('bass', (n) => (S.sectionAt(barOf(n)) === 'A' ? onPos(0, 1.5)(n) : onPos(0, 2)(n)) || bars(28, 32)(n)) },
    // 铺底：前奏、间奏里极光就是主角，每个和弦音一条；其它段落鼓和旋律已经很满，只留和弦最高的那个声部（几条丝带叠在一起会把天井冲白）
    { instrument: 'pad', notes: [...pick('pad', (n) => bars(0, 4)(n) || n.p === Math.max(...S.CHORDS[barOf(n)].pad)), ...pick('choir', bars(28, 32))].sort((a, b) => a.b - b.b) },
    { instrument: 'lead', notes: pick('lead') },
    { instrument: 'arp', notes: [...pick('arp', ACCENT), ...pick('celesta', ACCENT)].sort((a, b) => a.b - b.b) },
    { instrument: 'bell', notes: pick('bell') },
    // 大事件一次只能演一个，按段落功能排好不撞车（巨剑和脉冲的蓄力本身就是过门的画面，过门不再另打）：
    //   B 段、副歌后半、终副歌后半进来：星辉脉冲；副歌、间奏、终副歌进来：光之巨剑；
    //   间奏的三声重击：三道最粗的天光；落到 D 大三那一刻：彗星齐射
    { instrument: 'crash', notes: ones([12], [24], [36]) },
    { instrument: 'impact', notes: ones([20], [28], [32]) },
    { instrument: 'impact', fx: 'beam', notes: ones([30, 0], [30, 0.75], [30, 1.5]).map((n, i) => ({ ...n, v: 1, p: 0.05 + i * 0.1 })) },
    { instrument: 'fill', notes: ones([38]) },
  ],
}
writeFileSync(join(out, `${NAME}.score.json`), JSON.stringify(score) + '\n')
writeMidi(join(out, `${NAME}.mid`))
const counts = Object.fromEntries(score.tracks.map((t) => [t.instrument, t.notes.length]))
console.log(`score: ${BEATS} beats = ${(BEATS * 60) / S.BPM}s`, counts)

// ── 渲染音频 ────────────────────────────────────────────────────────────────
if (process.argv.includes('--no-audio')) process.exit(0)
const SF = process.env.SOUNDFONT ?? join(homedir(), 'Library/Audio/Sounds/Banks/GeneralUser-GS.sf2')
if (!existsSync(SF)) throw new Error(`soundfont not found: ${SF} (set SOUNDFONT=...)`)
const tmp = join(out, '.tmp'); mkdirSync(tmp, { recursive: true })
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const synth = (mid, wav) => run('fluidsynth', ['-ni', '-q', '-g', '0.55', '-r', '48000', '-o', 'synth.reverb.room-size=0.78', '-o', 'synth.reverb.damp=0.35',
  '-o', 'synth.reverb.width=1.0', '-o', 'synth.reverb.level=0.7', '-o', 'synth.chorus.active=0', '-F', wav, SF, mid])
const LOOP_SEC = (BEATS * 60) / S.BPM
// 循环版：渲两遍，取第二遍 → 开头带着上一遍的混响尾巴，首尾接上听不出缝
writeMidi(join(tmp, 'x2.mid'), 2)
synth(join(tmp, 'x2.mid'), join(tmp, 'x2.wav'))
// 完整版：一遍 + 4 秒尾巴
synth(join(out, `${NAME}.mid`), join(tmp, 'x1.wav'))

const BUS = 'highpass=f=30,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1.2:g=1.5,acompressor=threshold=-15dB:ratio=1.8:attack=25:release=300:makeup=1.5'
// 母带：先量整体响度，再整体加一个固定增益到 -14 LUFS，最后限幅器只削峰。
// （不用 loudnorm 的动态模式：它是自动增益，会把 A 段、副歌、终副歌拉成一样响，曲子的起伏就没了）
function master(src, dst, [from, to], fadeOut = 0) {
  const pre = `atrim=start=${from}:end=${to},asetpts=N/SR/TB,${BUS}`
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', src, '-af', `${pre},ebur128`, '-f', 'null', '-'], { encoding: 'utf8' })
  const I = Number(/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/.exec(probe.stderr)[1])
  const gain = (-14 - I).toFixed(2)
  const fade = fadeOut ? `,afade=t=out:st=${to - from - fadeOut}:d=${fadeOut}` : ''
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-af', `${pre},volume=${gain}dB,alimiter=limit=0.87:attack=3:release=60:level=false${fade}`, '-ar', '48000', '-c:a', 'pcm_s16le', dst + '.wav'])
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', dst + '.wav', '-c:a', 'aac', '-b:a', '160k', dst + '.m4a'])
}
master(join(tmp, 'x2.wav'), join(out, `${NAME}-loop`), [LOOP_SEC, LOOP_SEC * 2])
master(join(tmp, 'x1.wav'), join(out, `${NAME}-full`), [0, LOOP_SEC + 4], 3)
// 分轨（--stems）：每条轨单独渲一遍，未压缩、未母带，拖进 DAW 自己混
if (process.argv.includes('--stems')) {
  const dir = join(out, 'stems'); mkdirSync(dir, { recursive: true })
  for (const [i, tr] of TRACKS.entries()) {
    const slug = `${String(i + 1).padStart(2, '0')}-${tr.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
    writeMidi(join(tmp, 's.mid'), 1, tr)
    synth(join(tmp, 's.mid'), join(dir, `${slug}.wav`))
  }
  console.log('stems:', dir)
}
rmSync(tmp, { recursive: true, force: true })
console.log('audio:', join(out, `${NAME}-loop.m4a`), join(out, `${NAME}-full.m4a`))
