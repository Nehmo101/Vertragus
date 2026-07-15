/**
 * Exports retros, benchmarks and learning snapshots to the dedicated retro
 * data branch (GitHub Contents API, no local clone). A persistent queue in the
 * config store makes the export offline-tolerant: enqueue and flush can never
 * fail or block a run — failures stay queued with backoff and surface only in
 * the sync status.
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { app } from 'electron'
import { getSetting, setSetting } from '@main/config/store'
import { redactDiagnosticValue } from '@main/diagnostics/runJournal'
import {
  ensureRetroBranch,
  putRepoFile,
  type RepoRef
} from '@main/integrations/githubContents'
import { refreshPromptOverlay } from '@main/orchestrator/promptOverlay'
import { listModelLearnings } from '@main/orchestrator/retroStore'
import { retroSyncConfig } from '@main/orchestrator/retroSyncConfig'
import type { BenchmarkRecord, RunRetro } from '@shared/retro'
import {
  type RetroExportEnvelope,
  type RetroExportKind,
  type RetroSyncConfig,
  type RetroSyncStatus
} from '@shared/retroSync'

const QUEUE_KEY = 'retroSync.queue'
const LAST_EXPORT_KEY = 'retroSync.lastExportAt'
const LAST_ERROR_KEY = 'retroSync.lastError'
const LEARNINGS_HASH_KEY = 'retroSync.lastLearningsHash'

const MAX_QUEUE = 200
const MAX_PAYLOAD_BYTES = 256 * 1024
const MAX_BACKOFF_MS = 6 * 60 * 60_000
const FLUSH_INTERVAL_MS = 15 * 60_000

export interface RetroExportItem {
  kind: RetroExportKind
  path: string
  envelope: RetroExportEnvelope
  enqueuedAt: number
  attempts: number
  nextAttemptAt: number
  lastError?: string
}

const RETRO_BRANCH_README = [
  '# Orca-Strator Retros',
  '',
  'Dieser Branch enthält ausschließlich Retro-Daten des Orchestrators — keinen Code.',
  'Er wird automatisch von Orca-Strator-Installationen befüllt (Retro-Sync) und',
  'periodisch von der Retro-Analyse ausgewertet (siehe docs/retro-sync.md im Code-Branch).',
  '',
  '- `runs/JJJJ/MM/<retro-id>.json` — eine Retrospektive pro Planlauf',
  '- `benchmarks/JJJJ/MM/<record-id>.json` — Benchmark-Bewertungen',
  '- `learnings/<machineId>.json` — gemergter Modellwissen-Snapshot je Installation',
  '- `overlay/learnings.md` — geprüftes Regelwerk, injiziert in den Orchestrator-Systemprompt',
  '- `proposals/` — generierte Verbesserungs-Briefs',
  '- `state/last-analysis.json` — Fortschrittsmarke der Analyse'
].join('\n')

let cachedMachineId: string | undefined
let flushing = false
let flushQueued = false
let schedulerStarted = false

/** Pseudonymous, stable per installation — never raw hostname or username. */
function machineId(): string {
  if (!cachedMachineId) {
    cachedMachineId = createHash('sha256')
      .update(`${hostname()}:${app.getPath('userData')}`)
      .digest('hex')
      .slice(0, 12)
  }
  return cachedMachineId
}

function repoRef(config: RetroSyncConfig): RepoRef {
  return { owner: config.repoOwner, repo: config.repoName, branch: config.branch }
}

function readQueue(): RetroExportItem[] {
  const raw = getSetting<unknown>(QUEUE_KEY)
  return Array.isArray(raw)
    ? (raw as RetroExportItem[]).filter((item) => item && typeof item.path === 'string')
    : []
}

function writeQueue(queue: RetroExportItem[]): void {
  // Bei vollem Puffer weichen die ältesten Einträge, nie die neuesten.
  setSetting(QUEUE_KEY, queue.slice(-MAX_QUEUE))
}

function sanitizeFileId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120)
}

function monthPath(prefix: string, id: string, createdAt: number): string {
  const date = new Date(createdAt)
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${prefix}/${yyyy}/${mm}/${sanitizeFileId(id)}.json`
}

export function retroPathFor(retro: Pick<RunRetro, 'id' | 'createdAt'>): string {
  return monthPath('runs', retro.id, retro.createdAt)
}

export function benchmarkPathFor(record: Pick<BenchmarkRecord, 'id' | 'createdAt'>): string {
  return monthPath('benchmarks', record.id, record.createdAt)
}

export function buildEnvelope(kind: RetroExportKind, payload: unknown): RetroExportEnvelope {
  return {
    version: 1,
    exportedAt: Date.now(),
    app: { name: 'orca-strator', version: app.getVersion() },
    machineId: machineId(),
    kind,
    payload: redactDiagnosticValue(payload)
  }
}

function enqueue(kind: RetroExportKind, path: string, payload: unknown): void {
  try {
    if (!retroSyncConfig().enabled) return
    const envelope = buildEnvelope(kind, payload)
    if (JSON.stringify(envelope).length > MAX_PAYLOAD_BYTES) {
      setSetting(LAST_ERROR_KEY, `Export übersprungen: ${path} überschreitet das Größenlimit.`)
      return
    }
    // Dedup by target path: a record_retro update replaces the queued auto-retro.
    const queue = readQueue().filter((item) => item.path !== path)
    queue.push({
      kind,
      path,
      envelope,
      enqueuedAt: Date.now(),
      attempts: 0,
      nextAttemptAt: Date.now()
    })
    writeQueue(queue)
    void flushRetroExportQueue()
  } catch (error) {
    console.warn('[RetroSync] Enqueue fehlgeschlagen', error)
  }
}

export function enqueueRetroExport(retro: RunRetro): void {
  enqueue('run-retro', retroPathFor(retro), retro)
}

export function enqueueBenchmarkExport(record: BenchmarkRecord): void {
  enqueue('benchmark', benchmarkPathFor(record), record)
}

function learningsSnapshotHash(): { hash: string; learnings: unknown[] } {
  const learnings = listModelLearnings()
  const hash = createHash('sha256').update(JSON.stringify(learnings)).digest('hex')
  return { hash, learnings }
}

async function pushItem(ref: RepoRef, item: RetroExportItem): Promise<void> {
  await putRepoFile({
    ref,
    path: item.path,
    content: `${JSON.stringify(item.envelope, null, 2)}\n`,
    message: `Retro-Export: ${item.path}`
  })
}

async function pushLearningsSnapshot(ref: RepoRef): Promise<void> {
  const { hash, learnings } = learningsSnapshotHash()
  if (learnings.length === 0 || getSetting<string>(LEARNINGS_HASH_KEY) === hash) return
  await putRepoFile({
    ref,
    path: `learnings/${machineId()}.json`,
    content: `${JSON.stringify(buildEnvelope('learnings', learnings), null, 2)}\n`,
    message: `Learnings-Snapshot ${machineId()}`
  })
  setSetting(LEARNINGS_HASH_KEY, hash)
}

async function flushOnce(): Promise<void> {
  const config = retroSyncConfig()
  if (!config.enabled) return
  const now = Date.now()
  const queue = readQueue()
  const due = queue.filter((item) => item.nextAttemptAt <= now)
  const { hash, learnings } = learningsSnapshotHash()
  const learningsPending = learnings.length > 0 && getSetting<string>(LEARNINGS_HASH_KEY) !== hash
  if (due.length === 0 && !learningsPending) return

  const ref = repoRef(config)
  try {
    await ensureRetroBranch(ref, RETRO_BRANCH_README)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    setSetting(LAST_ERROR_KEY, detail)
    return
  }

  for (const item of due) {
    try {
      await pushItem(ref, item)
      const remaining = readQueue().filter((entry) => entry.path !== item.path)
      writeQueue(remaining)
      setSetting(LAST_EXPORT_KEY, Date.now())
      setSetting(LAST_ERROR_KEY, undefined)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const attempts = item.attempts + 1
      const backoffMs = Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS)
      const updated = readQueue().map((entry) =>
        entry.path === item.path
          ? { ...entry, attempts, nextAttemptAt: Date.now() + backoffMs, lastError: detail }
          : entry
      )
      writeQueue(updated)
      setSetting(LAST_ERROR_KEY, detail)
    }
  }

  try {
    await pushLearningsSnapshot(ref)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    setSetting(LAST_ERROR_KEY, detail)
  }
}

/** Drains due queue items; never throws. Returns the resulting sync status. */
export async function flushRetroExportQueue(): Promise<RetroSyncStatus> {
  if (flushing) {
    flushQueued = true
    return retroSyncStatus()
  }
  flushing = true
  try {
    do {
      flushQueued = false
      await flushOnce()
    } while (flushQueued)
  } catch (error) {
    console.warn('[RetroSync] Flush fehlgeschlagen', error)
  } finally {
    flushing = false
  }
  return retroSyncStatus()
}

export function retroSyncStatus(): RetroSyncStatus {
  const config = retroSyncConfig()
  return {
    ...config,
    queued: readQueue().length,
    lastExportAt: getSetting<number>(LAST_EXPORT_KEY),
    lastError: getSetting<string>(LAST_ERROR_KEY) || undefined
  }
}

/** Start-of-app hook: immediate flush + overlay refresh, coarse retry interval. */
export function startRetroSyncScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  void flushRetroExportQueue()
  void refreshPromptOverlay()
  const timer = setInterval(() => {
    void flushRetroExportQueue()
    void refreshPromptOverlay()
  }, FLUSH_INTERVAL_MS)
  timer.unref?.()
}

/** Nur für Tests: Modulzustand zurücksetzen. */
export const retroExportInternals = {
  reset(): void {
    cachedMachineId = undefined
    flushing = false
    flushQueued = false
    schedulerStarted = false
  }
}
