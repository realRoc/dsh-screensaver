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
