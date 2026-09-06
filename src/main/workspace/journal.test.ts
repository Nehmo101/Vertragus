import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { AgentEvent } from '@shared/schema/events'
import { createRunJournal, runDir, runMetaSchema, runsDir } from './journal'

const event = (seq: number): AgentEvent =>
  ({ type: 'agent_progress', agentId: 'a1', name: 'Caronte', roleId: 'worker', note: 'x', seq, ts: 1 }) as AgentEvent

describe('createRunJournal — E3 (write-only half)', () => {
  it('appends one JSON line per event under .vertragus/runs/<id>/', async () => {
    const lines: string[] = []
    const journal = createRunJournal('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      appendFile: (async (_path: unknown, data: unknown) => {
        lines.push(String(data))
      }) as never,
      warn: vi.fn()
    })

    expect(journal.path).toBe(join('/repo', '.vertragus', 'runs', 'ws-1', 'events.jsonl'))
    journal.append(event(1))
    journal.append(event(2))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'agent_progress', seq: 1 })
    expect(lines[0]!.endsWith('\n')).toBe(true)
  })

  it('writes the run meta as meta.json in the same directory', async () => {
    const writes: Array<{ path: string; data: string }> = []
    const journal = createRunJournal('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      appendFile: vi.fn(async () => undefined) as never,
      writeFile: (async (path: unknown, data: unknown) => {
        writes.push({ path: String(path), data: String(data) })
      }) as never,
      warn: vi.fn()
    })

    journal.writeMeta({
      workspaceId: 'ws-1',
      profileId: 'p1',
      workspaceName: 'Inferno I',
      goal: 'fix the bug',
      startedAt: 1_000
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe(join('/repo', '.vertragus', 'runs', 'ws-1', 'meta.json'))
    expect(JSON.parse(writes[0]!.data)).toMatchObject({ profileId: 'p1', goal: 'fix the bug' })
    expect(JSON.parse(writes[0]!.data)).not.toHaveProperty('endedAt')
  })

  it('writes brief.md next to meta and ignores unknown artifact names', async () => {
    const writes: Array<{ path: string; data: string }> = []
    const journal = createRunJournal('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      appendFile: vi.fn(async () => undefined) as never,
      writeFile: (async (path: unknown, data: unknown) => {
        writes.push({ path: String(path), data: String(data) })
      }) as never,
      warn: vi.fn()
    })
    journal.writeArtifact?.('brief.md', '# Run contract\n')
    journal.writeArtifact?.('brief.json', '{"recipe":"fix-and-verify"}\n')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writes.map((row) => row.path)).toEqual([
      join('/repo', '.vertragus', 'runs', 'ws-1', 'brief.md'),
      join('/repo', '.vertragus', 'runs', 'ws-1', 'brief.json')
    ])
  })

  it('A1: optional end fields parse on new metas and stay absent on old ones', () => {
    expect(
      runMetaSchema.parse({
        workspaceId: 'ws-1',
        profileId: 'p1',
        workspaceName: 'Inferno I',
        startedAt: 1,
        endedAt: 2,
        endReason: 'user_stop',
        pullRequestUrl: 'https://github.com/o/r/pull/1'
      })
    ).toMatchObject({ endReason: 'user_stop' })
    expect(
      runMetaSchema.parse({
        workspaceId: 'ws-1',
        profileId: 'p1',
        workspaceName: 'Inferno I',
        startedAt: 1
      })
    ).not.toHaveProperty('endedAt')
  })

  it('warns once and goes quiet after a write failure — never throws into the loop', async () => {
    const warn = vi.fn()
    const journal = createRunJournal('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      appendFile: (async () => {
        throw new Error('ENOSPC')
      }) as never,
      warn
    })

    journal.append(event(1))
    journal.append(event(2))
    journal.append(event(3))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('runDir', () => {
  it('names the folder the journal, the board and the spill store all write into', () => {
    const dir = runDir('/repo', 'ws-1')
    expect(dir).toBe(join(runsDir('/repo'), 'ws-1'))
    // The panel's run-artifact button hands exactly this path to the OS, so it
    // must be the directory the journal itself uses — not a parallel guess.
    expect(
      createRunJournal('/repo', 'ws-1', {
        mkdir: vi.fn(async () => undefined),
        appendFile: vi.fn(async () => undefined) as never,
        warn: vi.fn()
      }).path
    ).toBe(join(dir, 'events.jsonl'))
  })
})
