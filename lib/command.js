// /screensaver 命令：在 dsh 里直接开屏保、看主题、管「合盖不睡」。命令不发给模型。
//   /screensaver                 开屏保（默认主题）
//   /screensaver subspace        用某个主题开
//   /screensaver themes          列出装了哪些主题
//   /screensaver lid             看合盖不睡的状态
//   /screensaver lid authorize   授权（弹一次管理员密码框，装一条只放行 pmset disablesleep 的 sudoers 规则）
//   /screensaver lid revoke      撤销授权
//   /screensaver lid on|off      手动开关合盖不睡
import { saver } from './bridge.js'

export const name = 'dsh-screensaver-command'
export const inject = ['commands']

export const USAGE = [
  'Usage:',
  '  /screensaver               start the screen saver',
  '  /screensaver <theme>       start with a theme (see /screensaver themes)',
  '  /screensaver themes        list installed themes',
  '  /screensaver lid [authorize|revoke|on|off]',
  '                             keep the Mac awake with the lid closed (macOS, admin password once)',
].join('\n')

function lidText(st) {
  if (!st?.supported) return 'Lid-closed awake: macOS only'
  if (!st.authorized) return 'Lid-closed awake: not authorized yet. Run /screensaver lid authorize (asks for an admin password once).'
  return `Lid-closed awake: ${st.sleepDisabled ? 'ON' : 'off'}${st.sleepDisabled && !st.ours ? ' (turned on outside dsh-screensaver)' : ''}`
}

/** 解析参数并执行；返回给人看的文字。抛错 = 命令失败 */
export async function run(rawInput, bridge = saver) {
  const args = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const [first, second] = args
  if (first === 'help' || first === '-h' || first === '--help') return USAGE
  if (first === 'themes') {
    const list = await bridge.request('themes')
    return list.map((t) => `${t.id}  ${t.name}${t.sessions ? '  (shows live agent sessions)' : ''}`).join('\n') || 'No themes installed'
  }
  if (first === 'lid') {
    const action = second ?? 'status'
    if (!['status', 'authorize', 'revoke', 'on', 'off'].includes(action)) throw new Error(USAGE)
    return lidText(await bridge.request('lid', { action }))
  }
  if (args.length > 1) throw new Error(USAGE)
  if (first) {
    const list = await bridge.request('themes')
    if (!list.some((t) => t.id === first)) {
      throw new Error(`No theme "${first}". Installed: ${list.map((t) => t.id).join(', ') || 'none'}`)
    }
  }
  await bridge.request('start', first ? { theme: first } : {})
  return 'Screen saver on. Touch ID or any key / click to unlock.'
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'screensaver',
        description: 'Cover the screen while your agents keep running (Touch ID to unlock)',
        input: { hint: '[theme | themes | lid [authorize|revoke|on|off]]' },
        handler: async ({ rawInput }) => {
          try {
            return { kind: 'success', text: await run(rawInput) }
          } catch (e) {
            return { kind: 'error', text: e.message }
          }
        },
      }),
    'dsh-screensaver command',
  )
}
