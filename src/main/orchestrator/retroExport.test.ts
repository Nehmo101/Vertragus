import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureRetroBranch, putRepoFile } from '@main/integrations/githubContents'
import { listModelLearnings } from '@main/orchestrator/retroStore'
import type { RunRetro } from '@shared/retro'
import {
  benchmarkPathFor,
  buildEnvelope,
  enqueueRetroExport,
  flushRetroExportQueue,
  retroExportInternals,
  retroPathFor,
  retroSyncStatus,
  type RetroExportItem
} from './retroExport'

const settings = new Map<string, unknown>()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/vertragus-test-user-data'),
    getVersion: vi.fn(() => '0.0.0-test')
  }
}))

vi.mock('@main/config/store', () => ({
  getSetting: vi.fn((key: string) => settings.get(key)),
  setSetting: vi.fn((key: string, value: unknown) => {
    if (value === undefined) settings.delete(key)
    else settings.set(key, value)
  })
}))

vi.mock('@main/integrations/githubContents', () => ({
  ensureRetroBranch: vi.fn(async () => undefined),
  putRepoFile: vi.fn(async () => undefined)
}))

vi.mock('@main/orchestrator/retroStore', () => ({
  listModelLearnings: vi.fn(() => [])
}))

function makeRetro(overrides: Partial<RunRetro> = {}): RunRetro {
  return {
    id: 'retro-abc-plan1',
    planId: 'plan1',
    goal: 'Testziel',
    summary: 'Lauf erfolgreich.',
    modelStats: [],
    learnings: [],
    createdAt: Date.UTC(2026, 6, 14, 12, 0, 0),
    ...overrides
  }
}

function queue(): RetroExportItem[] {
  return (settings.get('retroSync.queue') as RetroExportItem[]) ?? []
}

async function settled(): Promise<void> {
  // Ein Makrotask genügt, damit fire-and-forget-Flushes abgeschlossen sind.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('retroExport', () => {
  beforeEach(() => {
    settings.clear()
    settings.set('retroSync.enabled', true)
    retroExportInternals.reset()
    vi.mocked(ensureRetroBranch).mockReset().mockResolvedValue(undefined)
    vi.mocked(putRepoFile).mockReset().mockResolvedValue(undefined)
    vi.mocked(listModelLearnings).mockReset().mockReturnValue([])
  })

  it('maps retro and benchmark ids onto UTC month paths', () => {
    expect(retroPathFor({ id: 'retro-abc-plan1', createdAt: Date.UTC(2026, 6, 14) })).toBe(
      'runs/2026/07/retro-abc-plan1.json'
    )
    // Monatsgrenze: 31.12. 23:59 UTC bleibt im Dezember.
    expect(retroPathFor({ id: 'r1', createdAt: Date.UTC(2025, 11, 31, 23, 59) })).toBe(
      'runs/2025/12/r1.json'
    )
    expect(benchmarkPathFor({ id: 'benchrec-1', createdAt: Date.UTC(2026, 0, 1) })).toBe(
      'benchmarks/2026/01/benchrec-1.json'
    )
    expect(retroPathFor({ id: 'retro/../../etc', createdAt: Date.UTC(2026, 6, 1) })).toBe(
      'runs/2026/07/retro-..-..-etc.json'
    )
  })

  it('wraps payloads in a redacted envelope', () => {
    const envelope = buildEnvelope('run-retro', {
      goal: 'Deploy mit Token ghp_abcdefghijkl123456 bitte',
      apiKey: 'super-geheim'
    })
    expect(envelope.version).toBe(1)
    expect(envelope.kind).toBe('run-retro')
    expect(envelope.app).toEqual({ name: 'vertragus', version: '0.0.0-test' })
    expect(envelope.machineId).toMatch(/^[a-f0-9]{12}$/)
    const payload = envelope.payload as { goal: string; apiKey: string }
    expect(payload.goal).toContain('[redacted]')
    expect(payload.goal).not.toContain('ghp_')
    expect(payload.apiKey).toBe('[redacted]')
  })

  it('does nothing while retro sync is disabled', async () => {
    settings.set('retroSync.enabled', false)
    enqueueRetroExport(makeRetro())
    await settled()
    expect(queue()).toHaveLength(0)
    expect(putRepoFile).not.toHaveBeenCalled()
  })

  it('drains the queue on flush and records the export time', async () => {
    enqueueRetroExport(makeRetro())
    await settled()
    await flushRetroExportQueue()
    expect(queue()).toHaveLength(0)
    expect(ensureRetroBranch).toHaveBeenCalled()
    expect(putRepoFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'runs/2026/07/retro-abc-plan1.json',
        ref: { owner: 'Nehmo101', repo: 'Vertragus', branch: 'retros' }
      })
    )
    const status = retroSyncStatus()
    expect(status.queued).toBe(0)
    expect(status.lastExportAt).toBeTypeOf('number')
    expect(status.lastError).toBeUndefined()
  })

  it('replaces a queued item when the same retro is exported again', async () => {
    vi.mocked(ensureRetroBranch).mockRejectedValue(new Error('offline'))
    const retro = makeRetro()
    enqueueRetroExport(retro)
    await settled()
    enqueueRetroExport({ ...retro, summary: 'Qualitatives Fazit ergänzt.' })
    await settled()
    expect(queue()).toHaveLength(1)
    const item = queue()[0]
    expect((item.envelope.payload as RunRetro).summary).toBe('Qualitatives Fazit ergänzt.')
  })

  it('keeps failed items queued with backoff and surfaces the error', async () => {
    vi.mocked(putRepoFile).mockRejectedValue(new Error('GitHub-API 500 bei Schreiben'))
    enqueueRetroExport(makeRetro())
    await settled()
    await flushRetroExportQueue()
    const item = queue()[0]
    expect(item.attempts).toBeGreaterThanOrEqual(1)
    expect(item.nextAttemptAt).toBeGreaterThan(Date.now())
    expect(retroSyncStatus().lastError).toContain('GitHub-API 500')

    // Nicht fällige Items werden beim nächsten Flush übersprungen.
    vi.mocked(putRepoFile).mockResolvedValue(undefined)
    vi.mocked(putRepoFile).mockClear()
    await flushRetroExportQueue()
    expect(putRepoFile).not.toHaveBeenCalled()
    expect(queue()).toHaveLength(1)

    // Fällig machen -> Flush räumt auf.
    settings.set(
      'retroSync.queue',
      queue().map((entry) => ({ ...entry, nextAttemptAt: Date.now() - 1 }))
    )
    await flushRetroExportQueue()
    expect(queue()).toHaveLength(0)
  })

  it('pushes a learnings snapshot once per content hash', async () => {
    vi.mocked(listModelLearnings).mockReturnValue([
      {
        id: 'l1',
        provider: 'claude',
        model: 'opus',
        kind: 'strength',
        insight: 'stark bei UI',
        source: 'auto-retro',
        observations: 3,
        createdAt: 1,
        updatedAt: 2
      } as never
    ])
    await flushRetroExportQueue()
    expect(putRepoFile).toHaveBeenCalledTimes(1)
    expect(vi.mocked(putRepoFile).mock.calls[0][0].path).toMatch(/^learnings\/[a-f0-9]{12}\.json$/)

    // Unveränderte Learnings werden nicht erneut gepusht.
    vi.mocked(putRepoFile).mockClear()
    await flushRetroExportQueue()
    expect(putRepoFile).not.toHaveBeenCalled()
  })
})
