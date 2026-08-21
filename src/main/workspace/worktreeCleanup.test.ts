import { describe, expect, it, vi } from 'vitest'
import type { WorktreeEntry } from '@main/agents/worktree'
import { createWorktreeCleanup, worktreePathKey } from './worktreeCleanup'

const REPO = '/repo'

/** The main checkout plus two Vertragus worktrees, one of them detached. */
function entries(): WorktreeEntry[] {
  return [
    { path: '/repo', branch: 'main', detached: false },
    { path: '/repo/.vertragus/worktrees/a1', branch: 'vertragus/paradiso/caronte', detached: false },
    { path: '/repo/.vertragus/worktrees/a2', detached: true },
    // A worktree the user created elsewhere — never Vertragus' to touch.
    { path: '/somewhere/else', branch: 'feature/x', detached: false }
  ]
}

function setup(
  options: { active?: string[]; list?: WorktreeEntry[]; locale?: string } = {}
) {
  const list = vi.fn(async () => options.list ?? entries())
  const remove = vi.fn(async () => undefined)
  const cleanup = createWorktreeCleanup({
    repoPathFor: (profileId) => (profileId === 'p1' ? REPO : undefined),
    activeWorktreePaths: () => options.active ?? [],
    list,
    remove,
    ...(options.locale ? { locale: () => options.locale } : {})
  })
  return { cleanup, list, remove }
}

describe('worktreePathKey', () => {
  it('makes Windows and porcelain spellings of one path compare equal', () => {
    expect(worktreePathKey('C:\\repo\\.vertragus\\worktrees\\a1')).toBe(
      worktreePathKey('C:/repo/.vertragus/worktrees/a1/')
    )
  })
})

describe('listStale', () => {
  it('lists only Vertragus worktrees that no live agent works in', async () => {
    const { cleanup } = setup({ active: ['/repo/.vertragus/worktrees/a1'] })
    await expect(cleanup.listStale('p1')).resolves.toEqual([
      { path: '/repo/.vertragus/worktrees/a2' }
    ])
  })

  it('never offers the main checkout or a foreign worktree', async () => {
    const { cleanup } = setup()
    const stale = await cleanup.listStale('p1')
    expect(stale.map((entry) => entry.path)).toEqual([
      '/repo/.vertragus/worktrees/a1',
      '/repo/.vertragus/worktrees/a2'
    ])
  })

  it('matches active paths across separator spellings', async () => {
    // The manager reports join()-built paths; git porcelain prints /-paths.
    const { cleanup } = setup({ active: ['\\repo\\.vertragus\\worktrees\\a1'] })
    const stale = await cleanup.listStale('p1')
    expect(stale.map((entry) => entry.path)).toEqual(['/repo/.vertragus/worktrees/a2'])
  })

  it('refuses an unknown profile', async () => {
    const { cleanup } = setup()
    await expect(cleanup.listStale('nope')).rejects.toThrow(/Unbekanntes Profil/)
  })
})

/**
 * Both refusals land in the panel's error row verbatim. Neither carries an
 * umlaut, so the drift guard's letter test never saw them — these cases are
 * what pins them to the locale table instead of to this module.
 */
describe('locale', () => {
  it('speaks English when the stored UI locale is en', async () => {
    const { cleanup } = setup({ locale: 'en' })
    await expect(cleanup.listStale('nope')).rejects.toThrow('Unknown profile nope')
    await expect(cleanup.remove('p1', '/repo')).rejects.toThrow(
      'Worktree /repo cannot be removed — it is active, foreign, or does not exist.'
    )
  })
})

describe('remove', () => {
  it('removes a stale worktree and answers with the refreshed list', async () => {
    const removed: string[] = []
    const state = entries()
    const list = vi.fn(async () => state)
    const remove = vi.fn(async (_repo: string, path: string) => {
      removed.push(path)
      const index = state.findIndex((entry) => entry.path === path)
      if (index >= 0) state.splice(index, 1)
    })
    const cleanup = createWorktreeCleanup({
      repoPathFor: () => REPO,
      activeWorktreePaths: () => [],
      list,
      remove
    })

    const after = await cleanup.remove('p1', '/repo/.vertragus/worktrees/a1')

    expect(removed).toEqual(['/repo/.vertragus/worktrees/a1'])
    expect(after).toEqual([{ path: '/repo/.vertragus/worktrees/a2' }])
  })

  it('refuses a live agent’s worktree — stale-list membership is the authorization', async () => {
    const { cleanup, remove } = setup({ active: ['/repo/.vertragus/worktrees/a1'] })
    await expect(cleanup.remove('p1', '/repo/.vertragus/worktrees/a1')).rejects.toThrow(
      /nicht entfernbar/
    )
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses the main checkout and paths outside the worktree root', async () => {
    const { cleanup, remove } = setup()
    await expect(cleanup.remove('p1', '/repo')).rejects.toThrow(/nicht entfernbar/)
    await expect(cleanup.remove('p1', '/somewhere/else')).rejects.toThrow(/nicht entfernbar/)
    await expect(cleanup.remove('p1', '/etc/passwd')).rejects.toThrow(/nicht entfernbar/)
    expect(remove).not.toHaveBeenCalled()
  })

  it('accepts the panel’s path in either separator spelling', async () => {
    const { cleanup, remove } = setup()
    await cleanup.remove('p1', '\\repo\\.vertragus\\worktrees\\a2')
    // git gets the porcelain spelling it reported, not the caller's.
    expect(remove).toHaveBeenCalledWith(REPO, '/repo/.vertragus/worktrees/a2', undefined)
  })
})
