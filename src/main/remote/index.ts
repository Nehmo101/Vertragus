import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { join, resolve } from 'node:path'
import { getProfile, getSetting, setSetting } from '@main/config/store'
import { createIdea } from '@main/inbox/store'
import { transferIdeaToProfile } from '@main/inbox/transferService'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
import type {
  DeviceInfo,
  PairingChallenge,
  RemoteEnableRequest,
  RemotePairStartRequest,
  RemoteStatus
} from '@shared/remote'
import { RemoteAuditLog } from './auditLog'
import { RemoteCommandRouter } from './commands'
import { DeviceAuth } from './deviceAuth'
import {
  EncryptedDeviceStore,
  isRemoteEncryptionAvailable,
  readCloudflareCredential,
  writeCloudflareCredential
} from './deviceStore'
import { startRemoteGateway } from './RemoteGateway'
import type { RemoteGatewayHandle } from './gatewayHandle'
import { setRemoteGatewayHandle } from './gatewayHandle'
import { pairingQrDataUrl } from './qrcode'
import { RemoteReadModel } from './readModel'
import { TunnelManager, tunnelStatusToRemote } from './tunnelManager'

function mobileStaticDir(): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'apps', 'mobile', 'dist')
    : resolve(process.cwd(), 'apps/mobile/dist')
}

function requireProfile(profileId: string) {
  const profile = getProfile(profileId)
  if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
  return profile
}

export class RemoteService extends EventEmitter {
  private readonly store = new EncryptedDeviceStore()
  private readonly auth = new DeviceAuth(this.store)
  private readonly readModel = new RemoteReadModel(workspaceSessions)
  private readonly audit = new RemoteAuditLog(join(app.getPath('userData'), 'diagnostics', 'remote-audit.jsonl'))
  private readonly tunnel = new TunnelManager()
  private gateway: RemoteGatewayHandle | undefined
  private starting: Promise<void> | undefined
  private lastError: string | undefined

  private readonly commands = new RemoteCommandRouter({
    reviewPlan: (profileId, approved, sessionId) =>
      workspaceSessions.reviewPlan(requireProfile(profileId), approved, sessionId),
    enableAutoMode: (profileId, sessionId) =>
      workspaceSessions.enableAutoMode(requireProfile(profileId), sessionId),
    reset: (profileId, sessionId) => workspaceSessions.reset(requireProfile(profileId), sessionId),
    submitGoal: async (profileId, text) => {
      requireProfile(profileId)
      const title = text.split(/\r?\n/, 1)[0]!.trim().slice(0, 160) || 'Remote-Ziel'
      const idea = createIdea({
        title,
        content: text,
        status: 'ready',
        refs: { profileId }
      })
      // The remote caller can never opt into yolo; this is forced server-side.
      const transfer = await transferIdeaToProfile({ ideaId: idea.id, profileId, yoloMaster: false })
      return { ideaId: idea.id, transfer: transfer.transfer }
    },
    activateKillSwitch: () => {
      setImmediate(() => { void this.disable() })
    }
  })

  constructor() {
    super()
    this.tunnel.on('status', () => this.emitStatus())
    this.auth.on('revoked', (deviceId: string) => {
      this.gateway?.dropDevice(deviceId)
      this.emitStatus()
    })
    this.auth.on('revoke-all', () => this.emitStatus())
  }

  status(): RemoteStatus {
    const tunnel = tunnelStatusToRemote(this.tunnel.status())
    return {
      enabled: getSetting<boolean>('remote.enabled') === true,
      gatewayRunning: Boolean(this.gateway),
      gatewayPort: this.gateway?.port,
      ...tunnel,
      deviceCount: this.auth.listDevices().filter((device) => !device.revokedAt).length,
      error: this.lastError ?? tunnel.error
    }
  }

  private emitStatus(): void { this.emit('status', this.status()) }

  async startIfEnabled(): Promise<void> {
    if (getSetting<boolean>('remote.enabled') !== true) return
    await this.start()
  }

  async enable(request: RemoteEnableRequest): Promise<RemoteStatus> {
    if (!isRemoteEncryptionAvailable()) {
      throw new Error('Remote-Aktivierung verweigert: Electron safeStorage ist nicht verfügbar.')
    }
    if (request.hostname || request.tunnelToken) {
      if (!request.hostname || !request.tunnelToken) {
        throw new Error('Tunnel-Hostname und Tunnel-Token müssen gemeinsam angegeben werden.')
      }
      writeCloudflareCredential({ hostname: request.hostname, tunnelToken: request.tunnelToken })
    }
    if (!readCloudflareCredential()) throw new Error('Für Remote-Zugriff fehlt die Named-Tunnel-Konfiguration.')
    setSetting('remote.enabled', true)
    try {
      await this.start()
      return this.status()
    } catch (error) {
      setSetting('remote.enabled', false)
      await this.stop()
      throw error
    }
  }

  private async start(): Promise<void> {
    if (this.gateway) return
    if (this.starting) return this.starting
    this.starting = this.startInner().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async startInner(): Promise<void> {
    if (!isRemoteEncryptionAvailable()) {
      this.lastError = 'safeStorage ist nicht verfügbar.'
      setSetting('remote.enabled', false)
      throw new Error('Remote-Aktivierung verweigert: Electron safeStorage ist nicht verfügbar.')
    }
    const credential = readCloudflareCredential()
    if (!credential) {
      this.lastError = 'Named-Tunnel-Konfiguration fehlt.'
      setSetting('remote.enabled', false)
      throw new Error(this.lastError)
    }
    this.lastError = undefined
    this.readModel.start()
    for (const summary of workspaceSessions.list()) {
      const session = workspaceSessions.getById(summary.id)
      if (session) this.readModel.seed(session.engine.snapshot())
    }
    this.gateway = await startRemoteGateway({
      auth: this.auth,
      audit: this.audit,
      commands: this.commands,
      readModel: this.readModel,
      staticDir: mobileStaticDir(),
      allowedHosts: [credential.hostname]
    })
    setRemoteGatewayHandle(this.gateway)
    await this.tunnel.start({
      origin: this.gateway.origin,
      hostname: credential.hostname,
      tunnelToken: credential.tunnelToken
    })
    this.audit.record({ kind: 'lifecycle', outcome: 'accepted', action: 'remote.start' })
    this.emitStatus()
  }

  async stop(): Promise<void> {
    await this.tunnel.stop()
    const gateway = this.gateway
    this.gateway = undefined
    setRemoteGatewayHandle(null)
    await gateway?.close()
    this.readModel.stop()
    this.emitStatus()
  }

  async disable(): Promise<RemoteStatus> {
    setSetting('remote.enabled', false)
    let revokeError: unknown
    try {
      this.auth.revokeAll()
    } catch (error) {
      // Transport teardown is the primary kill-switch guarantee and must never be skipped,
      // even if the OS keyring disappears after startup.
      revokeError = error
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    await this.stop()
    this.audit.record({
      kind: 'lifecycle', outcome: revokeError ? 'error' : 'accepted',
      action: 'killSwitch.activate', detail: revokeError ? { message: this.lastError } : undefined
    })
    return this.status()
  }

  listDevices(): DeviceInfo[] { return this.auth.listDevices() }

  revokeDevice(deviceId: string): boolean {
    const revoked = this.auth.revoke(deviceId)
    if (revoked) this.audit.record({ kind: 'lifecycle', outcome: 'accepted', action: 'device.revoke', deviceId })
    return revoked
  }

  async startPairing(request: RemotePairStartRequest = {}): Promise<PairingChallenge> {
    if (!this.gateway || this.tunnel.status().state !== 'online') {
      throw new Error('Remote-Gateway und Tunnel müssen für das Pairing online sein.')
    }
    const challenge = this.auth.startPairing(request.capabilities, request.deviceNameHint)
    const publicUrl = this.tunnel.status().publicUrl
    if (!publicUrl) throw new Error('Öffentliche Tunnel-URL fehlt.')
    const pairingUrl = `${publicUrl}/#/pair?code=${encodeURIComponent(challenge.code)}`
    return { ...challenge, pairingUrl, qrDataUrl: await pairingQrDataUrl(pairingUrl) }
  }
}

export const remoteService = new RemoteService()

export function startRemoteGatewayIfEnabled(): Promise<void> { return remoteService.startIfEnabled() }
export function stopRemoteGateway(): Promise<void> { return remoteService.stop() }
