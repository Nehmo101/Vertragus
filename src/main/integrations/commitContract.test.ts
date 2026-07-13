import { describe, expect, it } from 'vitest'
import { isFullCommitHash, noTaskChanges, verifiedTaskCommit } from './commitContract'

describe('task commit contract', () => {
  it('uses an explicit no-changes result', () => {
    expect(noTaskChanges()).toEqual({ result: 'no-changes', noChanges: true })
  })

  it('accepts verified SHA-1 and SHA-256 commit ids', () => {
    const sha1 = 'a'.repeat(40)
    const sha256 = 'b'.repeat(64)
    expect(isFullCommitHash(sha1)).toBe(true)
    expect(verifiedTaskCommit(sha1, sha1.toUpperCase())).toEqual({
      result: 'committed',
      commit: sha1,
      noChanges: false
    })
    expect(isFullCommitHash(sha256)).toBe(true)
  })

  it('rejects abbreviated, malformed, and mismatched ids', () => {
    expect(isFullCommitHash('abc1234')).toBe(false)
    expect(() => verifiedTaskCommit('a'.repeat(40), 'b'.repeat(40))).toThrow(/Commit-Vertrag/)
    expect(() => verifiedTaskCommit('not-a-hash', 'not-a-hash')).toThrow(/Commit-Vertrag/)
  })
})
