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

  it('rejects traversal local paths before bind', async () => {
    expect(() => resolveGithubLocalPath('C:\\git\\..\\secret', 'Ziel')).toThrow(/Traversal/)
    await expect(
      bindGithubRepo({ owner: 'acme', repo: 'demo', localPath: '..\\escape', clone: true })
    ).rejects.toThrow(/Traversal|Ungültig/)
  })
})
