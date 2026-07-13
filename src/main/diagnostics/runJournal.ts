import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export const RUN_JOURNAL_MAX_BYTES = 5 * 1024 * 1024

export type RunJournalKind = 'agent-event' | 'orchestrator-snapshot'

export interface RunJournalRecord {
  kind: RunJournalKind
  profileId?: string
  workspaceSessionId?: string
  at?: number
  payload: unknown
}

export interface RunJournalEntry extends RunJournalRecord {
  version: 1
  runId: string
  at: number
}

export interface RunJournalSummary {
  runId: string
  profileId?: string
  workspaceSessionId?: string
  startedAt: number
  updatedAt: number
  eventCount: number
}

const SECRET_KEY = /(?:api.?key|authorization|cookie|password|secret|token)/i
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const KNOWN_TOKEN = /\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/g

export function redactDiagnosticValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') {
    return value.replace(BEARER, 'Bearer [redacted]').replace(KNOWN_TOKEN, '[redacted]')
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redactDiagnosticValue(childValue, childKey)
    }
    return output
  }
  return value
}

function stableRunId(record: RunJournalRecord): string {
  const day = new Date(record.at ?? Date.now()).toISOString().slice(0, 10)
  const key = record.workspaceSessionId ?? `${record.profileId ?? 'app'}:${day}`
  return createHash('sha256').update(key).digest('hex').slice(0, 20)
}

function parseLines(path: string): RunJournalEntry[] {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunJournalEntry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export class RunJournal {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true })
  }

  private file(runId: string): string {
    if (!/^[a-f0-9]{20}$/.test(runId)) throw new Error('Ungültige Run-ID.')
    return join(this.directory, `${runId}.jsonl`)
  }

  record(record: RunJournalRecord): RunJournalEntry {
    const at = record.at ?? Date.now()
    const runId = stableRunId({ ...record, at })
    const entry: RunJournalEntry = {
      version: 1,
      runId,
      kind: record.kind,
      profileId: record.profileId,
      workspaceSessionId: record.workspaceSessionId,
      at,
      payload: redactDiagnosticValue(record.payload)
    }
    const path = this.file(runId)
    const line = `${JSON.stringify(entry)}\n`
    if (existsSync(path) && statSync(path).size >= RUN_JOURNAL_MAX_BYTES) {
      writeFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
      return entry
    }

    appendFileSync(path, line, {
      encoding: 'utf8',
      mode: 0o600
    })
    return entry
  }

  list(profileId?: string): RunJournalSummary[] {
    const summaries: RunJournalSummary[] = []
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{20}\.jsonl$/.test(name)) continue
      const entries = parseLines(join(this.directory, name))
      if (entries.length === 0) continue
      const first = entries[0]
      const last = entries[entries.length - 1]
      if (profileId && first.profileId !== profileId) continue
      summaries.push({
        runId: first.runId,
        profileId: first.profileId,
        workspaceSessionId: first.workspaceSessionId,
        startedAt: first.at,
        updatedAt: last.at,
        eventCount: entries.length
      })
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  export(runId: string, destination: string): void {
    copyFileSync(this.file(runId), destination)
  }
}
