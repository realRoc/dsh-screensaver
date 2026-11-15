// DeepSeek Harness 会话：zstd 多帧切分、事件折叠成状态、AgentWatcher 只认被进程锁着的会话。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentWatcher, dshFold, zstdFrames } from '../app/agents.js'

const HOME = fileURLToPath(new URL('../node_modules/.cache/dsh-test', import.meta.url))
afterEach(() => rmSync(HOME, { recursive: true, force: true }))

const T0 = Date.now() - 3_600_000
const header = (extra = {}) => ({ type: 'session', version: 4, id: 'session-1', createdAt: T0, cwd: '/Users/me/proj', ...extra })
let seq = 0
const ev = (type, data = {}, time = T0 + ++seq * 1000) => ({ type, seq, time, data })
const userMsg = (text) => ev('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' })
/** dsh 的写法：每批一个 zstd 帧 */
const frames = (...batches) => Buffer.concat(batches.map((rows) => zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'))))

describe('zstd 多帧', () => {
  it('每个帧都切出来，半截的最后一帧不要', () => {
    const buf = frames([header()], [ev('turn/start', { turn: 1 })], [ev('turn/end', { turn: 1, reason: { kind: 'completed' } })])
    expect(zstdFrames(buf)).toHaveLength(3)
    expect(zstdFrames(buf.subarray(0, buf.length - 3))).toHaveLength(2)
    const [, second] = zstdFrames(buf)
    expect(zstdFrames(buf, second[0])).toHaveLength(2) // 从上次读到的地方接着切
  })
})

describe('事件折叠', () => {
  it('这一轮在跑：名字取最新标题，进展取正在做的 todo，再不行取没结果的工具调用', () => {
    const base = [header(), userMsg('fix the flaky test'), ev('session/title', { title: 'Fix flaky test' }), ev('turn/start', { turn: 1 })]
    const call = ev('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"cd /Users/me/proj && npm test"}' })
    let f = dshFold([...base, call], 'en')
    expect(f).toMatchObject({ name: 'Fix flaky test', running: true, waiting: false, progress: 'bash npm test' })
    f = dshFold([...base, call, ev('todo/write', { todos: [{ content: 'Rerun CI', status: 'in_progress' }] })], 'en')
    expect(f.progress).toBe('Rerun CI')
  })

  it('没回复的 approval / 没回答的问题 = 等你确认', () => {
    const base = [header(), ev('turn/start', { turn: 1 })]
    expect(dshFold([...base, ev('approval/asked', { id: 'a', toolName: 'bash' })], 'en')).toMatchObject({
      waiting: true,
      progress: 'Needs approval: bash',
    })
    expect(dshFold([...base, ev('approval/asked', { id: 'a', toolName: 'bash' }), ev('approval/decided', { id: 'a' })], 'en').waiting).toBe(false)
    expect(dshFold([...base, ev('tool/call', { callId: 'q', name: 'ask_user_question' })], 'en')).toMatchObject({ waiting: true })
  })

  it('轮次结束：completed 算完成，aborted / error 算中断；subagent 会话标出来', () => {
    const run = (kind) => dshFold([header(), ev('turn/start', { turn: 1 }), ev('turn/end', { turn: 1, reason: { kind } })], 'en')
    expect(run('completed')).toMatchObject({ running: false, ended: 'done', progress: 'Turn finished' })
    expect(run('aborted')).toMatchObject({ running: false, ended: 'aborted' })
    expect(run('error')).toMatchObject({ ended: 'aborted', progress: 'Failed' })
    expect(dshFold([header({ origin: 'subagent' })]).child).toBe(true)
    expect(dshFold([header()], 'en').name).toBe('proj') // 没标题没提问：用工作目录名
  })
})

describe('AgentWatcher 读 dsh', () => {
  function session(id, batches) {
    const dir = join(HOME, '.dsh', 'sessions', '--Users-me-proj--', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.lock'), '')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frames(...batches))
    return dir
  }

  it('锁被进程开着、这一轮没结束才算在跑；锁放了就是结束', () => {
    const b1 = [header()]
    const b2 = [userMsg('ship it'), ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 })]
    const b3 = [ev('turn/end', { turn: 1, reason: { kind: 'completed' } })]
    const b4 = [ev('turn/start', { turn: 2 })]
    const dir = session('session-a', [b1, b2])
    session('session-old', [[header()], [ev('turn/start', { turn: 1 })]]) // 没人锁着：老会话，不管
    let held = new Set([join(dir, 'session.lock')])
    const w = new AgentWatcher({ home: HOME, now: () => Date.now(), dshLocks: () => held, lang: 'en', alive: () => false })
    expect(w.poll()).toEqual([{ id: 'dsh:session-a', kind: 'dsh', name: 'ship it', status: 'running', progress: 'Thinking…', startedAt: expect.any(Number) }])

    // 追加一帧：这一轮完成了，进程也还开着会话 → 已完成
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frames(b1, b2, b3))
    expect(w.poll()[0]).toMatchObject({ status: 'done', progress: 'Turn finished' })

    // 新一轮在跑时进程没了（锁放了）→ 中断
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frames(b1, b2, b3, b4))
    expect(w.poll()[0].status).toBe('running')
    held = new Set()
    expect(w.poll()[0]).toMatchObject({ status: 'aborted', progress: 'Stopped' })
  })
})
