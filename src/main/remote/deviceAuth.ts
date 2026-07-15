import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  DeviceInfo,
  PairingChallenge,
  PairingResult,
  RemoteCapability
} from '@shared/remote'
import type { DeviceRecordStore, StoredDeviceRecord } from './deviceStore'

const PAIRING_TTL_MS = 5 * 60_000

interface PendingPairing {
  digest: Buffer
  expiresAt: number
  capabilities: RemoteCapability[]
  deviceNameHint?: string
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function publicDevice(record: StoredDeviceRecord): DeviceInfo {
  return {
    id: record.id,
    name: record.name,
    capabilities: [...record.capabilities],
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    revokedAt: record.revokedAt
  }
}

export class DeviceAuth extends EventEmitter {
  private pending: PendingPairing | undefined

  constructor(
    private readonly store: DeviceRecordStore,
    private readonly now: () => number = Date.now,
    private readonly bytes: (size: number) => Buffer = randomBytes
  ) {
    super()
  }

  startPairing(
    capabilities: RemoteCapability[] = ['read', 'steer'],
    deviceNameHint?: string
  ): PairingChallenge {
    const code = this.bytes(16).toString('hex')
    const allowed = [...new Set(capabilities)].filter(
      (value): value is RemoteCapability =>
        value === 'read' || value === 'steer' || value === 'admin' || value === 'diff' ||
        value === 'push' || value === 'speech'
    )
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.pending = {
      digest: digest(code),
      expiresAt,
      capabilities: allowed.length > 0 ? allowed : ['read'],
      deviceNameHint: deviceNameHint?.trim().slice(0, 80)
    }
    return { code, expiresAt }
  }

  pair(code: string, deviceName: string): PairingResult | undefined {
    const pending = this.pending
    const supplied = digest(String(code))
    const valid = Boolean(
      pending && pending.expiresAt >= this.now() && safeEqual(pending.digest, supplied)
    )
    if (!valid || !pending) return undefined
    // Single-use even if persistence subsequently fails.
    this.pending = undefined
    const token = this.bytes(32).toString('base64url')
    const record: StoredDeviceRecord = {
      id: randomUUID(),
      name: deviceName.trim().slice(0, 80) || pending.deviceNameHint || 'Mobilgerät',
      tokenHash: digest(token).toString('hex'),
      capabilities: [...pending.capabilities],
      createdAt: this.now()
    }
    this.store.save([...this.store.load(), record])
    return { token, device: publicDevice(record) }
  }

  authenticate(token: string): DeviceInfo | undefined {
    if (!token || token.length > 512) return undefined
    const supplied = digest(token)
    const records = this.store.load()
    const record = records.find((candidate) => {
      if (candidate.revokedAt) return false
      const stored = Buffer.from(candidate.tokenHash, 'hex')
      return safeEqual(stored, supplied)
    })
    if (!record) return undefined
    return publicDevice(record)
  }

  listDevices(): DeviceInfo[] {
    return this.store.load().map(publicDevice)
  }

  revoke(deviceId: string): boolean {
    const records = this.store.load()
    const record = records.find((candidate) => candidate.id === deviceId && !candidate.revokedAt)
    if (!record) return false
    record.revokedAt = this.now()
    this.store.save(records)
    this.emit('revoked', deviceId)
    return true
  }

  revokeAll(): void {
    const records = this.store.load()
    const at = this.now()
    for (const record of records) {
      if (!record.revokedAt) record.revokedAt = at
    }
    this.store.save(records)
    this.pending = undefined
    this.emit('revoke-all')
  }
}

export const deviceAuthInternals = { digest, safeEqual, PAIRING_TTL_MS }
