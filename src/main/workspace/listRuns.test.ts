import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { ResumeDeps } from './resume'
import { listRuns, readRun } from './listRuns'
import { MAX_JOURNAL_BYTES } from './searchRuns'

const RUNS = join('/repo', '.vertragus', 'runs')

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

const meta = (
  workspaceId: string,
  startedAt: number,
  extra: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    workspaceId,
    profileId: extra.profileId ?? 'p1',
    workspaceName: extra.workspaceName ?? `Run ${workspaceId}`,
    startedAt,
    ...extra
  })

const started = (
  agentId: string,
  seq: number,
  extra: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    type: 'agent_started',
    agentId,
    name: agentId,
    roleId: extra.roleId ?? 'worker',
    seq,
    ts: extra.ts ?? seq * 1_000,
    ...extra
  })

const runFiles = (
  workspaceId: string,
  startedAt: number,
  lines: string[],
  extra: Record<string, unknown> = {}
): Record<string, string> => ({
  [join(RUNS, workspaceId, 'meta.json')]: meta(workspaceId, startedAt, extra),
  [join(RUNS, workspaceId, 'events.jsonl')]: lines.join('\n')
})

describe('listRuns', () => {
  it('returns newest first, skips other profiles, and includes meta-less journals', async () => {
    const deps = fakeFs({
      runs: ['ws-old', 'ws-new', 'ws-other', 'ws-legacy'],
      files: {
        ...runFiles('ws-old', 1_000, [started('a1', 1)], { goal: 'fix the parser' }),
        ...runFiles('ws-new', 3_000, [started('a2', 1), started('a3', 2)], {
          goal: 'ship the intake loop',
          endedAt: 4_000,
          endReason: 'user_stop'
        }),
        ...runFiles('ws-other', 2_000, [started('x', 1)], { profileId: 'p2' }),
        [join(RUNS, 'ws-legacy', 'events.jsonl')]: started('legacy', 1)
      },
      mtimes: { [join(RUNS, 'ws-legacy', 'events.jsonl')]: 500 }
    })

    const rows = await listRuns('/repo', 'p1', deps)
    expect(rows.map((row) => row.workspaceId)).toEqual(['ws-new', 'ws-old', 'ws-legacy'])
    expect(rows[0]).toMatchObject({
      status: 'stopped',
      endReason: 'user_stop',
      agentCount: 2,
      durationMs: 1_000
    })
    expect(rows[1]).toMatchObject({ status: 'running', goal: 'fix the parser', agentCount: 1 })
    expect(rows[2]).toMatchObject({ workspaceId: 'ws-legacy', status: 'running' })
  })

  it('names a huge journal instead of scanning it', async () => {
    const deps = fakeFs({
      runs: ['ws-huge'],
      files: runFiles('ws-huge', 1_000, [started('a1', 1)], { endedAt: 2_000, endReason: 'retro' }),
      sizes: { [join(RUNS, 'ws-huge', 'events.jsonl')]: MAX_JOURNAL_BYTES + 1 }
    })
    const rows = await listRuns('/repo', 'p1', deps)
    expect(rows).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-huge',
        skipped: 'too_large',
        status: 'stopped',
        endReason: 'retro'
      })
    ])
    expect(rows[0]?.agentCount).toBeUndefined()
  })

  it('is empty when the repo has no journals', async () => {
    expect(await listRuns('/repo', 'p1', fakeFs({}))).toEqual([])
  })
})

describe('readRun', () => {
  it('returns events, meta and tasks for one id of this profile', async () => {
    const deps = fakeFs({
      runs: ['ws-1'],
      files: {
        ...runFiles('ws-1', 1_000, [started('a1', 1, { parentId: 'w1' })]),
        [join(RUNS, 'ws-1', 'tasks.json')]: JSON.stringify({
          schemaVersion: 1,
          nextTaskNumber: 2,
          tasks: [
            {
              taskId: 'task-1',
              revision: 1,
              subject: 'Intake brief',
              description: '',
              status: 'completed',
              blockedBy: [],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      }
    })
    const view = await readRun('/repo', 'p1', 'ws-1', deps)
    expect(view?.events).toHaveLength(1)
    expect(view?.events[0]).toMatchObject({ parentId: 'w1' })
    expect(view?.tasks?.tasks[0]?.subject).toBe('Intake brief')
  })

  it('refuses a run that belongs to another profile', async () => {
    const deps = fakeFs({
      runs: ['ws-1'],
      files: runFiles('ws-1', 1_000, [started('a1', 1)], { profileId: 'p2' })
    })
    expect(await readRun('/repo', 'p1', 'ws-1', deps)).toBeUndefined()
  })

  it('names a huge journal on get instead of swallowing it', async () => {
    const deps = fakeFs({
      runs: ['ws-huge'],
      files: runFiles('ws-huge', 1_000, [started('a1', 1)]),
      sizes: { [join(RUNS, 'ws-huge', 'events.jsonl')]: MAX_JOURNAL_BYTES + 8 }
    })
    const view = await readRun('/repo', 'p1', 'ws-huge', deps)
    expect(view).toMatchObject({ skipped: 'too_large', events: [] })
  })
})
