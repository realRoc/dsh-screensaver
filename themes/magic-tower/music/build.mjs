// 把 song.mjs 编成这几样东西，全部出自同一份音符表，所以永远对齐：
//   out/star-well.mid          多轨 MIDI：拖进 GarageBand / Logic / FL Studio / MuseScore 换音色、改音符（含尾声小节）
//   out/star-well.score.json   塔里特效用的「视觉谱」（src/score.js 的格式；src/main.js 打包进主题）
//   out/star-well-loop.m4a     演示页 index.html#demo,bgm 用：正好 34 小节 = 85 秒，首尾无缝（混响尾巴已经接到开头）
//   out/star-well-full.m4a     MV 用：完整一遍 + 尾声小节 + 余音（music/record.mjs 录视频用这个）
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
const NAME = 'star-well'
const BEATS = S.BARS * S.METER
const at = (bar, beat = 0) => bar * S.METER + beat
const inSec = (bar, ...names) => names.includes(S.sectionAt(bar))
const END = S.BARS                                     // 尾声小节（只在完整版里）
const chordAt = (bar) => (bar === END ? S.END_CHORD : S.CHORDS[bar])

// 固定种子的随机数：力度的人味儿，每次 build 一样
let seed = 20261120
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const hv = (v, amt = 0.04) => Math.min(1, Math.max(0.03, v + (rnd() * 2 - 1) * amt))

// ── 声部 ────────────────────────────────────────────────────────────────
// 每个声部是 [{ b, p, d, v, end? }]（拍位、MIDI 音高、时值拍、力度 0..1；end = 尾声小节里的音，只进完整版）
const parts = {}
const add = (name, b, p, d, v, extra = {}) => (parts[name] ??= []).push({ b, p, d, v: hv(v), ...extra })
const endOf = (b) => (b >= at(END) ? { end: true } : {})

// 旋律：升腾段弦乐唱（长笛叠在同度上给个头）；A、A′ 长笛；A′ 弦乐低八度陪着
function melodyBar(bar, notes) {
  let b = at(bar)
  const total = notes.reduce((s, [, d]) => s + d, 0)
  if (Math.abs(total - S.METER) > 1e-9) throw new Error(`melody bar ${bar} has ${total} beats`)
  for (const [n, d] of notes) {
    if (n !== '-') {
      const p = S.m(n), long = d >= 2, e = endOf(b)
      if (bar === END) { add('flute', b, p, d + 3, 0.5, e); add('melStrings', b, p - 12, d + 3, 0.34, e) }
      else if (S.MELODY_VOICE(bar) === 'strings') {
        const lift = Math.max(0, bar - 6) * 0.025             // 升腾段一级级往上，力度也跟着起来，第 10 小节最响
        add('melStrings', b, p, d - 0.04, 0.72 + Math.min(lift, 0.12) + (long ? 0.04 : 0))
        add('flute', b, p, d - 0.08, 0.42 + lift * 0.5)
      } else {
        add('flute', b, p, d - 0.06, long ? 0.6 : 0.54)
        if (inSec(bar, 'A2')) add('melStrings', b, p - 12, d - 0.04, 0.3)
      }
    }
    b += d
  }
}
for (const [bar, notes] of Object.entries(S.MELODY)) melodyBar(Number(bar), notes)
melodyBar(END, S.END_MELODY)

// 竖琴：安静的段落是圆舞曲的「一、二」—— 第一拍一个低音，第二拍一个琶开的和弦，第三拍留空（留白才静）；
// 升腾段换成一小节六个八分音符的分解和弦一路往上流；蓄势最后两拍一个刮奏，落进门打开的那一拍
const RISE_ORDER = [(c) => c.bass + 12, (c) => c.pad[0] + 12, (c) => c.pad[1] + 12, (c) => c.pad[2] + 12, (c) => c.pad[3] + 12, (c) => c.pad[1] + 24]
for (let bar = 0; bar < S.BARS; bar++) {
  if (inSec(bar, 'intro', 'breath', 'build')) continue
  const c = S.CHORDS[bar]
  if (inSec(bar, 'rise')) { RISE_ORDER.forEach((f, i) => add('harp', at(bar, i * 0.5), f(c), 1.2, i ? 0.54 : 0.66)); continue }
  const g = 0
  add('harp', at(bar), c.bass + 12, 2.5, 0.5 + g)
  if (bar === S.BARS - 1) continue                     // 最后一小节只留低音，悬着
  c.pad.forEach((p, i) => add('harp', at(bar, 1 + i * 0.06), p + 12, 1.6, 0.34 + g + i * 0.02))
}
{
  const g = S.HARP_GLISS, from = at(...g.from), to = at(...g.to), tones = S.CHORDS[g.from[0]].tones, lo = S.m(g.low), hi = S.m(g.high)
  const notes = []; for (let p = lo; p <= hi; p++) if (tones.includes(p % 12)) notes.push(p)
  notes.forEach((p, i) => add('harp', from + ((to - from) * i) / notes.length, p, 1.5, 0.32 + (0.3 * i) / notes.length))
}
S.END_CHORD.pad.forEach((p, i) => add('harp', at(END, i * 0.12), p + 12, 6, 0.4, { end: true }))
add('harp', at(END), S.END_CHORD.bass + 12, 6, 0.5, { end: true })

// 低音提琴：每小节一个长音；同音相连（D 持续音）就并成一个，不重新起音
const lowVel = (bar) => (inSec(bar, 'rise') ? 0.7 : inSec(bar, 'build') ? 0.5 : inSec(bar, 'intro', 'breath') ? 0.4 : 0.44)
for (let bar = 0; bar <= END; bar++) {
  const p = chordAt(bar).bass, prev = parts.low?.at(-1)
  if (prev && prev.p === p && Math.abs(prev.b + prev.d - at(bar)) < 1e-9 && bar !== END) { prev.d += S.METER; continue }
  add('low', at(bar), p, bar === END ? 7 : S.METER, lowVel(bar), endOf(at(bar)))
}

// 铺底弦乐 + 合唱：每小节一个和弦，相邻小节的共同音直接延长（弦乐的保持音 = 塔里一条慢慢的极光）
const padVel = (bar) => ({ intro: 0.38, build: bar === 4 ? 0.48 : 0.6, rise: 0.68, A: 0.42, breath: 0.36, A2: 0.44, end: 0.4 })[S.sectionAt(bar)]
function sustained(name, wants, vel) {
  const open = new Map()                               // 音高 → 正在响的音
  for (let bar = 0; bar <= END; bar++) {
    const want = wants(bar) ? chordAt(bar).pad : []
    for (const [p] of open) if (!want.includes(p)) open.delete(p)
    for (const p of want) {
      if (open.has(p) && bar !== END) open.get(p).d += S.METER
      else { const n = { b: at(bar), p, d: bar === END ? 7 : S.METER, v: hv(vel(bar), 0.02), ...endOf(at(bar)) }; (parts[name] ??= []).push(n); open.set(p, n) }
    }
  }
  for (const n of parts[name]) n.d -= 0.08              // 换和弦前留一点点气口
}
sustained('pad', () => true, padVel)
sustained('choir', (bar) => bar === 5 || inSec(bar, 'rise', 'breath') || (bar >= 30 && bar < 33), (bar) => (bar === 5 ? 0.48 : inSec(bar, 'rise') ? 0.6 + Math.min(bar - 6, 4) * 0.02 : 0.3))

// 谢泼德琶音（钢片琴）：每个音是「比上一个更高的下一个和弦音」，同一个音级在几个八度上同时响，
// 音量 = 钟形曲线（中心 MIDI 74、宽 8 个半音）。安静的段落四分音符，蓄势和升腾加倍成八分音符。
const SHEP = { center: 74, width: 8, lo: 48, hi: 100, floor: 0.1 }
const shepWeight = (p) => Math.exp(-0.5 * ((p - SHEP.center) / SHEP.width) ** 2)
let x = S.m('D4') - 0.5                                 // 「虚拟音高」，只会往上走
const shepFirst = []                                    // 每小节第一个音最响的那层（给视觉谱）
for (let bar = 0; bar <= END; bar++) {
  const c = chordAt(bar), step = inSec(bar, 'build', 'rise') ? 0.5 : 1
  const level = { intro: 0.56, build: 0.6, rise: 0.64, A: 0.5, breath: 0.58, A2: 0.5, end: 0.54 }[S.sectionAt(bar)]
  for (let b = 0; b < S.METER - 1e-9; b += step) {
    if (bar === END && b > 1) break
    let next = Infinity
    for (const t of c.tones) { let q = t; while (q <= x) q += 12; next = Math.min(next, q) }
    x = next
    let best = null
    for (let p = (next % 12) + 12 * Math.floor(SHEP.lo / 12); p <= SHEP.hi; p += 12) {
      if (p < SHEP.lo) continue
      const w = shepWeight(p)
      if (w < SHEP.floor) continue
      add('shepard', at(bar, b), p, step * 2.2, level * (0.35 + 0.65 * w), endOf(at(bar, b)))
      if (!best || w > best.w) best = { p, w }
    }
    if (bar < END && (b === 0 || (step < 1 && Math.abs(b - 1.5) < 1e-9))) shepFirst.push({ b: at(bar, b), p: best.p, v: level })
  }
}

// 定音鼓：滚奏（十六分音符渐强）+ 重击
for (const [[b0, k0], [b1, k1], n, v0, v1] of S.TIMPANI_ROLLS) {
  const from = at(b0, k0), to = at(b1, k1), steps = Math.round((to - from) * 4)
  for (let i = 0; i < steps; i++) add('timpani', from + i / 4, S.m(n), 0.3, v0 + ((v1 - v0) * i) / steps)
}
for (const [bar, beat, n, v] of S.TIMPANI_HITS) add('timpani', at(bar, beat), S.m(n), 2.5, v)

for (const k in parts) parts[k].sort((a, b) => a.b - b.b || a.p - b.p)

// ── MIDI 轨道（音色 = General MIDI 编号；换音色只改这里）────────────────────
const TRACKS = [
  { name: 'Melody · Flute', ch: 0, prog: 73, vol: 92, pan: 66, rev: 72, notes: () => parts.flute },
  { name: 'Melody · Strings', ch: 1, prog: 48, vol: 104, pan: 58, rev: 84, notes: () => parts.melStrings },
  { name: 'Shepard · Celesta', ch: 2, prog: 8, vol: 116, pan: 40, rev: 108, notes: () => parts.shepard },
  { name: 'Waltz · Harp', ch: 3, prog: 46, vol: 100, pan: 84, rev: 76, notes: () => parts.harp },
  { name: 'Pad · Slow Strings', ch: 4, prog: 49, vol: 84, pan: 50, rev: 96, notes: () => parts.pad },
  { name: 'Pad · Choir', ch: 5, prog: 52, vol: 80, pan: 64, rev: 110, notes: () => parts.choir },
  { name: 'Low · Contrabass', ch: 6, prog: 43, vol: 96, pan: 64, rev: 56, notes: () => parts.low },
  { name: 'Timpani', ch: 7, prog: 47, vol: 118, pan: 64, rev: 80, notes: () => parts.timpani },
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
// repeats 遍循环（不带尾声）；withEnd = 最后一遍后面接尾声小节
function writeMidi(file, { repeats = 1, withEnd = false, only = null } = {}) {
  const usPerBeat = Math.round(60e6 / S.BPM)
  const conductor = [
    { t: 0, order: 0, bytes: [0xff, 0x03, ...vlq(Buffer.byteLength(S.TITLE)), ...str(S.TITLE)] },
    { t: 0, order: 0, bytes: [0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255] },
    { t: 0, order: 0, bytes: [0xff, 0x58, 4, S.METER, 2, 24, 8] },
    { t: 0, order: 0, bytes: [0xff, 0x59, 2, 0xff, 1] },     // 调号：1 个降号、小调（D 小调）
    ...S.SECTIONS.map((s) => ({ t: s.from * S.METER * PPQ, order: 1, bytes: [0xff, 0x06, ...vlq(s.name.length), ...str(s.name)] })),
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
      const last = r === repeats - 1
      for (const n of tr.notes()) {
        if (n.end && !(withEnd && last)) continue
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
// 「视觉谱」是从音乐里挑出来的，不是每个音都打：画面跟曲子一样静，只在进塔的升腾段热闹起来。
//   旋律每个音 → 一颗流星（主角）；谢泼德琶音每小节第一个音 → 一盏灯链（升腾段一小节两盏）；
//   竖琴低音 → 地脉涟漪（升腾段每小节，A、A′ 隔一小节）；铺底 → 一条很淡的极光，只在前奏、升腾、静息里换和弦时；
//   光之巨剑落在升腾段的最高点和 A′ 回来的第一拍；静息第一拍 → 星辉脉冲。没有鼓组，就没有天光、法阵、星芒。
const r3 = (x) => +x.toFixed(3), r2 = (x) => +x.toFixed(2)
const loopOnly = (n) => !n.end
const pick = (k, keep = () => true) => (parts[k] ?? []).filter(loopOnly).filter(keep).map(({ b, p, d, v }) => ({ b: r3(b), p, d: r3(d), v: r2(v) }))
const barOf = (n) => Math.floor(n.b / S.METER + 1e-9)
const MOOD = { intro: 'calm', build: 'calm', rise: 'full', A: 'walk', breath: 'hush', A2: 'walk' }
const topPad = (n) => n.p === Math.max(...S.CHORDS[barOf(n)].pad)
const score = {
  title: S.TITLE,
  bpm: S.BPM,
  offset: 0,
  loopBeats: BEATS,
  sections: S.SECTIONS.map((s) => ({ name: s.name, b: s.from * S.METER, mood: MOOD[s.name] })),
  tracks: [
    { instrument: 'lead', notes: [...pick('flute', (n) => S.MELODY_VOICE(barOf(n)) === 'flute'), ...pick('melStrings', (n) => S.MELODY_VOICE(barOf(n)) === 'strings')].sort((a, b) => a.b - b.b) },
    { instrument: 'arp', notes: shepFirst.map(({ b, p, v }) => ({ b: r3(b), p, v: r2(v + 0.05) })) },
    { instrument: 'bass', notes: pick('harp', (n) => Math.abs(n.b - at(barOf(n))) < 1e-9 && (inSec(barOf(n), 'rise') || barOf(n) % 2 === 0) && !inSec(barOf(n), 'build')).map((n) => ({ ...n, v: 0.45 })) },
    { instrument: 'pad', notes: pick('pad', (n) => inSec(barOf(n), 'intro', 'rise', 'breath') && topPad(n) && !S.SWORDS.some(([bar]) => bar === barOf(n))).map((n) => ({ ...n, v: 0.35 })) },
    { instrument: 'impact', notes: S.SWORDS.map(([bar, beat]) => ({ b: at(bar, beat) })) },
    { instrument: 'crash', notes: S.PULSE.map(([bar, beat]) => ({ b: at(bar, beat) })) },
  ],
}
writeFileSync(join(out, `${NAME}.score.json`), JSON.stringify(score) + '\n')
writeMidi(join(out, `${NAME}.mid`), { withEnd: true })
const counts = Object.fromEntries(score.tracks.map((t) => [t.fx ?? t.instrument, t.notes.length]))
console.log(`score: ${BEATS} beats = ${(BEATS * 60) / S.BPM}s`, counts)

// ── 渲染音频 ────────────────────────────────────────────────────────────────
if (process.argv.includes('--no-audio')) process.exit(0)
const SF = process.env.SOUNDFONT ?? join(homedir(), 'Library/Audio/Sounds/Banks/GeneralUser-GS.sf2')
if (!existsSync(SF)) throw new Error(`soundfont not found: ${SF} (set SOUNDFONT=...)`)
const tmp = join(out, '.tmp'); mkdirSync(tmp, { recursive: true })
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
// 大厅混响：房间大、衰减慢，钢片琴和管钟的尾巴拖在后面 = 塔里的空旷
const synth = (mid, wav) => run('fluidsynth', ['-ni', '-q', '-g', '0.6', '-r', '48000', '-o', 'synth.reverb.room-size=0.9', '-o', 'synth.reverb.damp=0.3',
  '-o', 'synth.reverb.width=1.0', '-o', 'synth.reverb.level=0.85', '-o', 'synth.chorus.active=0', '-F', wav, SF, mid])
const BAR_SEC = (S.METER * 60) / S.BPM
const LOOP_SEC = S.BARS * BAR_SEC
const FULL_SEC = LOOP_SEC + BAR_SEC + 4.5
// 循环版：渲两遍，取第二遍 → 开头带着上一遍的混响尾巴，首尾接上听不出缝
writeMidi(join(tmp, 'x2.mid'), { repeats: 2 })
synth(join(tmp, 'x2.mid'), join(tmp, 'x2.wav'))
// 完整版：一遍 + 尾声小节 + 余音
writeMidi(join(tmp, 'x1.mid'), { withEnd: true })
synth(join(tmp, 'x1.mid'), join(tmp, 'x1.wav'))

// 安静的曲子：只削掉极低频、很轻的压缩（1.4:1），整体对到 -16 LUFS（比流行歌轻，留着动态）
const TARGET = -16
const BUS = 'highpass=f=35,equalizer=f=280:t=q:w=1:g=-1.5,equalizer=f=9000:t=q:w=1:g=1,acompressor=threshold=-22dB:ratio=1.4:attack=40:release=400:makeup=1'
// 母带：先量整体响度，再整体加一个固定增益，最后限幅器只削峰（不用 loudnorm 的动态模式：它会把段落的起伏拉平）
function master(src, dst, [from, to], fadeOut = 0) {
  const pre = `atrim=start=${from}:end=${to},asetpts=N/SR/TB,${BUS}`
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', src, '-af', `${pre},ebur128`, '-f', 'null', '-'], { encoding: 'utf8' })
  const I = Number(/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/.exec(probe.stderr)[1])
  const gain = (TARGET - I).toFixed(2)
  const fade = fadeOut ? `,afade=t=out:st=${to - from - fadeOut}:d=${fadeOut}` : ''
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-af', `${pre},volume=${gain}dB,alimiter=limit=0.89:attack=5:release=80:level=false${fade}`, '-ar', '48000', '-c:a', 'pcm_s16le', dst + '.wav'])
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', dst + '.wav', '-c:a', 'aac', '-b:a', '192k', dst + '.m4a'])
}
master(join(tmp, 'x2.wav'), join(out, `${NAME}-loop`), [LOOP_SEC, LOOP_SEC * 2])
master(join(tmp, 'x1.wav'), join(out, `${NAME}-full`), [0, FULL_SEC], 3.5)
// 分轨（--stems）：每条轨单独渲一遍（完整版），未压缩、未母带，拖进 DAW 自己混
if (process.argv.includes('--stems')) {
  const dir = join(out, 'stems'); mkdirSync(dir, { recursive: true })
  for (const [i, tr] of TRACKS.entries()) {
    const slug = `${String(i + 1).padStart(2, '0')}-${tr.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
    writeMidi(join(tmp, 's.mid'), { withEnd: true, only: tr })
    synth(join(tmp, 's.mid'), join(dir, `${slug}.wav`))
  }
  console.log('stems:', dir)
}
rmSync(tmp, { recursive: true, force: true })
console.log(`audio: loop ${LOOP_SEC}s, full ${FULL_SEC}s →`, join(out, `${NAME}-loop.m4a`), join(out, `${NAME}-full.m4a`))
