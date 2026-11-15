// 给 agent 用的 screensaver 工具：用户说「我走开一下，帮我把屏幕盖上」时，agent 调它开屏保，自己接着干活。
// 开屏保只是盖住屏幕，用户摸 Touch ID 就解开，不碰文件、不连网，所以不要求确认。
import { saver } from './bridge.js'

export const name = 'dsh-screensaver-tool'
export const inject = ['tools']

export async function start(args, bridge = saver) {
  const theme = typeof args?.theme === 'string' && args.theme.trim() ? args.theme.trim() : undefined
  if (theme) {
    const list = await bridge.request('themes')
    if (!list.some((t) => t.id === theme)) return `No theme "${theme}". Installed: ${list.map((t) => t.id).join(', ')}`
  }
  await bridge.request('start', theme ? { theme } : {})
  return 'The screen is covered. Keep working; the user unlocks with Touch ID or their password when back.'
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'screensaver',
    description:
      "Cover the user's screen with a lock-screen-style screen saver while you keep working. " +
      'Use it only when the user says they are stepping away and asks you to lock or cover the screen. ' +
      'The Mac stays awake and your session keeps running; the user unlocks with Touch ID or their login password.',
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', description: 'Theme id, e.g. "basic" or "subspace". Omit for the default.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        return await start(args)
      } catch (e) {
        return `Could not start the screen saver: ${e.message}`
      }
    },
  })
}
