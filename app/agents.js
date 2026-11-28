// 本机在跑的 AI coding agent 会话（Claude Code / Codex / DeepSeek Harness）：屏保开着时每 2 秒看一眼，
// 给「亚空间跃迁」这类主题显示「哪些任务还在跑、跑到哪了」。
//
// 只读本机文件，不连网、不改任何东西：
// - Claude Code：~/.claude/sessions/<pid>.json 里有会话名和 status（busy = 正在跑），进程还活着才算；
//   进展取 ~/.claude/projects/<目录>/<sessionId>.jsonl 最后一次工具调用。
// - Codex：~/.codex/sessions/年/月/日/rollout-*.jsonl，最后一个 task_started 之后没有 task_complete / turn_aborted 就是在跑；
//   名字在 ~/.codex/session_index.jsonl（thread_name），没有就用工作目录名。
//   rollout 在会话开始那天的目录里，跑过午夜也一直写那个文件：所以看最近 7 天的目录，跟踪中的会话记住文件路径。
//   Codex 进程退出时不一定写得了结束记录，又不会一直开着 rollout，只能看「多久没写 + 本机还有没有 codex 进程」：
//   一个 codex 进程都没有，2 分钟没写就算中断；还有 codex 进程（可能在等人确认），6 小时没写才算。
// - DeepSeek Harness（dsh）：$DSH_HOME/sessions/<目录>/<会话>/session.v4.jsonl.zstd，只追加，每批写一个 zstd 帧。
//   会话被一个 dsh 进程打开时，那个进程一直用 flock 锁着同目录的 session.lock（进程没了内核就放锁，不会留死锁）：
//   有进程开着 session.lock（lsof）= 会话还在；最后一个 turn/start 后面没有 turn/end = 这一轮在跑；
//   还有没回复的 approval/asked、没回答的 ask_user_question = 等你确认。名字取最后一个 session/title。
// - Antigravity：~/.gemini/antigravity/presence/<会话>.lock，会话这一轮在跑时 language_server 一直开着它（lsof），
//   跑完、被停、Antigravity 退了就放掉（文件留着，每轮开始时刷新时间）：有进程开着 = 在跑。
//   名字、这一轮几点开始、是不是 subagent、有没有被杀掉，看 conversation_summaries.db（SQLite，Antigravity 自己的会话列表，
//   隔几步才写一次，所以不拿它判断在不在跑）。进展取 conversations/<会话>.db 最后一步里的工具调用
//   （protobuf：{1: call_…, 2: 工具名, 3: JSON 参数}）；步骤跑完才写进库，所以最后一步要是「打算调工具」，那就是正在调它，
//   打算调的是 ask_question = 等你回答。最后一步被取消 / 出错 = 中断。
//   SQLite 用 Node 自带的 node:sqlite（Electron 45 / Node 24 有）；没有就只有「在跑」，没名字和进展。
//
// 屏保这一轮里见过在跑的会话会一直留在列表里，结束了标成「已完成」或「已中断」，屏保关了就清空。
import { execFile } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const KINDS = ['claude', 'codex', 'dsh', 'antigravity']
/** 进展里的字跟屏保语言走（saver.ts 的 saverLang） */
const S = {
  zh: {
    read: '读取',
    edit: '编辑',
    write: '写入',
    grep: '搜索',
    glob: '找文件',
    agent: 'subagent：',
    web: '查资料',
    reply: '回复中…',
    think: '思考中…',
    reason: '推理中…',
    tool: '工具调用',
    interrupted: '被打断',
    done: '本轮完成',
    aborted: '被中断',
    approve: (t) => `等你确认：${t}`,
    ask: '等你回答问题',
    failed: '出错了',
  },
  en: {
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    grep: 'Search',
    glob: 'Find',
    agent: 'Subagent: ',
    web: 'Web lookup',
    reply: 'Replying…',
    think: 'Thinking…',
    reason: 'Reasoning…',
    tool: 'Tool call',
    interrupted: 'Interrupted',
    done: 'Turn finished',
    aborted: 'Stopped',
    approve: (t) => `Needs approval: ${t}`,
    ask: 'Waiting for your answer',
    failed: 'Failed',
  },
}
const TAIL_BYTES = 256 * 1024
const CODEX_DAYS = 7
const CODEX_IDLE_ALIVE_MS = 6 * 3600_000 // 还有 codex 进程：可能在等人确认，等得久一点
const CODEX_IDLE_DEAD_MS = 2 * 60_000 // 一个 codex 进程都没有：写着「在跑」也是没了
const DSH_DAYS = 7 // dsh 会话：只看最近几天动过的（锁文件每次打开会话都会刷新时间）
const DSH_MAX_BYTES = 64 * 1024 * 1024
/** 读文件最后一段，按行切开（第一行可能是半截，丢掉） */
export function tailLines(path, bytes = TAIL_BYTES) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    if (len < size) lines.shift()
    return lines.filter((l) => l.trim())
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
function parse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}
const clip = (s, n = 48) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const file = (p) => (typeof p === 'string' && p ? basename(p) : '')
/** 命令行去掉开头的 cd xxx &&，绝对路径只留最后一段：屏保上一行放不下 */
export const shortCmd = (cmd) =>
  cmd.replace(/^\s*cd\s+\S+\s*&&\s*/, '').replace(/(?:~|\/[^\s'"/]+)(?:\/[^\s'"/]+)+\/([^\s'"/]+)/g, '$1')
/** 一次工具调用 → 一行人话 */
export function describeTool(name, input, lang = 'zh') {
  const i = input && typeof input === 'object' ? input : {}
  const t = S[lang]
  switch (name) {
    case 'Bash':
      return `Bash ${clip(shortCmd(String(i.command ?? '')), 40)}`
    case 'Read':
      return `${t.read} ${file(i.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `${t.edit} ${file(i.file_path)}`
    case 'Write':
      return `${t.write} ${file(i.file_path)}`
    case 'Grep':
      return `${t.grep} "${clip(String(i.pattern ?? ''), 24)}"`
    case 'Glob':
      return `${t.glob} ${clip(String(i.pattern ?? ''), 28)}`
    case 'Agent':
    case 'Task':
      return `${t.agent}${clip(String(i.description ?? ''), 28)}`
    case 'WebFetch':
    case 'WebSearch':
      return t.web
    default:
      return clip(name.replace(/^mcp__[^_]+__/, ''), 40)
  }
}
// ---------------------------------------------------------------- Claude Code
/** 记录文件末尾 → 最近一次在干什么；被用户打断的话 interrupted 为 true */
export function claudeTail(lines, lang = 'zh') {
  const t = S[lang]
  for (let k = lines.length - 1; k >= 0; k--) {
    const d = parse(lines[k])
    const content = d?.message?.content
    if (d?.type === 'user') {
      const texts = Array.isArray(content) ? content.map((c) => c?.text ?? '') : [String(content ?? '')]
      if (texts.some((t) => t.includes('[Request interrupted'))) return { progress: t.interrupted, interrupted: true }
      continue
    }
    if (d?.type !== 'assistant' || !Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const c = content[j]
      if (c?.type === 'tool_use') return { progress: describeTool(String(c.name ?? ''), c.input, lang), interrupted: false }
      if (c?.type === 'text' && c.text) return { progress: t.reply, interrupted: false }
      if (c?.type === 'thinking') return { progress: t.think, interrupted: false }
    }
  }
  return { progress: t.think, interrupted: false }
}
/** sessions/<pid>.json 的内容 → 会话；不是 Claude Code 会话的文件（没有 pid / sessionId）返回 null */
export function claudeFromMeta(meta, alive) {
  if (!meta || typeof meta.pid !== 'number' || typeof meta.sessionId !== 'string') return null
  const status = String(meta.status ?? '')
  const live = alive(meta.pid) && status !== 'idle' && status !== ''
  return {
    id: `claude:${meta.sessionId}`,
    kind: 'claude',
    name: String(meta.name || basename(String(meta.cwd ?? '')) || 'Claude Code'),
    live,
    waiting: live && /wait|permission|input/i.test(status),
    ended: alive(meta.pid) ? 'done' : 'aborted',
    startedAt: Number(meta.statusUpdatedAt ?? meta.updatedAt ?? meta.startedAt ?? Date.now()),
  }
}
// ---------------------------------------------------------------- Codex
/** rollout 记录末尾 → 在不在跑、怎么结束的、最近在干什么、这一轮几点开始 */
export function codexTail(lines, lang = 'zh') {
  let state = 'unknown'
  let progress = ''
  let startedAt = null
  for (let k = lines.length - 1; k >= 0; k--) {
    const d = parse(lines[k])
    const p = d?.payload
    if (!p) continue
    if (!progress && d.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      progress = codexTool(String(p.name ?? ''), p.input ?? p.arguments, lang)
    }
    if (d.type === 'event_msg' && state === 'unknown') {
      if (p.type === 'task_complete') state = 'done'
      else if (p.type === 'turn_aborted') state = 'aborted'
      else if (p.type === 'task_started') {
        state = 'running'
        startedAt = Date.parse(d.timestamp) || null
      }
    }
    if (state !== 'unknown' && progress) break
  }
  return { state, progress: progress || (state === 'running' ? S[lang].reason : ''), startedAt }
}
function codexTool(name, input, lang) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  // 新版 Codex 的 exec 工具传的是一段 JS（tools.exec_command({ cmd: '...' })），旧版是 {"cmd": ...} / {"command": [...]}
  const cmd =
    raw.match(/\bcmd\b["']?\s*:\s*["'`]((?:\\.|[^"'`\\])*)/)?.[1] ??
    raw
      .match(/"command"\s*:\s*\[([^\]]*)\]/)?.[1]
      ?.replace(/"/g, '')
      .replace(/,/g, ' ')
  if (cmd) return `exec ${clip(shortCmd(cmd.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1')), 40)}`
  if (name === 'apply_patch' || raw.includes('*** Begin Patch')) return 'apply_patch'
  if (name === 'update_plan') return 'update_plan'
  return clip(name || S[lang].tool, 40)
}
/** session_index.jsonl：同一个 id 可能有好几行，后面的为准 */
export function codexNames(lines) {
  const names = new Map()
  for (const l of lines) {
    const d = parse(l)
    if (d && typeof d.id === 'string' && typeof d.thread_name === 'string' && d.thread_name.trim())
      names.set(d.id, d.thread_name.trim())
  }
  return names
}
// ---------------------------------------------------------------- DeepSeek Harness

/**
 * 把 zstd 文件切成一个个帧（dsh 每批追加一个帧；Node 的 zstd 解压只解第一个帧，所以自己切）。
 * 返回 [起点, 终点) 列表；最后一个帧没写完（正在写、崩溃留下的半截）就不要它。
 */
export function zstdFrames(buf, from = 0) {
  const frames = []
  let p = from
  while (p + 4 <= buf.length) {
    const magic = buf.readUInt32LE(p)
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      // 可跳过的帧：4 字节魔数 + 4 字节长度 + 内容
      if (p + 8 > buf.length) break
      p += 8 + buf.readUInt32LE(p + 4)
      continue
    }
    if (magic !== 0xfd2fb528) break
    const start = p
    let q = p + 4
    if (q >= buf.length) break
    const fhd = buf[q++]
    const fcsFlag = fhd >> 6
    const single = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    q += single ? 0 : 1 // Window_Descriptor
    q += [0, 1, 2, 4][fhd & 3] // Dictionary_ID
    q += [single ? 1 : 0, 2, 4, 8][fcsFlag] // Frame_Content_Size
    let last = 0
    while (!last) {
      if (q + 3 > buf.length) return frames
      const h = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16)
      last = h & 1
      const type = (h >> 1) & 3
      const size = h >>> 3
      q += 3 + (type === 1 ? 1 : size)
    }
    q += checksum ? 4 : 0
    if (q > buf.length) break
    frames.push([start, q])
    p = q
  }
  return frames
}

/** session.vN.jsonl.zstd 的路径里挑版本最高的那个 */
function dshLog(dir) {
  let best = null
  let bestN = -1
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const f of names) {
    const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(f)
    if (m && Number(m[1] ?? 0) > bestN) {
      bestN = Number(m[1] ?? 0)
      best = join(dir, f)
    }
  }
  return best
}

const brief = (args) => {
  let a = args
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch {
      return clip(a, 36)
    }
  }
  if (!a || typeof a !== 'object') return ''
  const cmd = a.command ?? a.cmd
  if (typeof cmd === 'string') return clip(shortCmd(cmd), 36)
  if (Array.isArray(cmd)) return clip(shortCmd(cmd.join(' ')), 36)
  const path = a.file_path ?? a.path ?? a.file
  if (typeof path === 'string') return file(path)
  const q = a.pattern ?? a.query ?? a.url ?? a.description
  return typeof q === 'string' ? clip(q, 28) : ''
}

/**
 * dsh 会话记录（一行一个事件）→ 这一轮在不在跑、等不等人、最近在干什么、叫什么。
 * header 是第一行 { type: 'session', createdAt, cwd, origin?, delegationDepth? }。
 */
export function dshFold(events, lang = 'zh') {
  const t = S[lang]
  let header = null
  let title = ''
  let firstPrompt = ''
  let openTurn = null // { turn, at }
  let ended = null // 最后一轮怎么结束的：done / aborted / failed
  const approvals = new Map() // id → toolName
  const calls = new Map() // callId → { name, args }
  let todo = ''
  let lastText = ''
  let lastStepAt = 0
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    const d = e.data ?? {}
    switch (e.type) {
      case 'session':
        header = e
        break
      case 'session/title':
        if (typeof d.title === 'string' && d.title.trim()) title = d.title.trim()
        break
      case 'user/message':
        if (d.source?.kind === 'user' && !firstPrompt) {
          firstPrompt = (d.content ?? []).map((c) => c?.text ?? '').join(' ').trim()
        }
        break
      case 'turn/start':
        openTurn = { turn: d.turn, at: Number(e.time) || 0 }
        approvals.clear()
        calls.clear()
        todo = ''
        lastText = ''
        ended = null
        break
      case 'turn/end': {
        if (openTurn && (d.turn === undefined || d.turn === openTurn.turn)) openTurn = null
        const k = d.reason?.kind
        ended = k === 'completed' || k === 'max-tokens' || k === 'forked' ? 'done' : k === 'error' || k === 'blocked' ? 'failed' : 'aborted'
        break
      }
      case 'step/start':
        lastStepAt = Number(e.time) || lastStepAt
        break
      case 'approval/asked':
        approvals.set(d.id, String(d.toolName ?? ''))
        break
      case 'approval/decided':
        approvals.delete(d.id)
        break
      case 'tool/call':
        calls.set(d.callId, { name: String(d.name ?? ''), args: d.arguments })
        break
      case 'tool/result':
        calls.delete(d.message?.toolCallId ?? d.callId)
        break
      case 'todo/write': {
        const cur = (d.todos ?? []).find((x) => x?.status === 'in_progress')
        todo = cur ? clip(String(cur.content ?? ''), 40) : ''
        break
      }
      case 'assistant/message': {
        const blocks = d.message?.content ?? []
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i]?.type === 'text' && blocks[i].text) {
            lastText = t.reply
            break
          }
        }
        break
      }
    }
  }
  const pendingAsk = [...calls.values()].some((c) => c.name === 'ask_user_question')
  const waitingTool = [...approvals.values()][0]
  const waiting = !!openTurn && (waitingTool !== undefined || pendingAsk)
  const call = [...calls.values()].at(-1)
  let progress
  if (!openTurn) progress = ended === 'done' ? t.done : ended === 'failed' ? t.failed : ended ? t.aborted : ''
  else if (waitingTool !== undefined) progress = t.approve(waitingTool || t.tool)
  else if (pendingAsk) progress = t.ask
  else if (todo) progress = todo
  else if (call) progress = `${call.name} ${brief(call.args)}`.trim()
  else progress = lastText || t.think
  return {
    header,
    name: clip(title || firstPrompt || basename(String(header?.cwd ?? '')) || 'DeepSeek Harness', 40),
    running: !!openTurn,
    waiting,
    ended: ended === 'done' ? 'done' : ended ? 'aborted' : null,
    progress,
    turnStartedAt: openTurn?.at || lastStepAt || Number(header?.createdAt) || 0,
    child: !!header && (header.origin === 'subagent' || Number(header.delegationDepth) > 0),
  }
}

/** 哪些锁文件正被进程开着（dsh 的 session.lock、Antigravity 的 presence 锁）。lsof 在后台跑，结果先用上次的 */
function lockProbe() {
  if (process.platform === 'win32') return () => null // Windows 上 dsh 用的是命名信号量，这里看不了
  let held = new Set()
  let busy = false
  return (paths) => {
    if (!busy && paths.length) {
      busy = true
      execFile('/usr/sbin/lsof', ['-Fn', '--', ...paths], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
        // 有的文件没人开时 lsof 退出码是 1，照样读输出
        held = new Set(
          String(stdout ?? '')
            .split('\n')
            .filter((l) => l.startsWith('n'))
            .map((l) => l.slice(1)),
        )
        busy = false
      })
    }
    return held
  }
}

// ---------------------------------------------------------------- Antigravity
const AG_DAYS = 7 // presence 锁文件每轮开始刷新时间：只看最近几天动过的
const AG_STEP_PLANNER = 15 // CORTEX_STEP_TYPE_PLANNER_RESPONSE：模型这一步说的话、打算调的工具
const AG_STEP_ERROR = 17 // CORTEX_STEP_TYPE_ERROR_MESSAGE：接口报错（会自己重试，最后一步还是它 = 这一轮出错停了）
const AG_STEP_ABORTED = new Set([6, 7, 12]) // CORTEX_STEP_STATUS_CANCELED / ERROR / INTERRUPTED

let sqliteMod
/** Node 自带的 node:sqlite；没有（老 Node）返回 null */
function sqlite() {
  if (sqliteMod === undefined) {
    try {
      sqliteMod = process.getBuiltinModule?.('node:sqlite') ?? null
    } catch {
      sqliteMod = null
    }
  }
  return sqliteMod
}
/**
 * 只读打开 SQLite 跑一句查询，出错返回 null。
 * 库开着 WAL：有人在写（有 -wal / -shm）照常只读打开；刚合并完、-shm 不在时只读打不开，就按不可变文件读一次。
 */
export function sqliteAll(path, sql, params = []) {
  const m = sqlite()
  if (!m || !existsSync(path)) return null
  for (const target of [path, `file:${encodeURI(path)}?immutable=1`]) {
    let db = null
    try {
      db = new m.DatabaseSync(target, { readOnly: true })
      return db.prepare(sql).all(...params)
    } catch {
    } finally {
      try {
        db?.close()
      } catch {}
    }
  }
  return null
}

/** 解一层 protobuf：[[字段号, 数字 | Buffer | null]]；不像 protobuf 就返回 null */
function pbFields(buf) {
  const out = []
  let p = 0
  const varint = () => {
    let v = 0
    let s = 0
    let c
    do {
      if (p >= buf.length || s > 63) throw new Error('varint')
      c = buf[p++]
      v += (c & 0x7f) * 2 ** s
      s += 7
    } while (c & 0x80)
    return v
  }
  try {
    while (p < buf.length) {
      const key = varint()
      const f = Math.floor(key / 8)
      const w = key % 8
      if (f === 0) return null
      if (w === 0) out.push([f, varint()])
      else if (w === 1 || w === 5) {
        p += w === 1 ? 8 : 4
        if (p > buf.length) return null
        out.push([f, null])
      } else if (w === 2) {
        const n = varint()
        if (p + n > buf.length) return null
        out.push([f, buf.subarray(p, p + n)])
        p += n
      } else return null
    }
  } catch {
    return null
  }
  return out
}
/** 一步的 protobuf 里找工具调用：子消息 { 1: 'call_…', 2: 工具名, 3: JSON 参数 }，返回最后一个 */
export function agToolCall(buf, depth = 0) {
  const fields = pbFields(buf)
  if (!fields) return null
  const str = (f) => {
    const v = fields.find((x) => x[0] === f)?.[1]
    return Buffer.isBuffer(v) ? v.toString('utf8') : null
  }
  const name = str(2)
  if (str(1)?.startsWith('call_') && name && /^[a-z][a-z0-9_]{0,63}$/.test(name)) return { name, args: str(3) ?? '' }
  if (depth >= 8) return null
  let found = null
  for (const [, v] of fields) {
    if (!Buffer.isBuffer(v) || v.length < 4) continue
    const c = agToolCall(v, depth + 1)
    if (c) found = c
  }
  return found
}
/** Antigravity 的工具调用 → 一行人话（参数名是 CommandLine / Path / Query 这种大写开头的） */
export function agTool(name, args) {
  let a = args
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch {
      a = {}
    }
  }
  const o = {}
  if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) o[k.toLowerCase()] = v
  const detail = brief({
    command: o.commandline ?? o.command,
    path: o.path ?? o.absolutepath ?? o.targetfile ?? o.file,
    query: o.query ?? o.pattern ?? o.url,
  })
  return `${clip(name, 32)} ${detail}`.trim()
}
/** conversations/<会话>.db 的最后一步 → 最近在干什么、是不是在等你、这一轮（要是已经停了）怎么结束的 */
export function agTail(step, lang = 'zh') {
  const t = S[lang]
  if (!step) return { progress: t.think, waiting: false, ended: 'done' }
  const payload = step.step_payload ? Buffer.from(step.step_payload) : null
  const call = payload ? agToolCall(payload) : null
  const planned = Number(step.step_type) === AG_STEP_PLANNER
  const waiting = planned && call?.name === 'ask_question'
  let progress
  if (waiting) progress = t.ask
  else if (call) progress = agTool(call.name, call.args)
  else progress = planned ? t.reply : t.think
  const failed = AG_STEP_ABORTED.has(Number(step.status)) || Number(step.step_type) === AG_STEP_ERROR
  return { progress, waiting, ended: failed ? 'aborted' : 'done' }
}
/** workspace_uris 是 JSON 数组 ["file:///…/项目"]：取第一个的目录名 */
function agWorkspaceName(uris) {
  try {
    const first = JSON.parse(String(uris ?? ''))?.[0]
    return typeof first === 'string' && first ? basename(decodeURIComponent(new URL(first).pathname)) : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- 汇总
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
/** 本机有没有 codex 进程（CLI，或者 ChatGPT App 里带的）。pgrep 在后台跑，最多 30 秒一次，结果先用上次的 */
function codexProbe() {
  if (process.platform === 'win32') return () => true // 没有 pgrep：按「可能还在等人」算，只是判中断慢一些
  let alive = true
  let at = 0
  let busy = false
  return () => {
    if (!busy && Date.now() - at > 30_000) {
      busy = true
      execFile('pgrep', ['-x', 'codex'], (err) => {
        alive = !err
        at = Date.now()
        busy = false
      })
    }
    return alive
  }
}
export class AgentWatcher {
  home
  now
  alive
  codexAlive
  /** 进展用什么语言；屏保每次开的时候按系统语言设 */
  lang
  /** 这一轮屏保里见过在跑的会话 */
  tracked = new Map()
  /** sessionId → 记录文件，找一次记住 */
  transcripts = new Map()
  /** codex:<id> → rollout 文件：跟踪中的会话不管文件在哪天的目录都接着读 */
  codexFiles = new Map()
  /** dsh 会话记录：路径 → { size, offset, events }，只解新追加的帧 */
  dshLogs = new Map()
  timer = null
  last = ''
  constructor(opts = {}) {
    this.home = opts.home ?? homedir()
    this.now = opts.now ?? Date.now
    this.alive = opts.alive ?? pidAlive
    this.codexAlive = opts.codexAlive ?? codexProbe()
    this.dshHome = opts.dshHome ?? (opts.home ? join(opts.home, '.dsh') : process.env.DSH_HOME?.trim() || join(this.home, '.dsh'))
    this.dshLocks = opts.dshLocks ?? lockProbe()
    this.agHome = opts.agHome ?? join(this.home, '.gemini', 'antigravity')
    this.agLocks = opts.agLocks ?? lockProbe() // 跟 dsh 的分开：各自一份 lsof 结果
    this.lang = opts.lang ?? 'zh'
  }
  /** 开始盯：有变化才回调（第一次一定回调） */
  start(onChange, intervalMs = 2000) {
    this.stop()
    this.tracked.clear()
    this.last = ''
    const tick = () => {
      let list
      try {
        list = this.poll()
      } catch (e) {
        console.error('读会话状态失败:', e)
        return
      }
      const key = JSON.stringify(list)
      if (key !== this.last) {
        this.last = key
        onChange(list)
      }
    }
    tick()
    this.timer = setInterval(tick, intervalMs)
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.tracked.clear()
    this.codexFiles.clear()
    this.dshLogs.clear()
  }
  get sessions() {
    return [...this.tracked.values()].sort((a, b) => a.startedAt - b.startedAt)
  }
  /** 看一眼，更新列表 */
  poll() {
    const seen = [...this.claude(), ...this.codex(), ...this.dsh(), ...this.antigravity()]
    const byId = new Map(seen.map((s) => [s.id, s]))
    for (const s of seen) {
      if (!s.live) continue
      const prev = this.tracked.get(s.id)
      const fresh = !prev || prev.status === 'done' || prev.status === 'aborted' // 结束了又开新一轮
      this.tracked.set(s.id, {
        id: s.id,
        kind: s.kind,
        name: s.name,
        status: s.waiting ? 'waiting' : 'running',
        progress: s.progress,
        startedAt: fresh ? s.startedAt : prev.startedAt,
      })
    }
    for (const t of this.tracked.values()) {
      if (t.status === 'done' || t.status === 'aborted') continue
      const s = byId.get(t.id)
      if (s?.live) continue
      if (s) t.name = s.name // Codex 的线程名、Antigravity 的标题可能跑到一半才起好
      t.status = s?.ended ?? 'aborted' // 文件都没了：当它中断了
      t.progress = t.status === 'done' ? S[this.lang].done : S[this.lang].aborted
      t.endedAt = this.now()
    }
    return this.sessions
  }
  claude() {
    const dir = join(this.home, '.claude', 'sessions')
    let files
    try {
      files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
    } catch {
      return []
    }
    const out = []
    for (const f of files) {
      let meta
      try {
        meta = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch {
        continue
      }
      const s = claudeFromMeta(meta, this.alive)
      if (!s) continue
      // 只读跟这一轮有关的：在跑的，或者之前在跑、现在要判断怎么结束的
      if (!s.live && !this.tracked.has(s.id)) continue
      const path = this.transcript(meta.sessionId, String(meta.cwd ?? ''))
      const tail = path ? claudeTail(tailLines(path, 64 * 1024), this.lang) : { progress: S[this.lang].think, interrupted: false }
      out.push({ ...s, progress: tail.progress, ended: tail.interrupted ? 'aborted' : s.ended })
    }
    return out
  }
  /** ~/.claude/projects/<工作目录换成横杠>/<sessionId>.jsonl；目录名猜不中就挨个目录找 */
  transcript(sessionId, cwd) {
    if (this.transcripts.has(sessionId)) return this.transcripts.get(sessionId)
    const root = join(this.home, '.claude', 'projects')
    let found = null
    const guess = join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
    if (existsSync(guess)) found = guess
    else {
      try {
        for (const d of readdirSync(root)) {
          const p = join(root, d, `${sessionId}.jsonl`)
          if (existsSync(p)) {
            found = p
            break
          }
        }
      } catch {}
    }
    if (found) this.transcripts.set(sessionId, found) // 没找到不记：会话刚开时记录文件可能还没写
    return found
  }
  codex() {
    const root = join(this.home, '.codex', 'sessions')
    const now = this.now()
    const idleLimit = this.codexAlive() ? CODEX_IDLE_ALIVE_MS : CODEX_IDLE_DEAD_MS
    const files = new Map() // 路径 → 最后写入时间
    const add = (path) => {
      try {
        files.set(path, statSync(path).mtimeMs)
      } catch {}
    }
    // 最近几天的目录：会话开始那天的目录里，过了午夜也一直在写
    for (let back = 0; back < CODEX_DAYS; back++) {
      const d = new Date(now - back * 86400_000)
      const dir = join(
        root,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      )
      let names
      try {
        names = readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const f of names) add(join(dir, f))
    }
    // 跟踪中的会话：记着文件，再久以前开的也接着读
    for (const [key, path] of this.codexFiles) if (this.tracked.has(key) && !files.has(path)) add(path)
    let names = null
    const out = []
    for (const [path, mtime] of files) {
      const id = basename(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1]
      if (!id) continue
      const key = `codex:${id}`
      const idle = now - mtime
      if (idle > CODEX_IDLE_ALIVE_MS && !this.tracked.has(key)) continue // 很久没动的老会话，不用读
      const t = codexTail(tailLines(path), this.lang)
      // 记录末尾找不到开始 / 结束（输出太多被挤出去了）：最近还在写就当在跑
      const live = idle <= idleLimit && (t.state === 'running' || (t.state === 'unknown' && idle < 10 * 60_000))
      if (!live && !this.tracked.has(key)) continue
      if (live) this.codexFiles.set(key, path)
      names ??= codexNames(tailLines(join(this.home, '.codex', 'session_index.jsonl'), 512 * 1024))
      out.push({
        id: key,
        kind: 'codex',
        name: names.get(id) ?? codexCwdName(path) ?? 'Codex',
        live,
        ended: t.state === 'done' ? 'done' : 'aborted',
        progress: t.progress,
        startedAt: t.startedAt ?? mtime,
      })
    }
    return out
  }
  /** 读一个 dsh 会话记录：只解上次之后新追加的帧 */
  dshEvents(path) {
    let size
    try {
      size = statSync(path).size
    } catch {
      this.dshLogs.delete(path)
      return null
    }
    let c = this.dshLogs.get(path)
    if (!c || size < c.size) c = { size: 0, offset: 0, events: [] } // 第一次读，或者文件被换了
    if (size === c.size) return c.events
    if (size > DSH_MAX_BYTES) return null
    let buf
    try {
      buf = readFileSync(path)
    } catch {
      return c.events
    }
    // 只追加的文件，上次读到的地方应该正好是下一个帧的开头；不是（文件被换过）就从头再读
    if (c.offset && (c.offset + 4 > buf.length || buf.readUInt32LE(c.offset) !== 0xfd2fb528)) c = { size: 0, offset: 0, events: [] }
    for (const [a, b] of zstdFrames(buf, c.offset)) {
      try {
        for (const line of zstdDecompressSync(buf.subarray(a, b)).toString('utf8').split('\n')) {
          const e = line.trim() && parse(line)
          if (e) c.events.push(e)
        }
      } catch {}
      c.offset = b
    }
    c.size = size
    this.dshLogs.set(path, c)
    return c.events
  }

  dsh() {
    const root = join(this.dshHome, 'sessions')
    const now = this.now()
    const dirs = []
    let projects
    try {
      projects = readdirSync(root)
    } catch {
      return []
    }
    for (const p of projects) {
      let ids
      try {
        ids = readdirSync(join(root, p))
      } catch {
        continue
      }
      for (const id of ids) {
        const dir = join(root, p, id)
        const lock = join(dir, 'session.lock')
        let mtime
        try {
          mtime = statSync(lock).mtimeMs
        } catch {
          continue // 没有锁文件：老格式、从没被打开写过，不会在跑
        }
        const key = `dsh:${id}`
        if (now - mtime > DSH_DAYS * 86400_000 && !this.tracked.has(key)) continue
        dirs.push({ dir, lock, key })
      }
    }
    const held = this.dshLocks(dirs.map((d) => d.lock))
    if (!held) return []
    const out = []
    for (const { dir, lock, key } of dirs) {
      const open = held.has(lock)
      if (!open && !this.tracked.has(key)) continue
      const log = dshLog(dir)
      const events = log && this.dshEvents(log)
      if (!events) continue
      const f = dshFold(events, this.lang)
      if (f.child) continue // subagent 的会话算在父会话里
      out.push({
        id: key,
        kind: 'dsh',
        name: f.name,
        live: open && f.running,
        waiting: f.waiting,
        ended: f.ended ?? (open ? 'done' : 'aborted'),
        progress: f.progress,
        startedAt: f.turnStartedAt || now,
      })
    }
    return out
  }
  antigravity() {
    const root = this.agHome
    const presence = join(root, 'presence')
    const now = this.now()
    let names
    try {
      names = readdirSync(presence)
    } catch {
      return []
    }
    const cand = []
    for (const f of names) {
      const id = /^([0-9a-f-]{36})\.lock$/.exec(f)?.[1]
      if (!id) continue
      const lock = join(presence, f)
      const key = `antigravity:${id}`
      let mtime
      try {
        mtime = statSync(lock).mtimeMs
      } catch {
        continue
      }
      if (now - mtime > AG_DAYS * 86400_000 && !this.tracked.has(key)) continue
      cand.push({ id, key, lock, mtime })
    }
    if (!cand.length) return []
    const held = this.agLocks(cand.map((c) => c.lock))
    if (!held) return []
    const want = cand.filter((c) => held.has(c.lock) || this.tracked.has(c.key))
    if (!want.length) return []
    const rows = sqliteAll(
      join(root, 'conversation_summaries.db'),
      `select conversation_id, title, status, workspace_uris, parent_conversation_id, nesting_depth, killed, last_user_input_time
       from conversation_summaries where conversation_id in (${want.map(() => '?').join(',')})`,
      want.map((c) => c.id),
    )
    const meta = new Map((rows ?? []).map((r) => [r.conversation_id, r]))
    const out = []
    for (const { id, key, lock, mtime } of want) {
      const r = meta.get(id)
      if (r && (r.parent_conversation_id || Number(r.nesting_depth) > 0)) continue // subagent 的会话算在父会话里
      const killed = !!r && (Number(r.killed) > 0 || r.status === 'CASCADE_RUN_STATUS_CANCELING')
      const live = held.has(lock) && !killed
      const last = sqliteAll(join(root, 'conversations', `${id}.db`), 'select step_type, status, step_payload from steps order by idx desc limit 1')
      const tail = agTail(last?.[0], this.lang)
      const started = Date.parse(String(r?.last_user_input_time ?? '').replace(' ', 'T'))
      out.push({
        id: key,
        kind: 'antigravity',
        name: clip(String(r?.title ?? '').trim() || agWorkspaceName(r?.workspace_uris) || 'Antigravity', 40),
        live,
        waiting: live && tail.waiting,
        ended: killed ? 'aborted' : tail.ended,
        progress: tail.progress,
        startedAt: Number.isFinite(started) && started > 0 ? started : mtime,
      })
    }
    return out
  }
}
/** 没有 thread_name 的（比如 codex exec 跑的）：用第一行 session_meta 里的工作目录名 */
function codexCwdName(path) {
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(16 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    const first = parse(buf.subarray(0, n).toString('utf8').split('\n')[0])
    const cwd = first?.payload?.cwd
    return typeof cwd === 'string' && cwd ? basename(cwd) : null
  } catch {
    return null
  }
}
