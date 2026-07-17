import { describe, expect, it } from 'vitest'
import { githubOwnerFromRemote, parseGithubProjects } from './github'

describe('githubOwnerFromRemote', () => {
  it.each([
    ['https://github.com/Nehmo101/Vertragus.git', 'Nehmo101'],
    ['git@github.com:Nehmo101/Vertragus.git', 'Nehmo101'],
    ['ssh://git@github.com/Nehmo101/Vertragus.git', 'Nehmo101']
  ])('extracts the owner from %s', (remote, expected) => {
    expect(githubOwnerFromRemote(remote)).toBe(expected)
  })

  it('ignores non-GitHub remotes', () => {
    expect(githubOwnerFromRemote('https://gitlab.com/acme/repo.git')).toBeUndefined()
  })
})

describe('parseGithubProjects', () => {
  it('normalizes, sorts and filters gh project JSON', () => {
    const projects = parseGithubProjects(
      JSON.stringify({
        projects: [
          { number: 9, title: 'Release', url: 'https://github.com/orgs/acme/projects/9' },
          { number: 2, title: 'Backlog', url: 'https://github.com/orgs/acme/projects/2' },
          { number: 3, title: '', url: 'https://github.com/orgs/acme/projects/3' }
        ]
      }),
      'acme'
    )

    expect(projects.map((project) => project.number)).toEqual([2, 9])
    expect(projects[0]).toEqual({
      owner: 'acme',
      number: 2,
      title: 'Backlog',
      url: 'https://github.com/orgs/acme/projects/2',
      closed: false
    })
  })
})
