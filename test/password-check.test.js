// desk-unlock 密码框的核对状态机（native/unlock/PasswordCheck.swift）：跟 test/native/password-check/main.swift 一起编了跑。
// 只在有 Xcode 命令行工具的 Mac 上跑，别处跳过。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SOURCE_DIR } from '../app/helper.js'

function hasSwiftc() {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/xcrun')) return false
  try {
    execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!hasSwiftc())('PasswordCheck（同一时间最多一个底层核对、超时后晚到的结果不算）', () => {
  it('对 / 错、超时 → 重试 → 旧请求晚到、取消、等待中再按回车', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwcheck-'))
    try {
      const bin = join(dir, 'password-check')
      execFileSync(
        '/usr/bin/xcrun',
        ['swiftc', '-o', bin, join(SOURCE_DIR, 'PasswordCheck.swift'), join(import.meta.dirname, 'native', 'password-check', 'main.swift')],
        { stdio: 'pipe', timeout: 240_000 },
      )
      let out
      try {
        out = execFileSync(bin, { encoding: 'utf8', timeout: 30_000 })
      } catch (e) {
        out = `${e.stdout ?? ''}${e.stderr ?? ''}`
      }
      expect(out.trim()).toBe('PASS')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
