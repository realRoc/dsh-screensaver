import { describe, expect, it } from 'vitest'
import { compileScore, DEMO_SCORE, FX_NAMES, INSTRUMENT_FX, makeCursor, normPitch } from '../themes/magic-tower/src/score.js'

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
