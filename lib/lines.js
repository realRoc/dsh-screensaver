/** 把子进程输出（一块块来，不按行切）拼成整行，每凑齐一行调一次 onLine；最后半行留着等下一块 */
export function lineReader(onLine) {
  let rest = ''
  return (chunk) => {
    rest += String(chunk)
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) onLine(line.replace(/\r$/, ''))
  }
}

/**
 * desk-unlock --listen 打的一行 → 发给屏保页面的事件；不认识的行返回 null。
 * - touch match / touch miss / touch（老版本）：摸到传感器 → saver:touch，值 match / miss / ''
 * - typing on / typing off：密码框出来、收起 → saver:typing，值 on / off
 * - password wrong / password timeout：输错、核对超时（框还开着）→ saver:typing，值 wrong / timeout
 * @returns {{ channel: 'saver:touch' | 'saver:typing', value: string } | null}
 */
export function listenerEvent(line) {
  const touch = /^touch(?: (match|miss))?$/.exec(line)
  if (touch) return { channel: 'saver:touch', value: touch[1] ?? '' }
  const typing = /^(?:typing (on|off)|password (wrong|timeout))$/.exec(line)
  if (typing) return { channel: 'saver:typing', value: typing[1] ?? typing[2] }
  return null
}
