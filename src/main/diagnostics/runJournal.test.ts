import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactDiagnosticValue, RUN_JOURNAL_MAX_BYTES, RunJournal } from './runJournal'

describe('RunJournal', () => {
  it('redacts secret fields and token-shaped text recursively', () => {
    expect(
      redactDiagnosticValue({
        authorization: 'Bearer abc.def',
        nested: { apiKey: 'sk-example123456789', note: 'Bearer visible-token' },
        text: 'token ghp_abcdefghijklmnopqrstuvwxyz'
      })
    ).toEqual({
      authorization: '[redacted]',
      nested: { apiKey: '[redacted]', note: 'Bearer [redacted]' },
      text: 'token [redacted]'
    })
  })

  it('persists, filters and exports sanitized run history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-journal-'))
    const exported = join(dir, 'export.jsonl')
    try {
      const journal = new RunJournal(join(dir, 'runs'))
      const first = journal.record({
        kind: 'agent-event',
        profileId: 'alpha',
        workspaceSessionId: 'session-alpha',
        at: 10,
        payload: { text: 'started', token: 'secret' }
      })
      journal.record({
        kind: 'orchestrator-snapshot',
        profileId: 'alpha',
        workspaceSessionId: 'session-alpha',
        at: 20,
        payload: { tasks: [] }
      })
      journal.record({
        kind: 'agent-event',
        profileId: 'beta',
        workspaceSessionId: 'session-beta',
        at: 30,
        payload: { text: 'other' }
      })
      await journal.flush()

      expect(journal.list('alpha')).toEqual([
        expect.objectContaining({ runId: first.runId, eventCount: 2, startedAt: 10, updatedAt: 20 })
      ])
      journal.export(first.runId, exported)
      const content = readFileSync(exported, 'utf8')
      expect(content).toContain('"token":"[redacted]"')
      expect(content).not.toContain('"token":"secret"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects path-like run ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-journal-'))
    try {
      expect(() => new RunJournal(dir).export('../secret', join(dir, 'out'))).toThrow('Ungültige Run-ID')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rotates a run journal before it can grow without bounds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-journal-'))
    try {
      const runs = join(dir, 'runs')
      const seed = new RunJournal(runs)
      const first = seed.record({
        kind: 'agent-event',
        workspaceSessionId: 'session-rotation',
        at: 10,
        payload: { text: 'first' }
      })
      await seed.flush()
      const path = join(runs, `${first.runId}.jsonl`)
      writeFileSync(path, 'x'.repeat(RUN_JOURNAL_MAX_BYTES), 'utf8')

      // A fresh instance (cold size cache) stats the oversized file and rotates.
      const journal = new RunJournal(runs)
      journal.record({
        kind: 'agent-event',
        workspaceSessionId: 'session-rotation',
        at: 20,
        payload: { text: 'after rotation' }
      })
      await journal.flush()

      const entries = readFileSync(path, 'utf8').trim().split(/\r?\n/)
      expect(entries).toHaveLength(1)
      expect(JSON.parse(entries[0]).payload).toEqual({ text: 'after rotation' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
