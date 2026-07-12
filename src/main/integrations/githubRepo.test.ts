import { describe, expect, it } from 'vitest'
import { githubRepoInternals } from './githubRepo'

describe('githubRepo helpers', () => {
  it.each([
    ['https://github.com/Nehmo101/Orca-Strator.git', 'Nehmo101', 'Orca-Strator'],
    ['git@github.com:acme/demo.git', 'acme', 'demo']
  ])('parses owner/repo from %s', (remote, owner, repo) => {
    expect(githubRepoInternals.parseRepoFromRemote(remote)).toEqual({ owner, repo })
  })

  it('detects remote divergence from bound repository', () => {
    expect(
      githubRepoInternals.remotesMatchBoundRepo(
        'https://github.com/other/repo.git',
        'Nehmo101',
        'Orca-Strator'
      )
    ).toBe(false)
    expect(
      githubRepoInternals.remotesMatchBoundRepo(
        'git@github.com:Nehmo101/Orca-Strator.git',
        'Nehmo101',
        'Orca-Strator'
      )
    ).toBe(true)
  })

  it('rejects invalid repo slugs', () => {
    expect(() => githubRepoInternals.normalizeRepoSlug('../evil', 'Repository')).toThrow(/Ungültig/)
  })
})
