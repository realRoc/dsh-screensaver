import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { compileScore, DEMO_SCORE, FX_LEAD, FX_NAMES, INSTRUMENT_FX, makeCursor, normPitch, sectionAt } from '../themes/magic-tower/src/score.js'

describe('magic-tower score → fx cues', () => {
  it('turns beats into seconds and maps instruments to their default effect', () => {
    const { cues, skipped } = compileScore({
      bpm: 120, offset: 0.5,
      tracks: [
        { instrument: 'kick', notes: [0, 1] },
        { instrument: 'lead', notes: [{ b: 2, v: 0.4, p: 72, d: 2 }] },
        { instrument: 'kazoo', notes: [0] },
        { instrument: 'kazoo', fx: 'glitter', notes: [3] },
      ],
    })
    expect(skipped).toEqual(['kazoo'])
    expect(cues.map((c) => [c.t, c.fx])).toEqual([[0.5, 'beam'], [1, 'beam'], [1.5, 'comet'], [2, 'glitter']])
    expect(cues[2]).toMatchObject({ v: 0.4, d: 1, p: 0.6 })
  })

  it('normalises pitch from 0..1 or MIDI note numbers', () => {
    expect(normPitch(0.25)).toBe(0.25)
    expect(normPitch(36)).toBe(0)
    expect(normPitch(96)).toBe(1)
    expect(normPitch(undefined)).toBe(0.5)
  })

  it('rejects a score without a tempo', () => {
    expect(() => compileScore({ tracks: [] })).toThrow(/bpm/)
  })

  it('the cursor hands out each cue once, in order, across frames', () => {
    const cur = makeCursor(compileScore({ bpm: 60, tracks: [{ instrument: 'snare', notes: [0, 1, 2] }] }))
    expect(cur.advance(0).map((c) => c.t)).toEqual([0])
    expect(cur.advance(0.5)).toEqual([])
    expect(cur.advance(2.0).map((c) => c.t)).toEqual([1, 2])
    expect(cur.advance(5)).toEqual([])
  })

  it('a looping score replays from the top after the loop point', () => {
    const cur = makeCursor(compileScore({ bpm: 60, loopBeats: 4, tracks: [{ instrument: 'kick', notes: [0, 3] }] }))
    expect(cur.advance(0).map((c) => c.t)).toEqual([0])
    expect(cur.advance(3.5).map((c) => c.t)).toEqual([3])
    expect(cur.advance(4.2).map((c) => c.t)).toEqual([0])   // wrapped: beat 0 of the second pass
    expect(cur.advance(7.1).map((c) => c.t)).toEqual([3])
  })

  it('a looping score plays nothing during the pre-roll and only beat 0 when it starts', () => {
    const cur = makeCursor(compileScore({ bpm: 60, loopBeats: 4, tracks: [{ instrument: 'kick', notes: [0, 3.8] }] }))
    expect(cur.advance(-0.5)).toEqual([])
    expect(cur.advance(-0.1)).toEqual([])
    expect(cur.advance(0.05).map((c) => c.t)).toEqual([0])
  })

  it('stepping the demo groove through its pre-roll at 60 fps never fires the end of the loop early', () => {
    const cur = makeCursor(compileScore(DEMO_SCORE))
    const fired = []
    for (let t = -0.5; t < 0.05; t += 1 / 60) fired.push(...cur.advance(t).map((c) => c.t))
    expect(fired.length).toBeGreaterThan(0)
    expect(fired.every((t) => t < 0.05)).toBe(true)
  })

  it('a looping score with an offset plays the notes near the end of the loop on every pass', () => {
    const cur = makeCursor(compileScore({ bpm: 60, offset: 0.5, loopBeats: 4, tracks: [{ instrument: 'kick', notes: [0, 3.75] }] }))
    const fired = []
    for (let t = 0; t < 8.9; t += 0.1) fired.push(...cur.advance(t).map((c) => c.t))
    expect(fired.filter((t) => t === 4.25).length).toBe(2)       // 3.75 beats + 0.5 s offset, once per pass
  })

  it('with maxLag, a big jump skips the cues it is too late for instead of firing them all at once', () => {
    const cur = makeCursor(compileScore({ bpm: 60, tracks: [{ instrument: 'kick', notes: [0, 1, 2, 3] }] }), { maxLag: 0.25 })
    expect(cur.advance(0).map((c) => c.t)).toEqual([0])
    expect(cur.advance(2.5)).toEqual([])          // beats 1 and 2 are 1.5 s and 0.5 s late
    expect(cur.advance(3.1).map((c) => c.t)).toEqual([3])
  })

  it('the demo groove only uses known effects and every effect has an instrument', () => {
    const { cues, skipped, loop } = compileScore(DEMO_SCORE)
    expect(skipped).toEqual([])
    expect(loop).toBeCloseTo(32 * 60 / 112)
    expect(cues.every((c) => FX_NAMES.includes(c.fx) && c.t >= 0 && c.t < loop)).toBe(true)
    expect(new Set(Object.values(INSTRUMENT_FX))).toEqual(new Set(FX_NAMES))
  })
})

describe('magic-tower score: lead-in, sections and the Star Well BGM', () => {
  it('starts wound-up events early so their hit lands on the beat, wrapping into the previous pass of a loop', () => {
    const { cues } = compileScore({ bpm: 60, loopBeats: 8, tracks: [{ instrument: 'impact', notes: [4, 0.5] }, { instrument: 'crash', notes: [2] }] })
    const slash4 = cues.find((c) => c.fx === 'slash' && c.hit === 4)
    expect(slash4.t).toBeCloseTo(4 - FX_LEAD.slash)
    expect(cues.find((c) => c.fx === 'slash' && c.hit === 0.5).t).toBeCloseTo(8 + 0.5 - FX_LEAD.slash)   // 0.5 - 1.28 < 0 → end of the loop
    expect(cues.find((c) => c.fx === 'swell').t).toBeCloseTo(2 - FX_LEAD.swell)
    expect(cues.every((c, i) => i === 0 || c.t >= cues[i - 1].t)).toBe(true)
  })

  it('finds the section a score time falls in, modulo the loop', () => {
    const c = compileScore({ bpm: 60, loopBeats: 8, sections: [{ name: 'a', b: 0, mood: 'walk' }, { name: 'b', b: 4, mood: 'freeze' }], tracks: [] })
    expect(sectionAt(c, -1)).toBeNull()
    expect(sectionAt(c, 0).name).toBe('a')
    expect(sectionAt(c, 4).mood).toBe('freeze')
    expect(sectionAt(c, 9).name).toBe('a')
    expect(sectionAt(c, 13.5).name).toBe('b')
    expect(sectionAt(compileScore({ bpm: 60, tracks: [] }), 3)).toBeNull()
  })

  const bgm = JSON.parse(readFileSync(new URL('../themes/magic-tower/music/out/star-well.score.json', import.meta.url), 'utf8'))
  const compiled = compileScore(bgm)
  const rate = (name) => {
    const i = compiled.sections.findIndex((s) => s.name === name), a = compiled.sections[i].t, b = compiled.sections[i + 1]?.t ?? compiled.loop
    return compiled.cues.filter((c) => c.hit >= a && c.hit < b).length / (b - a)
  }

  it('the bundled BGM visual score compiles whole: 34 bars of 3/4 at 72 BPM = 85 s, nothing skipped', () => {
    expect(compiled.skipped).toEqual([])
    expect(compiled.loop).toBe(85)
    expect(compiled.sections.map((s) => s.mood)).toEqual(['calm', 'calm', 'full', 'walk', 'hush', 'walk'])
  })

  it('stays quiet: under two effects a second, no drum effects, big events never overlap', () => {
    expect(compiled.cues.length / compiled.loop).toBeLessThan(2)
    expect(compiled.cues.filter((c) => ['beam', 'sigil', 'glitter', 'shower'].includes(c.fx))).toEqual([])
    const LEN = { slash: 1.4 + 2.7 + 1.8, swell: 2.6 }                 // the sword includes the camera turning up and back
    const big = compiled.cues.filter((c) => c.fx in LEN)
    expect(big.map((c) => c.fx)).toEqual(['slash', 'swell', 'slash'])
    big.forEach((c, i) => { if (i) expect(c.t).toBeGreaterThanOrEqual(big[i - 1].t + LEN[big[i - 1].fx]) })
  })

  it('the first sword lands on the top of the rise, after the climb into the tower has begun', () => {
    const rise = compiled.sections.find((s) => s.name === 'rise').t
    const sword = compiled.cues.find((c) => c.fx === 'slash')
    expect(rise).toBe(15)
    expect(sword.hit).toBe(25)
    expect(sword.t).toBeGreaterThan(rise + 4.2)          // the camera starts turning up once the enter transition (4.2 s) is over
  })

  it('the picture follows the music: the rise is the busiest, the breath and the intro the stillest', () => {
    expect(rate('rise')).toBeGreaterThan(rate('A'))
    expect(rate('breath')).toBeLessThan(rate('A'))
    expect(rate('intro')).toBeLessThan(rate('A'))
  })
})
