import { describe, expect, it } from 'vitest'
import { bindGithubRepo, githubRepoInternals } from './githubRepo'
import { resolveGithubLocalPath } from '@main/security/localPath'

describe('githubRepo helpers', () => {
  it.each([
    ['https://github.com/Nehmo101/Vertragus.git', 'Nehmo101', 'Vertragus'],
    ['git@github.com:acme/demo.git', 'acme', 'demo']
  ])('parses owner/repo from %s', (remote, owner, repo) => {
    expect(githubRepoInternals.parseRepoFromRemote(remote)).toEqual({ owner, repo })
  })

  it('detects remote divergence from bound repository', () => {
    expect(
      githubRepoInternals.remotesMatchBoundRepo(
        'https://github.com/other/repo.git',
        'Nehmo101',
        'Vertragus'
      )
    ).toBe(false)
    expect(
      githubRepoInternals.remotesMatchBoundRepo(
        'git@github.com:Nehmo101/Vertragus.git',
        'Nehmo101',
        'Vertragus'
      )
    ).toBe(true)
  })

  it('rejects invalid repo slugs', () => {
    expect(() => githubRepoInternals.normalizeRepoSlug('../evil', 'Repository')).toThrow(/Ungültig/)
  })

  it('accepts ordinary search queries including GitHub qualifiers', () => {
    expect(githubRepoInternals.sanitizeSearchQuery('  react state machine  ')).toBe('react state machine')
    expect(githubRepoInternals.sanitizeSearchQuery('language:go stars:>100')).toBe('language:go stars:>100')
  })

  it('rejects search queries that could inject shell or gh arguments', () => {
    // Shell metacharacters are inert without a shell, but option-injection and
    // control characters must still be refused.
    expect(() => githubRepoInternals.sanitizeSearchQuery('--limit')).toThrow(/"-"/)
    expect(() => githubRepoInternals.sanitizeSearchQuery('-x')).toThrow(/"-"/)
    const withNewline = `foo${String.fromCharCode(10)}bar`
    const withNull = `foo${String.fromCharCode(0)}calc`
    expect(() => githubRepoInternals.sanitizeSearchQuery(withNewline)).toThrow(/Steuerzeichen/)
    expect(() => githubRepoInternals.sanitizeSearchQuery(withNull)).toThrow(/Steuerzeichen/)
  })

  it('rejects traversal local paths before bind', async () => {
    expect(() => resolveGithubLocalPath('C:\\git\\..\\secret', 'Ziel')).toThrow(/Traversal/)
    await expect(
      bindGithubRepo({ owner: 'acme', repo: 'demo', localPath: '..\\escape', clone: true })
    ).rejects.toThrow(/Traversal|Ungültig/)
  })
})
