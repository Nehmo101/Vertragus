import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { AgentEvent } from '@shared/schema/events'
import { createRunJournal } from './journal'

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
