import { safeStorage } from 'electron'
import { getSetting, setSetting } from '@main/config/store'
import type { RemoteActor, RemoteCapability, RemoteScope } from '@shared/remote'

const DEVICES_KEY = 'secrets.remote.devices'
const CLOUDFLARE_KEY = 'secrets.remote.cloudflare'
const PUSH_SUBSCRIPTIONS_KEY = 'secrets.remote.pushSubscriptions'
const VAPID_KEY = 'secrets.remote.vapid'
const ACCESS_KEY = 'secrets.remote.access'

export interface StoredDeviceRecord {
  id: string
  name: string
  /** sha256 digest only. The raw bearer token is never persisted. */
  tokenHash: string
  capabilities: RemoteCapability[]
  actor: RemoteActor
  scopes: RemoteScope[]
  createdAt: number
  lastSeenAt?: number
  revokedAt?: number
}

export interface StoredCloudflareCredential {
  hostname: string
  tunnelToken: string
}

export interface StoredPushSubscription {
  id: string
  deviceId: string
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
  createdAt: number
}

export interface StoredVapidKeys {
  publicKey: string
  privateKey: string
}

export interface StoredAccessConfig {
  teamDomain: string
  audience: string
}

export interface DeviceRecordStore {
  load(): StoredDeviceRecord[]
  save(records: StoredDeviceRecord[]): void
}

export interface SecretCodec {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

const electronCodec: SecretCodec = {
  available: () => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },
  encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
}

function parseDevices(value: unknown): StoredDeviceRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Partial<StoredDeviceRecord>
    if (
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.tokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.tokenHash) ||
      !Array.isArray(item.capabilities) ||
      typeof item.createdAt !== 'number'
    ) return []
    const capabilities = item.capabilities.filter(
      (capability): capability is RemoteCapability =>
        capability === 'read' || capability === 'steer' || capability === 'admin' ||
        capability === 'diff' || capability === 'push' || capability === 'speech' ||
        capability === 'approve-tools' || capability === 'budget' ||
        capability === 'task-control' || capability === 'replan'
    )
    const actor = item.actor && typeof item.actor.id === 'string' && typeof item.actor.displayName === 'string'
      ? { id: item.actor.id.slice(0, 160), displayName: item.actor.displayName.slice(0, 160) }
      : { id: 'legacy-owner', displayName: 'Legacy owner' }
    const scopes = Array.isArray(item.scopes) ? item.scopes.flatMap((scope) => {
      if (!scope || typeof scope !== 'object') return []
      const value = scope as Partial<RemoteScope>
      if (typeof value.profileId !== 'string' || !Array.isArray(value.sessionIds)) return []
      return [{
        profileId: value.profileId.slice(0, 128),
        sessionIds: value.sessionIds.filter((id): id is string => typeof id === 'string').map((id) => id.slice(0, 128)).slice(0, 64),
        allowGoalSubmit: value.allowGoalSubmit === true
      }]
    }) : []
    return [{
      id: item.id,
      name: item.name,
      tokenHash: item.tokenHash,
      capabilities,
      actor,
      scopes,
      createdAt: item.createdAt,
      lastSeenAt: typeof item.lastSeenAt === 'number' ? item.lastSeenAt : undefined,
      revokedAt: typeof item.revokedAt === 'number' ? item.revokedAt : undefined
    }]
  })
}

export class EncryptedDeviceStore implements DeviceRecordStore {
  constructor(
    private readonly codec: SecretCodec = electronCodec,
    private readonly read: (key: string) => string | undefined = getSetting,
    private readonly write: (key: string, value: unknown) => void = setSetting
  ) {}

  encryptionAvailable(): boolean {
    return this.codec.available()
  }

  load(): StoredDeviceRecord[] {
    const blob = this.read(DEVICES_KEY)
    if (!blob || !this.codec.available()) return []
    try {
      return parseDevices(JSON.parse(this.codec.decrypt(blob)))
    } catch {
      return []
    }
  }

  save(records: StoredDeviceRecord[]): void {
    if (!this.codec.available()) {
      throw new Error('Remote-Zugriff benötigt Electron safeStorage; Verschlüsselung ist nicht verfügbar.')
    }
    this.write(DEVICES_KEY, this.codec.encrypt(JSON.stringify(records)))
  }
}

export function isRemoteEncryptionAvailable(): boolean {
  return electronCodec.available()
}

export function readCloudflareCredential(codec: SecretCodec = electronCodec): StoredCloudflareCredential | undefined {
  const blob = getSetting<string>(CLOUDFLARE_KEY)
  if (!blob || !codec.available()) return undefined
  try {
    const value = JSON.parse(codec.decrypt(blob)) as Partial<StoredCloudflareCredential>
    if (typeof value.hostname !== 'string' || typeof value.tunnelToken !== 'string') return undefined
    if (!value.hostname.trim() || !value.tunnelToken.trim()) return undefined
    return { hostname: value.hostname.trim().toLowerCase(), tunnelToken: value.tunnelToken.trim() }
  } catch {
    return undefined
  }
}

export function writeCloudflareCredential(
  credential: StoredCloudflareCredential,
  codec: SecretCodec = electronCodec
): void {
  if (!codec.available()) {
    throw new Error('Remote-Zugriff benötigt Electron safeStorage; Verschlüsselung ist nicht verfügbar.')
  }
  const hostname = credential.hostname.trim().toLowerCase()
  const tunnelToken = credential.tunnelToken.trim()
  if (!hostname || !tunnelToken) throw new Error('Tunnel-Hostname und Tunnel-Token sind erforderlich.')
  setSetting(CLOUDFLARE_KEY, codec.encrypt(JSON.stringify({ hostname, tunnelToken })))
}

function readEncryptedJson<T>(key: string, codec: SecretCodec = electronCodec): T | undefined {
  const blob = getSetting<string>(key)
  if (!blob || !codec.available()) return undefined
  try { return JSON.parse(codec.decrypt(blob)) as T } catch { return undefined }
}

function writeEncryptedJson(key: string, value: unknown, codec: SecretCodec = electronCodec): void {
  if (!codec.available()) {
    throw new Error('Remote-Zugriff benötigt Electron safeStorage; Verschlüsselung ist nicht verfügbar.')
  }
  setSetting(key, codec.encrypt(JSON.stringify(value)))
}

export function readPushSubscriptions(codec: SecretCodec = electronCodec): StoredPushSubscription[] {
  const value = readEncryptedJson<unknown>(PUSH_SUBSCRIPTIONS_KEY, codec)
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Partial<StoredPushSubscription>
    if (
      typeof item.id !== 'string' || typeof item.deviceId !== 'string' ||
      typeof item.endpoint !== 'string' || !item.endpoint.startsWith('https://') ||
      !item.keys || typeof item.keys.p256dh !== 'string' || typeof item.keys.auth !== 'string' ||
      typeof item.createdAt !== 'number'
    ) return []
    return [{
      id: item.id, deviceId: item.deviceId, endpoint: item.endpoint,
      expirationTime: typeof item.expirationTime === 'number' || item.expirationTime === null
        ? item.expirationTime : undefined,
      keys: { p256dh: item.keys.p256dh, auth: item.keys.auth },
      createdAt: item.createdAt
    }]
  })
}

export function writePushSubscriptions(
  subscriptions: StoredPushSubscription[],
  codec: SecretCodec = electronCodec
): void {
  writeEncryptedJson(PUSH_SUBSCRIPTIONS_KEY, subscriptions, codec)
}

export function readVapidKeys(codec: SecretCodec = electronCodec): StoredVapidKeys | undefined {
  const value = readEncryptedJson<Partial<StoredVapidKeys>>(VAPID_KEY, codec)
  return value && typeof value.publicKey === 'string' && typeof value.privateKey === 'string'
    ? { publicKey: value.publicKey, privateKey: value.privateKey }
    : undefined
}

export function writeVapidKeys(keys: StoredVapidKeys, codec: SecretCodec = electronCodec): void {
  writeEncryptedJson(VAPID_KEY, keys, codec)
}

export function readAccessConfig(codec: SecretCodec = electronCodec): StoredAccessConfig | undefined {
  const value = readEncryptedJson<Partial<StoredAccessConfig>>(ACCESS_KEY, codec)
  if (!value || typeof value.teamDomain !== 'string' || typeof value.audience !== 'string') return undefined
  const teamDomain = value.teamDomain.trim().replace(/\/$/, '')
  const audience = value.audience.trim()
  return teamDomain && audience ? { teamDomain, audience } : undefined
}

export function writeAccessConfig(config: StoredAccessConfig, codec: SecretCodec = electronCodec): void {
  const teamDomain = config.teamDomain.trim().replace(/\/$/, '')
  const audience = config.audience.trim()
  if (!teamDomain || !audience) throw new Error('Access-Team-Domain und Audience sind erforderlich.')
  writeEncryptedJson(ACCESS_KEY, { teamDomain, audience }, codec)
}
