import { describe, expect, it } from 'vitest'
import { formatPreflightFindings, runPublishPreflight } from './publishPreflight'

type GitCall = (cwd: string, args: string[]) => Promise<string>

function gitRunner(handlers: Record<string, string | Error>): GitCall {
  return async (_cwd, args) => {
    const key = args[0] === 'push' ? 'push' : args[0] === 'ls-remote' ? 'ls-remote' : 'rev-list'
    const result = handlers[key]
    if (result instanceof Error) throw result
    return result ?? ''
  }
}

describe('publish preflight', () => {
  it('passes with a reachable remote, unique branch and fresh base', async () => {
    const result = await runPublishPreflight(
      { cwd: '/repo', branch: 'vertragus/goal-x', base: 'main' },
      gitRunner({
        push: '',
        'ls-remote': 'sha\trefs/heads/main\nsha\trefs/heads/feature/a',
        'rev-list': '0 3'
      })
    )
    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.behindBase).toBe(false)
  })

  it('classifies auth failures and blocks the publish', async () => {
    const result = await runPublishPreflight(
      { cwd: '/repo', branch: 'vertragus/goal-x', base: 'main' },
      gitRunner({
        push: new Error('fatal: could not read Username for https://github.com: terminal prompts disabled'),
        'ls-remote': new Error('auth'),
        'rev-list': '0 1'
      })
    )
    expect(result.ok).toBe(false)
    expect(result.findings[0]).toMatchObject({ gate: 'preflight', code: 'push-auth' })
    expect(formatPreflightFindings(result.findings)).toContain('push-auth')
  })

  it('detects a casing-conflicting remote branch', async () => {
    const result = await runPublishPreflight(
      { cwd: '/repo', branch: 'vertragus/Goal-X', base: 'main' },
      gitRunner({
        push: '',
        'ls-remote': 'sha\trefs/heads/vertragus/goal-x',
        'rev-list': '0 1'
      })
    )
    expect(result.ok).toBe(false)
    expect(result.findings.map((finding) => finding.code)).toContain('branch-casing-conflict')
  })

  it('reports a moved base and an empty delivery as advisory findings', async () => {
    const result = await runPublishPreflight(
      { cwd: '/repo', branch: 'vertragus/goal-x', base: 'main' },
      gitRunner({
        push: '',
        'ls-remote': '',
        'rev-list': '4 0'
      })
    )
    // Advisory only: neither finding blocks the publish.
    expect(result.ok).toBe(true)
    expect(result.behindBase).toBe(true)
    expect(result.findings.map((finding) => finding.code).sort()).toEqual(
      ['base-moved', 'nothing-to-publish']
    )
  })
})
