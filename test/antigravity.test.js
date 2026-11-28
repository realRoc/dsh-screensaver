// Antigravity 会话：步骤 protobuf 里找工具调用、最后一步折成进展、AgentWatcher 只认 presence 锁被开着的会话。
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentWatcher, agTail, agTool, agToolCall, sqliteAll } from '../app/agents.js'

const HOME = fileURLToPath(new URL('../node_modules/.cache/antigravity-test', import.meta.url))
const AG = join(HOME, '.gemini', 'antigravity')
afterEach(() => rmSync(HOME, { recursive: true, force: true }))

// ---------------------------------------------------------------- 手写 protobuf（跟 Antigravity 存的结构一样：工具调用是 {1: call_…, 2: 名字, 3: JSON}）
const varint = (n) => {
  const b = []
  while (n > 127) {
    b.push((n & 127) | 128)
    n = Math.floor(n / 128)
  }
  b.push(n)
  return Buffer.from(b)
}
const fld = (f, v) => {
  if (typeof v === 'number') return Buffer.concat([varint(f * 8), varint(v)])
  const b = Buffer.from(v)
  return Buffer.concat([varint(f * 8 + 2), varint(b.length), b])
}
const msg = (...parts) => Buffer.concat(parts)
const call = (name, args) => msg(fld(1, 'call_13985676773341849343'), fld(2, name), fld(3, JSON.stringify(args)))
/** 一步：外面套几层别的字段，工具调用藏在里面 */
const payload = (...calls) => msg(fld(12, '0aa6c328-9d4a-42d5-aa2d-546e2880c261'), fld(4, 7), fld(20, msg(fld(1, 'meta'), ...calls.map((c) => fld(9, c)))))

const STEP = { USER_INPUT: 14, PLANNER: 15, ERROR_MESSAGE: 17, GENERIC: 132 }
const ST = { DONE: 3, CANCELED: 6 }

describe('步骤里的工具调用', () => {
  it('不管套几层都找得到，取最后一个', () => {
    const buf = payload(call('read_file', { Path: '/a/b.ts' }), call('run_command', { CommandLine: 'npm test' }))
    expect(agToolCall(buf)).toEqual({ name: 'run_command', args: '{"CommandLine":"npm test"}' })
    expect(agToolCall(msg(fld(1, 'hello'), fld(2, 3)))).toBeNull()
    expect(agToolCall(Buffer.from([0xff, 0xff]))).toBeNull() // 不是 protobuf
  })

  it('参数名大写开头，命令去掉 cd、路径只留文件名', () => {
    expect(agTool('run_command', JSON.stringify({ CommandLine: 'cd /Users/me/proj && npm test', WaitMsBeforeAsync: 500 }))).toBe('run_command npm test')
    expect(agTool('read_file', { Path: '/Users/me/proj/app/agents.js', StartLine: 1 })).toBe('read_file agents.js')
    expect(agTool('edit_file', { Path: '/x/y/saver.js', Target: 'a', Replacement: 'b' })).toBe('edit_file saver.js')
    expect(agTool('search_web', { query: 'protobuf wire format' })).toBe('search_web protobuf wire format')
    expect(agTool('update_focus', '不是 JSON')).toBe('update_focus')
  })

  it('最后一步 → 进展、等不等人、怎么结束的', () => {
    const tool = { step_type: STEP.GENERIC, status: ST.DONE, step_payload: payload(call('edit_file', { Path: '/p/main.js' })) }
    expect(agTail(tool)).toEqual({ progress: 'edit_file main.js', waiting: false, ended: 'done' })
    // 模型打算调工具（还没跑完，所以库里还没有那一步）= 正在调
    const plan = { step_type: STEP.PLANNER, status: ST.DONE, step_payload: payload(call('run_command', { CommandLine: 'npm run build' })) }
    expect(agTail(plan).progress).toBe('run_command npm run build')
    const ask = { step_type: STEP.PLANNER, status: ST.DONE, step_payload: payload(call('ask_question', { questions: [] })) }
    expect(agTail(ask, 'en')).toMatchObject({ progress: 'Waiting for your answer', waiting: true })
    expect(agTail({ step_type: STEP.PLANNER, status: ST.DONE, step_payload: payload() }, 'en').progress).toBe('Replying…')
    expect(agTail({ step_type: STEP.USER_INPUT, status: ST.DONE, step_payload: null }, 'en').progress).toBe('Thinking…')
    expect(agTail({ ...tool, status: ST.CANCELED }).ended).toBe('aborted')
    expect(agTail({ step_type: STEP.ERROR_MESSAGE, status: ST.DONE, step_payload: payload() }).ended).toBe('aborted')
    expect(agTail(undefined, 'en')).toEqual({ progress: 'Thinking…', waiting: false, ended: 'done' })
  })
})

// ---------------------------------------------------------------- 本机目录
function summaries(rows) {
  mkdirSync(AG, { recursive: true })
  const db = new DatabaseSync(join(AG, 'conversation_summaries.db'))
  db.exec(`create table if not exists conversation_summaries (conversation_id text primary key, title text not null default '',
    status text not null default '', workspace_uris text not null default '[]', parent_conversation_id text not null default '',
    nesting_depth integer not null default 0, killed numeric not null default false, last_user_input_time datetime not null default '')`)
  db.exec('delete from conversation_summaries')
  const ins = db.prepare(`insert into conversation_summaries (conversation_id, title, status, workspace_uris, parent_conversation_id, nesting_depth, killed, last_user_input_time)
    values (?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const r of rows)
    ins.run(r.id, r.title ?? '', r.status ?? 'CASCADE_RUN_STATUS_RUNNING', r.ws ?? '["file:///Users/me/proj"]', r.parent ?? '', r.depth ?? 0, r.killed ? 1 : 0, r.started ?? '2026-11-28 11:31:02.03013+00:00')
  db.close()
}
function steps(id, rows) {
  mkdirSync(join(AG, 'conversations'), { recursive: true })
  const db = new DatabaseSync(join(AG, 'conversations', `${id}.db`))
  db.exec('create table if not exists steps (idx integer primary key, step_type integer not null default 0, status integer not null default 0, step_payload blob)')
  db.exec('delete from steps')
  const ins = db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)')
  rows.forEach((r, i) => ins.run(i, r.step_type, r.status ?? ST.DONE, r.step_payload ?? null))
  db.close()
}
function lock(id, mtime = Date.now()) {
  mkdirSync(join(AG, 'presence'), { recursive: true })
  const p = join(AG, 'presence', `${id}.lock`)
  writeFileSync(p, '')
  utimesSync(p, mtime / 1000, mtime / 1000)
  return p
}
const A = '2b95b63e-5d91-44f0-af24-ae444a946324'
const B = '2291ac82-8725-4926-897a-9e90d29891d2'
const C = '80d8542d-9085-41da-b045-aa55ff344a4a'

describe('AgentWatcher 读 Antigravity', () => {
  it('presence 锁被开着才算在跑；锁放了看最后一步：完成 / 中断', () => {
    summaries([{ id: A, title: '模型与渠道记分板扩展' }, { id: B, title: 'Git Branch Cleanup', status: 'CASCADE_RUN_STATUS_IDLE' }])
    steps(A, [{ step_type: STEP.USER_INPUT }, { step_type: STEP.GENERIC, step_payload: payload(call('run_command', { CommandLine: 'npm test' })) }])
    steps(B, [{ step_type: STEP.USER_INPUT }])
    const la = lock(A)
    lock(B) // 没人开着：空闲的会话，不管
    let held = new Set([la])
    const w = new AgentWatcher({ home: HOME, agLocks: () => held, dshLocks: () => new Set(), alive: () => false, codexAlive: () => false, now: () => 9999 })
    expect(w.poll()).toEqual([
      { id: `antigravity:${A}`, kind: 'antigravity', name: '模型与渠道记分板扩展', status: 'running', progress: 'run_command npm test', startedAt: Date.parse('2026-11-28T11:31:02.030Z') },
    ])

    // 跑完：会话还开着（锁不放），摘要表写成 IDLE → 已完成
    steps(A, [{ step_type: STEP.USER_INPUT }, { step_type: STEP.PLANNER, step_payload: payload() }])
    summaries([{ id: A, title: '模型与渠道记分板扩展', status: 'CASCADE_RUN_STATUS_IDLE' }])
    expect(w.poll()[0]).toMatchObject({ status: 'done', progress: '本轮完成', endedAt: 9999 })

    // 再开一轮，跑着跑着 Antigravity 退了（锁放了，摘要表还写着 RUNNING）
    summaries([{ id: A, title: '模型与渠道记分板扩展' }])
    expect(w.poll()[0].status).toBe('running')
    held = new Set()
    expect(w.poll()[0].status).toBe('done')

    // 再开一轮，被停了
    held = new Set([la])
    expect(w.poll()[0].status).toBe('running')
    steps(A, [{ step_type: STEP.GENERIC, status: ST.CANCELED, step_payload: payload(call('run_command', { CommandLine: 'sleep 99' })) }])
    held = new Set()
    expect(w.poll()[0]).toMatchObject({ status: 'aborted', progress: '被中断' })
  })

  it('等你回答、被杀掉、subagent、摘要表里还没有、开着但空闲', () => {
    const E = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee'
    summaries([{ id: A, title: '问问题' }, { id: B, parent: A, depth: 1 }, { id: C, killed: true, title: '被杀' }, { id: E, status: 'CASCADE_RUN_STATUS_IDLE' }])
    steps(A, [{ step_type: STEP.PLANNER, step_payload: payload(call('ask_question', { questions: ['?'] })) }])
    const D = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const T = Date.now() - 60_000
    const held = new Set([lock(A), lock(B), lock(C), lock(D, T), lock(E)])
    const w = new AgentWatcher({ home: HOME, agLocks: () => held, dshLocks: () => new Set(), alive: () => false, codexAlive: () => false, lang: 'en' })
    const got = w.poll()
    // 只有 A：B 是 subagent，C 被杀了，D 摘要表里还没有（等它写进来），E 开着但空闲
    expect(got.map((s) => [s.id.slice(12, 20), s.status, s.name, s.progress])).toEqual([['2b95b63e', 'waiting', '问问题', 'Waiting for your answer']])
    summaries([{ id: D, title: '' }])
    expect(w.poll().find((s) => s.id.endsWith(D))).toMatchObject({ status: 'running', name: 'proj', startedAt: Date.parse('2026-11-28T11:31:02.030Z') })
  })

  it('很久以前的锁不去 lsof；没有 Antigravity 目录就是空的', () => {
    lock(A, Date.now() - 30 * 86400_000)
    const asked = []
    const w = new AgentWatcher({ home: HOME, agLocks: (p) => (asked.push(...p), new Set(p)), dshLocks: () => new Set(), alive: () => false, codexAlive: () => false })
    expect(w.poll()).toEqual([])
    expect(asked).toEqual([])
    expect(new AgentWatcher({ home: join(HOME, 'nobody'), dshLocks: () => new Set() }).antigravity()).toEqual([])
  })

  it('SQLite 只读打开：库在 WAL 模式、没有 -shm 也读得到', () => {
    summaries([{ id: A, title: 'wal' }])
    const db = new DatabaseSync(join(AG, 'conversation_summaries.db'))
    db.exec('pragma journal_mode = wal')
    db.close() // 关掉时合并完、删掉 -wal / -shm：只读打不开，要按不可变文件读
    expect(sqliteAll(join(AG, 'conversation_summaries.db'), 'select title from conversation_summaries')).toEqual([{ title: 'wal' }])
    expect(sqliteAll(join(AG, 'nope.db'), 'select 1')).toBeNull()
  })
})
