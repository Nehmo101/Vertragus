import { describe, expect, it } from 'vitest'
import { resolveGithubLocalPath, resolveGithubLocalPathOptional } from './localPath'

describe('resolveGithubLocalPath', () => {
  it('resolves a normal absolute path', () => {
    const resolved = resolveGithubLocalPath('C:\\git\\demo')
    expect(resolved).toMatch(/git[\\/]demo$/)
  })

  it('rejects traversal segments in raw input', () => {
    expect(() => resolveGithubLocalPath('C:\\git\\..\\secret')).toThrow(/Traversal/)
    expect(() => resolveGithubLocalPath('../escape')).toThrow(/Traversal/)
  })

  it('rejects device paths on Windows', () => {
    expect(() => resolveGithubLocalPath('\\\\?\\C:\\git')).toThrow(/Geräte/)
    expect(() => resolveGithubLocalPath('\\\\server\\share\\repo')).toThrow(/Geräte/)
  })

  it('returns empty string for optional empty input', () => {
    expect(resolveGithubLocalPathOptional('', 'Ziel')).toBe('')
    expect(resolveGithubLocalPathOptional(undefined, 'Ziel')).toBe('')
  })
})
