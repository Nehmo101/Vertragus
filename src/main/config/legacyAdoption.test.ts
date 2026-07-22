import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptLegacyDir, adoptLegacyFile } from './legacyAdoption'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vertragus-adoption-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('legacy userData adoption', () => {
  it('copies a legacy file once and keeps the original', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'orca-inbox.json'), '{"ideas":[1]}')
    adoptLegacyFile(dir, 'orca-inbox.json', 'vertragus-inbox.json')
    expect(readFileSync(join(dir, 'vertragus-inbox.json'), 'utf8')).toBe('{"ideas":[1]}')
    expect(existsSync(join(dir, 'orca-inbox.json'))).toBe(true)
  })

  it('never overwrites an existing target file', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'orca-inbox.json'), 'old')
    writeFileSync(join(dir, 'vertragus-inbox.json'), 'new')
    adoptLegacyFile(dir, 'orca-inbox.json', 'vertragus-inbox.json')
    expect(readFileSync(join(dir, 'vertragus-inbox.json'), 'utf8')).toBe('new')
  })

  it('is a no-op without a legacy file', () => {
    const dir = tempDir()
    adoptLegacyFile(dir, 'orca-inbox.json', 'vertragus-inbox.json')
    expect(existsSync(join(dir, 'vertragus-inbox.json'))).toBe(false)
  })

  it('copies a legacy directory recursively without overwriting an existing target', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'orca-handoffs', 'nested'), { recursive: true })
    writeFileSync(join(dir, 'orca-handoffs', 'nested', 'briefing.md'), 'inhalt')
    adoptLegacyDir(dir, 'orca-handoffs', 'vertragus-handoffs')
    expect(readFileSync(join(dir, 'vertragus-handoffs', 'nested', 'briefing.md'), 'utf8')).toBe('inhalt')
    expect(existsSync(join(dir, 'orca-handoffs'))).toBe(true)

    writeFileSync(join(dir, 'vertragus-handoffs', 'marker.md'), 'bleibt')
    adoptLegacyDir(dir, 'orca-handoffs', 'vertragus-handoffs')
    expect(readFileSync(join(dir, 'vertragus-handoffs', 'marker.md'), 'utf8')).toBe('bleibt')
  })
})
