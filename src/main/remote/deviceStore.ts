import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export interface RemoteDevice {
  id: string
  credentialHash: string
  pairingHash: string
  remoteAddress: string
  createdAt: number
  lastSeenAt: number
}
export interface RemoteDeviceStore {
  read(): RemoteDevice[]
  write(devices: RemoteDevice[]): void
}

/** Only one-way hashes and public device metadata are persisted. */
export function createRemoteDeviceFile(path: string): RemoteDeviceStore {
  return {
    read() {
      try {
        const rows: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (!Array.isArray(rows)) return []
        return rows.filter((row): row is RemoteDevice => row &&
          typeof row.id === 'string' && typeof row.credentialHash === 'string' &&
          typeof row.pairingHash === 'string' && typeof row.remoteAddress === 'string' &&
          typeof row.createdAt === 'number' && typeof row.lastSeenAt === 'number')
      } catch { return [] }
    },
    write(devices) {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify(devices), { mode: 0o600, flush: true })
        renameSync(temporary, path)
      } finally {
        try { unlinkSync(temporary) } catch { /* Rename consumed it, or write failed. */ }
      }
    }
  }
}
