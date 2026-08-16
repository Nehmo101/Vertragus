import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KIMI_HOME_DIR,
  KIMI_TRUST_DIR,
  ensureKimiWorkspaceTrust,
  kimiTrustFileName,
  kimiTrustRoots
} from './kimiTrust'

const temps: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-trust-home-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('kimiTrustFileName', () => {
  /**
   * Pinned against the real store on a machine where Kimi asked and was
   * answered by hand: `~/.kimi-code/workspace-trust/wd_uwe_af4307bfa0b7` holds
   * `{"root":"C:\\git\\uwe"}`. That entry is what identified the scheme —
   * lower-cased last segment, then 12 hex of SHA-256 over the forward-slash
   * form — so it is also what guards it.
   */
  // join() and not a literal `C:\…`: the slug is the LAST PATH SEGMENT, and a
  // POSIX runner does not read a backslash as a separator — the whole Windows
  // path would become one segment there. Both platforms end up hashing
  // "C:/git/uwe", which is exactly the spelling the record was written under.
  it('reproduces a record Kimi itself wrote', () => {
    expect(kimiTrustFileName(join('C:', 'git', 'uwe'))).toBe('wd_uwe_af4307bfa0b7')
  })

  it('hashes the forward-slash spelling, case included', () => {
    const root = join('C:', 'Users', 'lasse')
    const hash = createHash('sha256').update('C:/Users/lasse').digest('hex').slice(0, 12)
    expect(kimiTrustFileName(root)).toBe(`wd_lasse_${hash}`)
    // A different casing is a different folder to Kimi — never normalise it.
    expect(kimiTrustFileName(join('C:', 'Users', 'LASSE'))).not.toBe(kimiTrustFileName(root))
  })

  it('keeps the slug filesystem-safe without touching the hash', () => {
    const name = kimiTrustFileName(join(tmpdir(), 'Weird Name!'))
    expect(name.startsWith('wd_weird-name_')).toBe(true)
  })
})

describe('kimiTrustRoots', () => {
  it('adds the canonical on-disk spelling when it differs', () => {
    const roots = kimiTrustRoots('C:\\tmp\\Repo', () => 'C:\\tmp\\repo')
    expect(roots).toEqual([resolve('C:\\tmp\\Repo'), 'C:\\tmp\\repo'])
  })

  it('survives a directory that does not exist yet', () => {
    const roots = kimiTrustRoots('C:\\tmp\\Repo', () => {
      throw new Error('ENOENT')
    })
    expect(roots).toEqual([resolve('C:\\tmp\\Repo')])
  })
})

describe('ensureKimiWorkspaceTrust', () => {
  it('writes a record Kimi can find, and nothing else', () => {
    const home = tempHome()
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-trust-ws-'))
    temps.push(workspace)

    const result = ensureKimiWorkspaceTrust(workspace, {
      homeDir: () => home,
      realPath: (path) => path,
      now: () => 1_700_000_000_000
    })

    expect(result.outcome).toBe('granted')
    const trustDir = join(home, KIMI_HOME_DIR, KIMI_TRUST_DIR)
    const files = readdirSync(trustDir)
    expect(files).toEqual([kimiTrustFileName(resolve(workspace))])
    expect(JSON.parse(readFileSync(join(trustDir, files[0]!), 'utf8'))).toEqual({
      root: resolve(workspace),
      trustedAt: 1_700_000_000_000
    })
  })

  it('reports a failed write instead of taking the launch down with it', () => {
    const warn = vi.fn()
    const result = ensureKimiWorkspaceTrust('C:\\tmp\\ws', {
      homeDir: () => 'C:\\home',
      realPath: (path) => path,
      makeDir: () => undefined,
      writeFile: () => {
        throw new Error('EACCES')
      },
      warn
    })

    expect(result.outcome).toBe('skipped')
    expect(result.reason).toBe('write failed')
    expect(warn).toHaveBeenCalled()
  })

  it('does nothing without a workspace directory', () => {
    expect(ensureKimiWorkspaceTrust('   ').outcome).toBe('skipped')
  })
})
