import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactDiagnosticValue } from '@main/diagnostics/runJournal'

export const REMOTE_AUDIT_MAX_BYTES = 5 * 1024 * 1024

export interface RemoteAuditRecord {
  kind: 'auth' | 'pair' | 'command' | 'lifecycle' | 'data-access'
  outcome: 'accepted' | 'rejected' | 'error'
  deviceId?: string
  actor?: string
  action?: string
  requestId?: string
  detail?: unknown
  at?: number
}

export interface RemoteAuditEntry extends Omit<RemoteAuditRecord, 'at'> {
  version: 1
  at: number
}

export class RemoteAuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }

  record(record: RemoteAuditRecord): RemoteAuditEntry {
    const entry: RemoteAuditEntry = {
      version: 1,
      kind: record.kind,
      outcome: record.outcome,
      deviceId: record.deviceId,
      actor: record.actor,
      action: record.action,
      requestId: record.requestId,
      detail: redactDiagnosticValue(record.detail),
      at: record.at ?? Date.now()
    }
    const line = `${JSON.stringify(entry)}\n`
    if (existsSync(this.path) && statSync(this.path).size >= REMOTE_AUDIT_MAX_BYTES) {
      writeFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 })
    } else {
      appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 })
    }
    return entry
  }

  readEntries(): RemoteAuditEntry[] {
    try {
      return readFileSync(this.path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as RemoteAuditEntry] } catch { return [] }
      })
    } catch {
      return []
    }
  }
}

