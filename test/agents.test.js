// 本机 Claude Code / Codex 会话：解析记录文件、屏保这一轮里跟踪会话从「在跑」到「已完成 / 已中断」。
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentWatcher, claudeTail, codexNames, codexTail, describeTool, shortCmd } from '../app/agents.js'

const HOME = fileURLToPath(new URL('../node_modules/.cache/agents-test', import.meta.url))
afterEach(() => rmSync(HOME, { recursive: true, force: true }))

const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const assistant = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } })
const ev = (type, ts = '2026-11-14T10:00:00.000Z', extra = {}) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type, ...extra },
})

describe('一行进展', () => {
  it('常用工具说人话，路径只留文件名', () => {
    expect(describeTool('Edit', { file_path: '/a/b/src/main/saver.ts' })).toBe('编辑 saver.ts')
    expect(describeTool('Grep', { pattern: 'sessionStatus' })).toBe('搜索 "sessionStatus"')
    expect(describeTool('mcp__foo__do_thing', {})).toBe('do_thing')
    expect(describeTool('Bash', { command: 'cd /Users/me/proj && npm test' })).toBe('Bash npm test')
  })

  it('英文系统用英文', () => {
    expect(describeTool('Edit', { file_path: '/a/b.ts' }, 'en')).toBe('Edit b.ts')
    expect(claudeTail([], 'en').progress).toBe('Thinking…')
    expect(codexTail(jl(ev('task_started')).trim().split('\n'), 'en').progress).toBe('Reasoning…')
  })

  it('命令里的绝对路径只留最后一段', () => {
    expect(shortCmd('node /Users/me/proj/scripts/build.mjs --watch')).toBe('node build.mjs --watch')
    expect(shortCmd('cat ~/.codex/session_index.jsonl')).toBe('cat session_index.jsonl')
  })
})

describe('Claude Code 记录', () => {
  it('取最后一次工具调用', () => {
    const lines = jl(
      assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/x/a.ts' } }),
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      assistant({ type: 'thinking' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm run typecheck' } }),
    )
      .trim()
      .split('\n')
    expect(claudeTail(lines)).toEqual({ progress: 'Bash npm run typecheck', interrupted: false })
  })

  it('最后是用户打断', () => {
    const lines = jl(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'sleep 99' } }), {
      type: 'user',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    })
      .trim()
      .split('\n')
    expect(claudeTail(lines).interrupted).toBe(true)
  })

  it('坏行跳过，什么都没有就是在思考', () => {
    expect(claudeTail(['{坏的', ''])).toEqual({ progress: '思考中…', interrupted: false })
  })
})

describe('Codex 记录', () => {
  it('task_started 之后没结束就是在跑，进展取最后一次工具调用', () => {
    const lines = jl(ev('task_complete'), ev('task_started', '2026-11-14T10:05:00.000Z'), {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: 'const r = await tools.exec_command({ cmd: "npx vitest run", workdir: "/x" })',
      },
    })
      .trim()
      .split('\n')
    expect(codexTail(lines)).toEqual({
      state: 'running',
      progress: 'exec npx vitest run',
      startedAt: Date.parse('2026-11-14T10:05:00.000Z'),
    })
  })

  it('结束 / 中断', () => {
    expect(codexTail(jl(ev('task_started'), ev('task_complete')).trim().split('\n')).state).toBe('done')
    expect(codexTail(jl(ev('task_started'), ev('turn_aborted')).trim().split('\n')).state).toBe('aborted')
    expect(codexTail([]).state).toBe('unknown')
  })

  it('旧版 function_call 的命令数组、apply_patch', () => {
    const fc = (args) =>
      jl(ev('task_started'), {
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify(args) },
      })
        .trim()
        .split('\n')
    expect(codexTail(fc({ command: ['bash', '-lc', 'ls'] })).progress).toBe('exec bash -lc ls')
    expect(codexTail(fc({ input: '*** Begin Patch\n...' })).progress).toBe('apply_patch')
  })

  it('线程名：同一个 id 后写的为准', () => {
    const names = codexNames(
      jl({ id: 'a', thread_name: '旧名字' }, { id: 'a', thread_name: '新名字' }, { id: 'b', thread_name: '  ' })
        .trim()
        .split('\n'),
    )
    expect([...names]).toEqual([['a', '新名字']])
  })
})

describe('屏保这一轮的会话列表', () => {
  const ID = '01a1da17-3d6f-74c0-8baf-e2001d627ce3'
  function claudeMeta(pid, status, extra = {}) {
    mkdirSync(join(HOME, '.claude', 'sessions'), { recursive: true })
    writeFileSync(
      join(HOME, '.claude', 'sessions', `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: `s-${pid}`,
        cwd: '/w/proj',
        name: `会话${pid}`,
        status,
        statusUpdatedAt: 1000 + pid,
        ...extra,
      }),
    )
  }
  function claudeTranscript(pid, rows) {
    const dir = join(HOME, '.claude', 'projects', '-w-proj')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `s-${pid}.jsonl`), rows)
  }
  /** 写一份 rollout，放在 daysAgo 天前那天的目录里；mtime 是最后写入时间 */
  function codexRollout(rows, daysAgo = 0, mtime) {
    const d = new Date(Date.now() - daysAgo * 86400_000)
    const dir = join(
      HOME,
      '.codex',
      'sessions',
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    )
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `rollout-2026-11-14T10-00-00-${ID}.jsonl`)
    writeFileSync(path, jl({ type: 'session_meta', payload: { cwd: '/w/codex-proj' } }) + rows)
    if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000)
    return path
  }
  const codexW = (codexAlive, now = Date.now) => new AgentWatcher({ home: HOME, codexAlive, now })

  it('在跑的进列表；空闲的不进；跑完标「已完成」，开始时间不变', () => {
    const alive = new Set([1, 2])
    const w = new AgentWatcher({ home: HOME, alive: (p) => alive.has(p), now: () => 9999 })
    claudeMeta(1, 'busy')
    claudeMeta(2, 'idle')
    claudeTranscript(1, jl(assistant({ type: 'tool_use', name: 'Edit', input: { file_path: '/w/proj/a.ts' } })))
    expect(w.poll()).toEqual([
      { id: 'claude:s-1', kind: 'claude', name: '会话1', status: 'running', progress: '编辑 a.ts', startedAt: 1001 },
    ])

    claudeMeta(1, 'idle', { statusUpdatedAt: 5000 })
    expect(w.poll()).toEqual([
      { id: 'claude:s-1', kind: 'claude', name: '会话1', status: 'done', progress: '本轮完成', startedAt: 1001, endedAt: 9999 },
    ])
  })

  it('进程没了、或者被用户打断：已中断', () => {
    const alive = new Set([3, 4])
    const w = new AgentWatcher({ home: HOME, alive: (p) => alive.has(p) })
    claudeMeta(3, 'busy')
    claudeMeta(4, 'busy')
    expect(w.poll().map((s) => s.status)).toEqual(['running', 'running'])
    alive.delete(3)
    claudeMeta(4, 'idle')
    claudeTranscript(4, jl({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))
    expect(w.poll().map((s) => [s.id, s.status])).toEqual([
      ['claude:s-3', 'aborted'],
      ['claude:s-4', 'aborted'],
    ])
  })

  it('Codex：名字没登记就用工作目录名，task_complete 之后是已完成', () => {
    const w = codexW(() => true)
    codexRollout(jl(ev('task_started', new Date().toISOString())))
    const [s] = w.poll()
    expect(s).toMatchObject({ id: `codex:${ID}`, kind: 'codex', name: 'codex-proj', status: 'running', progress: '推理中…' })

    mkdirSync(join(HOME, '.codex'), { recursive: true })
    writeFileSync(join(HOME, '.codex', 'session_index.jsonl'), jl({ id: ID, thread_name: '迁移 vite' }))
    codexRollout(jl(ev('task_started'), ev('task_complete')))
    expect(w.poll()[0]).toMatchObject({ name: '迁移 vite', status: 'done' })
  })

  it('Codex 跑过午夜好几天：开始那天的目录不在今天、昨天，照样认得出在跑', () => {
    codexRollout(jl(ev('task_started')), 3)
    expect(codexW(() => true).poll()).toMatchObject([{ id: `codex:${ID}`, status: 'running' }])
  })

  it('跟踪中的 Codex 会话：文件所在的目录早就超出扫描范围了，也接着读，不会被当成中断', () => {
    let now = Date.now()
    const w = codexW(
      () => true,
      () => now,
    )
    const path = codexRollout(jl(ev('task_started')))
    expect(w.poll()[0].status).toBe('running')
    now += 9 * 86400_000 // 九天后，这个文件还在写
    utimesSync(path, now / 1000, now / 1000)
    expect(w.poll()).toMatchObject([{ id: `codex:${ID}`, status: 'running' }])
  })

  it('Codex 半天没写：还有 codex 进程（可能在等人确认）就当还在跑，一个都没有就是中断了', () => {
    const now = Date.now()
    codexRollout(jl(ev('task_started')), 0, now - 45 * 60_000)
    let alive = true
    const w = codexW(
      () => alive,
      () => now,
    )
    expect(w.poll()[0].status).toBe('running')
    alive = false
    expect(w.poll()[0]).toMatchObject({ status: 'aborted', endedAt: now })
  })

  it('一个 codex 进程都没有、刚写过：还算在跑；没进程又两分钟没写：不算', () => {
    const now = Date.now()
    codexRollout(jl(ev('task_started')), 0, now - 30_000)
    expect(
      codexW(
        () => false,
        () => now,
      ).poll()[0].status,
    ).toBe('running')
    codexRollout(jl(ev('task_started')), 0, now - 3 * 60_000)
    expect(
      codexW(
        () => false,
        () => now,
      ).poll(),
    ).toEqual([])
  })

  it('屏保反复开关：每次开都是新的一轮，上一轮结束的会话不带过来；有变化才回调', () => {
    vi.useFakeTimers()
    try {
      const alive = new Set([7])
      const w = new AgentWatcher({ home: HOME, alive: (p) => alive.has(p), codexAlive: () => true })
      const calls = []
      const on = (list) => calls.push(list.map((s) => `${s.id}:${s.status}`))
      claudeMeta(7, 'busy')
      w.start(on, 1000)
      vi.advanceTimersByTime(3000) // 没变化：不再回调
      claudeMeta(7, 'idle')
      vi.advanceTimersByTime(1000)
      w.stop()
      expect(calls).toEqual([['claude:s-7:running'], ['claude:s-7:done']])
      expect(w.sessions).toEqual([])

      w.start(on, 1000) // 再开：上一轮已完成的不在列表里
      expect(calls.at(-1)).toEqual([])
      claudeMeta(7, 'busy')
      vi.advanceTimersByTime(1000)
      expect(calls.at(-1)).toEqual(['claude:s-7:running'])
      w.stop()
      vi.advanceTimersByTime(5000) // 关了就不再读
      expect(calls).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('什么都没装：空列表', () => {
    expect(new AgentWatcher({ home: join(HOME, 'nobody') }).poll()).toEqual([])
  })
})
