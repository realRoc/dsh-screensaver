// 乐谱 → 特效时间表。先有一首带节奏的原创 BGM，每种乐器对应一种塔里的特效：
// 把每条音轨的音符（拍号位置、力度、音高、时值）写成一份乐谱，播放时按时间把特效一个个打出来。
// 纯数据，不碰 three.js（单测见仓库根的 test/tower-score.test.js）。
//
// 乐谱格式：
//   {
//     bpm: 112,                 // 每分钟拍数
//     offset: 0.0,              // 第 0 拍在音频里的秒数（音频开头有空白时用）
//     loopBeats: 32,            // 可选：循环长度（拍）；不写就只放一遍
//     tracks: [
//       { instrument: 'kick', notes: [0, 1, 2, 3] },                    // 只写拍位
//       { instrument: 'lead', fx: 'comet', notes: [{ b: 4, v: 0.8, p: 0.6, d: 1 }] },   // b 拍位 v 力度 p 音高 d 时值（拍）
//     ],
//   }
// 音高 p 用 0..1（低 → 高），也可以直接写 MIDI 音符号（> 1 的数按 36..96 映射到 0..1）。

/** 乐器 → 默认特效。乐谱里某条音轨写了 fx 就用它的。 */
export const INSTRUMENT_FX = {
  kick: 'beam',      // 底鼓：塔顶一道光柱砸下，落点炸开一圈冲击波
  snare: 'sigil',    // 军鼓：井中闪现一面法阵，旋转、碎成光屑
  clap: 'sigil',
  hihat: 'glitter',  // 镲：一小簇星芒闪一下
  shaker: 'glitter',
  bass: 'ripple',    // 贝斯：一圈光环贴着书墙从下往上扫过
  pad: 'aurora',     // 铺底 / 弦乐：一条极光丝带绕着天井盘旋上升，音符多长就亮多久
  strings: 'aurora',
  choir: 'aurora',
  lead: 'comet',     // 主旋律：流星划过天井，音越高落点越高
  arp: 'chime',      // 琶音 / 钟琴：一点光沿着栏杆跑过去，路过的灯一盏盏亮
  bell: 'chime',
  pluck: 'chime',
  crash: 'swell',    // 镲片重音：星辉仪吸光后爆开一圈横贯塔身的脉冲
  impact: 'slash',   // 段落重拍：光之巨剑劈落
  fill: 'shower',    // 过门：星辉仪朝四面书墙连射彗星
}

/** 特效名单（塔里能触发的全部特效） */
export const FX_NAMES = ['beam', 'sigil', 'glitter', 'ripple', 'aurora', 'comet', 'chime', 'swell', 'slash', 'shower']

const clamp01 = (x) => Math.min(1, Math.max(0, x))
/** 音高：0..1 原样用；MIDI 音符号按 C2(36)..C7(96) 摊到 0..1 */
export function normPitch(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return 0.5
  return p > 1 ? clamp01((p - 36) / 60) : clamp01(p)
}

/**
 * 编译乐谱：返回按时间排好的 cue 列表 [{ t, fx, v, p, d, track }]（t、d 都是秒）。
 * 不认识的乐器、没写 fx、特效名不在 FX_NAMES 里的音轨整条跳过（记进 skipped）。
 */
export function compileScore(score) {
  const bpm = Number(score?.bpm)
  if (!(bpm > 0)) throw new Error('score.bpm must be a positive number')
  const spb = 60 / bpm, offset = Number(score.offset) || 0
  const cues = [], skipped = []
  for (const [i, tr] of (score.tracks ?? []).entries()) {
    const fx = tr.fx ?? INSTRUMENT_FX[tr.instrument]
    if (!FX_NAMES.includes(fx)) { skipped.push(tr.instrument ?? `track ${i}`); continue }
    for (const n of tr.notes ?? []) {
      const note = typeof n === 'number' ? { b: n } : n
      if (!Number.isFinite(note.b)) continue
      cues.push({
        t: offset + note.b * spb,
        fx,
        v: clamp01(note.v ?? tr.v ?? 1),
        p: normPitch(note.p ?? tr.p),
        d: Math.max(0, note.d ?? 0) * spb,
        track: tr.instrument ?? fx,
      })
    }
  }
  cues.sort((a, b) => a.t - b.t)
  const loop = Number(score.loopBeats) > 0 ? score.loopBeats * spb : 0
  return { cues, skipped, loop, spb }
}

/**
 * 播放游标：每帧传入「乐谱时间」，返回从上一帧到这一帧之间该打的 cue。
 * 有 loop 时乐谱时间按循环长度取模；跨过循环点会把末尾和开头两段都吐出来。
 */
export function makeCursor(compiled) {
  const { cues, loop } = compiled
  let last = -Infinity
  const between = (a, b) => cues.filter((c) => c.t > a && c.t <= b)
  return {
    advance(t) {
      if (t <= last) { if (t < last) last = t - 1e-9; return [] }
      let out
      if (!loop || last === -Infinity) out = between(last === -Infinity ? -Infinity : last, loop ? t % loop : t)
      else {
        const a = ((last % loop) + loop) % loop, b = ((t % loop) + loop) % loop
        out = Math.floor(t / loop) > Math.floor(last / loop) ? [...between(a, loop), ...between(-Infinity, b)] : between(a, b)
      }
      last = t
      return out
    },
    reset() { last = -Infinity },
  }
}

/** 演示用的 8 小节节奏（112 BPM，循环）：还没有正式 BGM 时，在 #demo,groove 里看「先有节奏再配特效」的效果 */
const bars = (n, fn) => Array.from({ length: n }, (_, bar) => fn(bar)).flat()
export const DEMO_SCORE = {
  bpm: 112,
  loopBeats: 32,
  tracks: [
    { instrument: 'kick', notes: bars(8, (b) => [b * 4, b * 4 + 2.5].map((x) => ({ b: x, v: x % 4 === 0 ? 1 : 0.7 }))) },
    { instrument: 'snare', notes: bars(8, (b) => [b * 4 + 1, b * 4 + 3]) },
    { instrument: 'hihat', notes: bars(8, (b) => [0.5, 1.5, 2.5, 3.5].map((x) => ({ b: b * 4 + x, v: 0.6 }))) },
    { instrument: 'bass', notes: bars(4, (b) => [{ b: b * 8, v: 0.9, d: 3 }, { b: b * 8 + 4, v: 0.7, d: 3 }]) },
    // 铺底和弦：每 8 拍换一个和弦，三个音错开半拍进来（极光一个音一条丝带）
    { instrument: 'pad', notes: [[48, 55, 64], [45, 52, 60], [41, 48, 57], [43, 50, 59]].flatMap((ch, i) => ch.map((p, k) => ({ b: i * 8 + k * 0.5, d: 7 - k * 0.5, p, v: 0.8 }))) },
    { instrument: 'arp', notes: bars(2, (b) => [{ b: b * 16 + 6, p: 0.3 }, { b: b * 16 + 14, p: 0.7 }]) },
    { instrument: 'lead', notes: [{ b: 8, p: 60 }, { b: 9.5, p: 64 }, { b: 11, p: 67 }, { b: 24, p: 72 }, { b: 25.5, p: 67 }, { b: 27, p: 76 }] },
    { instrument: 'crash', notes: [{ b: 16 }] },
    { instrument: 'impact', notes: [{ b: 31 }] },
  ],
}
