import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { TaskBoardState } from '@shared/schema/tasks'
import {
  boardForResume,
  buildResumeBriefing,
  latestRun,
  markSuccessionConsumed,
  readRunEvents,
  readRunTasks,
  readSuccessionPackage,
  type ResumeDeps
} from './resume'

const RUNS = join('/repo', '.vertragus', 'runs')

/** In-memory fs slice: directories under runs/, files by absolute path. */
function fakeFs(input: {
  runs?: string[]
  files?: Record<string, string>
  mtimes?: Record<string, number>
}): ResumeDeps {
  const files = input.files ?? {}
  const mtimes = input.mtimes ?? {}
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
      const at = mtimes[String(path)]
      if (at === undefined) throw new Error('ENOENT')
      return { mtimeMs: at }
    }) as never
  }
}

const meta = (workspaceId: string, profileId: string, startedAt: number, goal?: string): string =>
  JSON.stringify({ workspaceId, profileId, workspaceName: `Run ${workspaceId}`, startedAt, ...(goal ? { goal } : {}) })

const started = (agentId: string, name: string, branch: string, seq: number): string =>
  JSON.stringify({
    type: 'agent_started',
    agentId,
    name,
    roleId: 'worker',
    branch,
    seq,
    ts: seq
  })

const done = (agentId: string, name: string, summary: string, seq: number, status = 'success'): string =>
  JSON.stringify({ type: 'agent_done', agentId, name, roleId: 'worker', summary, status, seq, ts: seq })

describe('readRunEvents', () => {
  it('parses the journal fail-soft: corrupt and torn lines drop, the rest stay', async () => {
    const deps = fakeFs({
      files: {
        [join(RUNS, 'ws-1', 'events.jsonl')]: [
          started('a1', 'Caronte', 'vertragus/x/a1', 1),
          'not json at all',
          '{"type":"agent_done","half a torn line',
          JSON.stringify({ type: 'unknown_event', seq: 2, ts: 2 }),
          done('a1', 'Caronte', 'did the thing', 3)
        ].join('\n')
      }
    })
    const events = await readRunEvents('/repo', 'ws-1', deps)
    expect(events?.map((event) => event.type)).toEqual(['agent_started', 'agent_done'])
  })

  it('a missing journal is undefined, not an empty run', async () => {
    expect(await readRunEvents('/repo', 'ws-1', fakeFs({}))).toBeUndefined()
  })
})

describe('latestRun', () => {
  it('picks the newest run of THIS profile and skips other profiles', async () => {
    const deps = fakeFs({
      runs: ['ws-old', 'ws-new', 'ws-other'],
      files: {
        [join(RUNS, 'ws-old', 'meta.json')]: meta('ws-old', 'p1', 1_000),
        [join(RUNS, 'ws-old', 'events.jsonl')]: started('a1', 'Old', 'b', 1),
        [join(RUNS, 'ws-new', 'meta.json')]: meta('ws-new', 'p1', 2_000, 'ship it'),
        [join(RUNS, 'ws-new', 'events.jsonl')]: started('a2', 'New', 'b2', 1),
        // Newer than everything, but another profile's run on the same repo.
        [join(RUNS, 'ws-other', 'meta.json')]: meta('ws-other', 'p2', 9_000),
        [join(RUNS, 'ws-other', 'events.jsonl')]: started('a3', 'Other', 'b3', 1)
      }
    })
    const run = await latestRun('/repo', 'p1', deps)
    expect(run?.workspaceId).toBe('ws-new')
    expect(run?.meta?.goal).toBe('ship it')
  })

  it('a meta-less run stays eligible, ordered by journal mtime', async () => {
    const deps = fakeFs({
      runs: ['ws-legacy'],
      files: { [join(RUNS, 'ws-legacy', 'events.jsonl')]: started('a1', 'Legacy', 'b', 1) },
      mtimes: { [join(RUNS, 'ws-legacy', 'events.jsonl')]: 5_000 }
    })
    const run = await latestRun('/repo', 'p1', deps)
    expect(run?.workspaceId).toBe('ws-legacy')
    expect(run?.meta).toBeUndefined()
  })

  it('a repo without journals resolves undefined instead of throwing', async () => {
    expect(await latestRun('/repo', 'p1', fakeFs({}))).toBeUndefined()
  })
})

describe('buildResumeBriefing', () => {
  it('lists goal, agents with branches and last done reports, and the honest caveats', async () => {
    const deps = fakeFs({
      runs: ['ws-1'],
      files: {
        [join(RUNS, 'ws-1', 'meta.json')]: meta('ws-1', 'p1', 1_000, 'fix the parser'),
        [join(RUNS, 'ws-1', 'events.jsonl')]: [
          started('a1', 'Caronte', 'vertragus/inferno/a1', 1),
          started('a2', 'Minosse', 'vertragus/inferno/a2', 2),
          done('a1', 'Caronte', 'first report', 3),
          // Last-wins: the re-tasked agent's newest report is the truth.
          done('a1', 'Caronte', 'fixed tokenizer,\nran the suite', 4)
        ].join('\n')
      }
    })
    const run = (await latestRun('/repo', 'p1', deps))!
    const briefing = buildResumeBriefing(run)

    expect(briefing).toContain('resumes an earlier run ("Run ws-1")')
    expect(briefing).toContain('Goal of that run: fix the parser')
    expect(briefing).toContain('- Caronte (worker) on branch vertragus/inferno/a1 — reported success: fixed tokenizer, ran the suite')
    expect(briefing).toContain('- Minosse (worker) on branch vertragus/inferno/a2 — no done report')
    expect(briefing).toContain('start_agent{baseBranch: "<branch>"}')
    expect(briefing).toContain('every question or ticket from it is void')
    expect(briefing).toContain('Past runs are searchable with search_runs.')
  })

  it('an empty run still produces the caveats, never a lie about agents', () => {
    const briefing = buildResumeBriefing({ workspaceId: 'ws-9', events: [] })
    expect(briefing).toContain('("ws-9")')
    expect(briefing).toContain('started no agents')
    expect(briefing).toContain('No process from that run is still alive')
  })

  it('S4: mentions open tasks and points at task_list — silent without a board', () => {
    const run = { workspaceId: 'ws-9', events: [] }
    const briefing = buildResumeBriefing(run, {
      schemaVersion: 1,
      nextTaskNumber: 4,
      tasks: [
        task('task-1', 'pending'),
        { ...task('task-2', 'completed'), subject: 'Done work' },
        { ...task('task-3', 'deleted'), subject: 'Gone work' }
      ]
    })
    expect(briefing).toContain('task_list')
    expect(briefing).toContain('- task-1: subject of task-1')
    expect(briefing).not.toContain('Done work')
    expect(briefing).not.toContain('Gone work')
    expect(buildResumeBriefing(run)).not.toContain('task_list')
  })
})

const task = (taskId: string, status: TaskBoardState['tasks'][number]['status'], extra: Partial<TaskBoardState['tasks'][number]> = {}): TaskBoardState['tasks'][number] => ({
  taskId,
  revision: 1,
  subject: `subject of ${taskId}`,
  description: '',
  status,
  blockedBy: [],
  createdAt: 1,
  updatedAt: 1,
  ...extra
})

describe('readRunTasks — S4', () => {
  it('reads and validates tasks.json of one run', async () => {
    const board: TaskBoardState = { schemaVersion: 1, nextTaskNumber: 2, tasks: [task('task-1', 'pending')] }
    const deps = fakeFs({ files: { [join(RUNS, 'ws-1', 'tasks.json')]: JSON.stringify(board) } })
    expect(await readRunTasks('/repo', 'ws-1', deps)).toEqual(board)
  })

  it('fails soft: missing, corrupt or invalid tasks.json is undefined', async () => {
    expect(await readRunTasks('/repo', 'ws-1', fakeFs({}))).toBeUndefined()
    expect(
      await readRunTasks('/repo', 'ws-1', fakeFs({ files: { [join(RUNS, 'ws-1', 'tasks.json')]: 'not json' } }))
    ).toBeUndefined()
    expect(
      await readRunTasks(
        '/repo',
        'ws-1',
        fakeFs({ files: { [join(RUNS, 'ws-1', 'tasks.json')]: JSON.stringify({ schemaVersion: 99 }) } })
      )
    ).toBeUndefined()
  })
})

describe('boardForResume — S4', () => {
  it('frees dead owners: in_progress becomes pending and owner-free, revision bumps', () => {
    const revived = boardForResume({
      schemaVersion: 1,
      nextTaskNumber: 4,
      tasks: [
        task('task-1', 'in_progress', { ownerAgentId: 'dead-agent', revision: 5 }),
        task('task-2', 'pending'),
        task('task-3', 'completed', { ownerAgentId: 'dead-agent' })
      ]
    })
    expect(revived.tasks[0]).toMatchObject({ taskId: 'task-1', status: 'pending', revision: 6 })
    expect(revived.tasks[0]!.ownerAgentId).toBeUndefined()
    // Everything not in_progress stays exactly as journaled — completed keeps
    // its (dead) owner as history, pending was untouched anyway.
    expect(revived.tasks[1]).toEqual(task('task-2', 'pending'))
    expect(revived.tasks[2]).toEqual(task('task-3', 'completed', { ownerAgentId: 'dead-agent' }))
    expect(revived.nextTaskNumber).toBe(4)
  })
})

/** The smallest package the zod schema accepts. */
function successionPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'orchestrator_succession',
    workspaceId: 'ws-1',
    workspaceName: 'Paradiso',
    profileId: 'p1',
    createdAt: 5,
    reason: 'context_full',
    predecessor: { agentId: 'orch-1', name: 'Virgilio', providerId: 'claude' },
    successorAgentId: 'orch-2',
    eventCursor: 42,
    recentEvents: [],
    agents: [],
    openQuestions: [],
    tasks: [],
    decisions: [],
    risks: [],
    nextActions: [],
    branchesOfInterest: [],
    limits: { maxChars: 48_000, truncated: [] },
    ...overrides
  }
}

describe('readSuccessionPackage — C6 crash recovery', () => {
  it('reads the frozen package of a run that died mid-handoff', async () => {
    const deps = fakeFs({
      files: { [join(RUNS, 'ws-1', 'succession.json')]: JSON.stringify(successionPackage()) }
    })
    const pkg = await readSuccessionPackage('/repo', 'ws-1', deps)
    expect(pkg).toMatchObject({ workspaceId: 'ws-1', eventCursor: 42, reason: 'context_full' })
  })

  it('ignores a package a cutover already consumed — recover once, by rename', async () => {
    const deps = fakeFs({
      files: {
        [join(RUNS, 'ws-1', 'succession.consumed.json')]: JSON.stringify(successionPackage())
      }
    })
    expect(await readSuccessionPackage('/repo', 'ws-1', deps)).toBeUndefined()
  })

  it('fails soft: missing, torn or schema-violating files cost the recovery only', async () => {
    expect(await readSuccessionPackage('/repo', 'ws-1', fakeFs({}))).toBeUndefined()
    expect(
      await readSuccessionPackage(
        '/repo',
        'ws-1',
        fakeFs({ files: { [join(RUNS, 'ws-1', 'succession.json')]: '{"schemaVersion":1,' } })
      )
    ).toBeUndefined()
    expect(
      await readSuccessionPackage(
        '/repo',
        'ws-1',
        fakeFs({
          files: {
            [join(RUNS, 'ws-1', 'succession.json')]: JSON.stringify(
              successionPackage({ kind: 'something_else' })
            )
          }
        })
      )
    ).toBeUndefined()
  })
})

describe('markSuccessionConsumed — C6', () => {
  it('renames the package so the next resume cannot replay it', async () => {
    const moves: Array<[string, string]> = []
    await markSuccessionConsumed('/repo', 'ws-1', {
      rename: (async (from: unknown, to: unknown) => {
        moves.push([String(from), String(to)])
      }) as never
    })
    expect(moves).toEqual([
      [join(RUNS, 'ws-1', 'succession.json'), join(RUNS, 'ws-1', 'succession.consumed.json')]
    ])
  })

  it('swallows a failing rename — a replayable package beats a failed start', async () => {
    await expect(
      markSuccessionConsumed('/repo', 'ws-1', {
        rename: (async () => {
          throw new Error('EPERM')
        }) as never
      })
    ).resolves.toBeUndefined()
  })
})
