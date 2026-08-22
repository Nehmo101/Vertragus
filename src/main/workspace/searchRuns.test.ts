import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { ResumeDeps } from './resume'
import { MAX_JOURNAL_BYTES, searchRuns } from './searchRuns'

const RUNS = join('/repo', '.vertragus', 'runs')

/**
 * In-memory fs slice, same shape as resume.test.ts plus `sizes` so a test can
 * claim a journal is huge without materializing 5 MB of string.
 */
function fakeFs(input: {
  runs?: string[]
  files?: Record<string, string>
  mtimes?: Record<string, number>
  sizes?: Record<string, number>
}): ResumeDeps {
  const files = input.files ?? {}
  const mtimes = input.mtimes ?? {}
  const sizes = input.sizes ?? {}
  return {
    readdir: (async (dir: unknown) => {
      if (String(dir) !== RUNS || !input.runs) throw new Error('ENOENT')
      return input.runs.map((name) => ({ name, isDirectory: () => true }))
    }) as never,
    readFile: (async (path: unknown) => {
      const text = files[String(path)]
      if (text === undefined) throw new Error('ENOENT')
      return text
    }) as never,
    stat: (async (path: unknown) => {
      const key = String(path)
      if (files[key] === undefined && mtimes[key] === undefined && sizes[key] === undefined) {
        throw new Error('ENOENT')
      }
      return { mtimeMs: mtimes[key] ?? 0, size: sizes[key] ?? files[key]?.length ?? 0 }
    }) as never
  }
}

const meta = (workspaceId: string, startedAt: number, goal?: string): string =>
  JSON.stringify({
    workspaceId,
    profileId: 'p1',
    workspaceName: `Run ${workspaceId}`,
    startedAt,
    ...(goal ? { goal } : {})
  })

const done = (agentId: string, summary: string, seq: number): string =>
  JSON.stringify({
    type: 'agent_done',
    agentId,
    name: 'Caronte',
    roleId: 'worker',
    summary,
    status: 'success',
    seq,
    ts: seq
  })

const run = (
  workspaceId: string,
  startedAt: number,
  lines: string[],
  goal?: string
): Record<string, string> => ({
  [join(RUNS, workspaceId, 'meta.json')]: meta(workspaceId, startedAt, goal),
  [join(RUNS, workspaceId, 'events.jsonl')]: lines.join('\n')
})

describe('searchRuns', () => {
  it('finds hits across multiple runs, newest first, and skips non-matching runs', async () => {
    const deps = fakeFs({
      runs: ['ws-old', 'ws-new', 'ws-quiet'],
      files: {
        ...run('ws-old', 1_000, [done('a1', 'fixed the flaky parser test', 1)]),
        ...run('ws-new', 3_000, [done('a2', 'parser rework landed', 1)], 'rework the parser'),
        ...run('ws-quiet', 2_000, [done('a3', 'styled the panel', 1)])
      }
    })
    const result = await searchRuns('/repo', 'parser', {}, deps)

    expect(result.hits.map((hit) => hit.workspaceId)).toEqual(['ws-new', 'ws-old'])
    expect(result.searchedRuns).toBe(3)
    expect(result.skipped).toEqual([])
    // The newest run matched in BOTH meta.goal and an event line.
    expect(result.hits[0]).toMatchObject({
      workspaceName: 'Run ws-new',
      goal: 'rework the parser',
      startedAt: 3_000,
      totalMatches: 2
    })
    expect(result.hits[0]!.matches[0]).toMatchObject({ seq: 0, type: 'meta' })
    expect(result.hits[0]!.matches[1]).toMatchObject({ seq: 1, type: 'agent_done', agentId: 'a2' })
  })

  it('caps matches per run at maxHitsPerRun while totalMatches counts them all', async () => {
    const lines = Array.from({ length: 9 }, (_, index) => done(`a${index}`, 'needle here', index + 1))
    const deps = fakeFs({ runs: ['ws-1'], files: run('ws-1', 1_000, lines) })

    const result = await searchRuns('/repo', 'needle', { maxHitsPerRun: 2 }, deps)
    expect(result.hits[0]!.matches).toHaveLength(2)
    expect(result.hits[0]!.totalMatches).toBe(9)

    // Default cap is 5.
    const defaulted = await searchRuns('/repo', 'needle', {}, deps)
    expect(defaulted.hits[0]!.matches).toHaveLength(5)
    expect(defaulted.hits[0]!.totalMatches).toBe(9)
  })

  it('stops after maxResults runs with hits and only considers the newest maxRuns', async () => {
    const files = {
      ...run('ws-1', 1_000, [done('a', 'needle', 1)]),
      ...run('ws-2', 2_000, [done('a', 'needle', 1)]),
      ...run('ws-3', 3_000, [done('a', 'needle', 1)])
    }
    const deps = fakeFs({ runs: ['ws-1', 'ws-2', 'ws-3'], files })

    const capped = await searchRuns('/repo', 'needle', { maxResults: 2 }, deps)
    expect(capped.hits.map((hit) => hit.workspaceId)).toEqual(['ws-3', 'ws-2'])
    // Early stop: the third (oldest) run was never read.
    expect(capped.searchedRuns).toBe(2)

    // maxRuns windows the candidates BEFORE matching — the oldest run is out.
    const windowed = await searchRuns('/repo', 'needle', { maxRuns: 2 }, deps)
    expect(windowed.hits.map((hit) => hit.workspaceId)).toEqual(['ws-3', 'ws-2'])
    expect(windowed.searchedRuns).toBe(2)
  })

  it('is fail-soft: corrupt journal lines and a missing meta cost the piece, not the search', async () => {
    const deps = fakeFs({
      runs: ['ws-legacy', 'ws-broken'],
      files: {
        // No meta.json at all — ordered by journal mtime, still searchable.
        [join(RUNS, 'ws-legacy', 'events.jsonl')]: done('a1', 'the needle survives', 1),
        // Corrupt meta AND corrupt lines around one good event.
        [join(RUNS, 'ws-broken', 'meta.json')]: '{ not json',
        [join(RUNS, 'ws-broken', 'events.jsonl')]: [
          'not json at all',
          '{"type":"agent_done","half a torn needle line',
          done('a2', 'needle intact', 2)
        ].join('\n')
      },
      mtimes: {
        [join(RUNS, 'ws-legacy', 'events.jsonl')]: 2_000,
        [join(RUNS, 'ws-broken', 'events.jsonl')]: 1_000
      }
    })
    const result = await searchRuns('/repo', 'needle', {}, deps)

    expect(result.hits.map((hit) => hit.workspaceId)).toEqual(['ws-legacy', 'ws-broken'])
    expect(result.hits[0]!.workspaceName).toBeUndefined()
    // The torn line dropped — only the parsed event matched.
    expect(result.hits[1]!.totalMatches).toBe(1)
    expect(result.hits[1]!.matches[0]).toMatchObject({ seq: 2, agentId: 'a2' })
  })

  it('a repo without journals searches zero runs instead of throwing', async () => {
    expect(await searchRuns('/repo', 'anything', {}, fakeFs({}))).toEqual({
      hits: [],
      searchedRuns: 0,
      skipped: []
    })
  })

  it('skips a journal over 5 MB and names it — never a silent gap', async () => {
    const deps = fakeFs({
      runs: ['ws-huge', 'ws-ok'],
      files: {
        ...run('ws-huge', 2_000, [done('a1', 'needle drowned', 1)]),
        ...run('ws-ok', 1_000, [done('a2', 'needle found', 1)])
      },
      sizes: { [join(RUNS, 'ws-huge', 'events.jsonl')]: MAX_JOURNAL_BYTES + 1 }
    })
    const result = await searchRuns('/repo', 'needle', {}, deps)

    expect(result.skipped).toEqual(['ws-huge'])
    expect(result.hits.map((hit) => hit.workspaceId)).toEqual(['ws-ok'])
    // A skipped run does not count as searched — coverage stays honest.
    expect(result.searchedRuns).toBe(1)
  })

  it('includes the CURRENT run — its journal is on disk like any other', async () => {
    // Nothing distinguishes the live run's directory; the newest run here IS
    // the current one and its half-written journal (torn last line) matches.
    const deps = fakeFs({
      runs: ['ws-done', 'ws-current'],
      files: {
        ...run('ws-done', 1_000, [done('a1', 'old work', 1)]),
        [join(RUNS, 'ws-current', 'meta.json')]: meta('ws-current', 5_000, 'live goal'),
        [join(RUNS, 'ws-current', 'events.jsonl')]:
          `${done('a2', 'current needle', 1)}\n{"type":"agent_prog`
      }
    })
    const result = await searchRuns('/repo', 'needle', {}, deps)
    expect(result.hits.map((hit) => hit.workspaceId)).toEqual(['ws-current'])
    expect(result.hits[0]!.goal).toBe('live goal')
  })

  it('matches case-insensitively and whitespace-flexibly — substring, no regex', async () => {
    const deps = fakeFs({
      runs: ['ws-1'],
      files: run('ws-1', 1_000, [done('a1', 'Fix the Parser now', 1)])
    })
    // Case folded, query whitespace runs collapsed to match single spaces.
    expect((await searchRuns('/repo', 'fix   THE\tparser', {}, deps)).hits).toHaveLength(1)
    // Regex metacharacters are literal text, not patterns.
    expect((await searchRuns('/repo', 'f.x the parser', {}, deps)).hits).toHaveLength(0)
    expect((await searchRuns('/repo', 'nope', {}, deps)).hits).toHaveLength(0)
  })

  it('excerpts ±120 chars around the first match, whitespace-flattened', async () => {
    const summary = `${'a'.repeat(300)} the needle sits here ${'z'.repeat(300)}`
    const deps = fakeFs({ runs: ['ws-1'], files: run('ws-1', 1_000, [done('a1', summary, 1)]) })

    const result = await searchRuns('/repo', 'needle sits', {}, deps)
    const excerpt = result.hits[0]!.matches[0]!.excerpt
    expect(excerpt).toContain('needle sits')
    // 120 before + needle + 120 after — the 300-char runs are trimmed.
    expect(excerpt.length).toBe(240 + 'needle sits'.length)
    expect(excerpt.startsWith('a'.repeat(10))).toBe(true)
    expect(excerpt).not.toContain('a'.repeat(130))
    expect(excerpt).not.toMatch(/\s{2,}/)
  })

  it('matches meta.workspaceName too, as a seq-0 meta match', async () => {
    const deps = fakeFs({
      runs: ['ws-payments'],
      files: run('ws-payments', 1_000, [done('a1', 'unrelated', 1)])
    })
    const result = await searchRuns('/repo', 'run ws-payments', {}, deps)
    expect(result.hits[0]!.matches).toEqual([
      { seq: 0, type: 'meta', excerpt: 'Run ws-payments' }
    ])
  })
})
