// 发版只改版本号：package.json 和 package-lock.json 的版本必须一起改（publish.yml 按 package.json 对 tag）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const json = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))

describe('release version', () => {
  it('package-lock.json carries the same version as package.json', () => {
    const pkg = json('package.json'), lock = json('package-lock.json')
    expect(lock.name).toBe(pkg.name)
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages[''].version).toBe(pkg.version)
  })

  it('the version is plain semver, so the v<version> tag publish.yml checks can match it', () => {
    expect(json('package.json').version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
