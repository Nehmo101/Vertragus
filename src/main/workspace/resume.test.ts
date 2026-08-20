import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildResumeBriefing, latestRun, readRunEvents, type ResumeDeps } from './resume'

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
  })

  it('an empty run still produces the caveats, never a lie about agents', () => {
    const briefing = buildResumeBriefing({ workspaceId: 'ws-9', events: [] })
    expect(briefing).toContain('("ws-9")')
    expect(briefing).toContain('started no agents')
    expect(briefing).toContain('No process from that run is still alive')
  })
})
