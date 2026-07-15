import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { join, resolve } from 'node:path'
import { getProfile, getSetting, setSetting } from '@main/config/store'
import { createIdea } from '@main/inbox/store'
import { transferIdeaToProfile } from '@main/inbox/transferService'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
import { loadTaskReviewDiff } from '@main/integrations/reviewDiff'
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
  readAccessConfig,
  readCloudflareCredential,
  writeAccessConfig,
  writeCloudflareCredential
} from './deviceStore'
import { startRemoteGateway } from './RemoteGateway'
import type { RemoteGatewayHandle } from './gatewayHandle'
import { setRemoteGatewayHandle } from './gatewayHandle'
import { pairingQrDataUrl } from './qrcode'
import { RemoteReadModel } from './readModel'
import { TunnelManager, tunnelStatusToRemote } from './tunnelManager'
import { redactAndLimitRemoteDiff } from './remoteDiff'
import { PushService } from './pushService'
import { transcribeInboxAudio } from '@main/voice/InboxSpeechService'
import { CloudflareAccessVerifier } from './accessIdentity'

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
  private readonly push = new PushService(this.readModel, undefined, (deviceId, profileId, sessionId) => {
    if (!profileId || !sessionId) return false
    const device = this.auth.listDevices().find((entry) => entry.id === deviceId && !entry.revokedAt)
    return Boolean(device?.scopes.find((scope) =>
      scope.profileId === profileId && scope.sessionIds.includes(sessionId)
    ))
  })
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
    approvePublication: (profileId, sessionId, planId) =>
      workspaceSessions.approvePublication(requireProfile(profileId), planId, sessionId),
    rejectPublication: (profileId, sessionId, planId) =>
      workspaceSessions.rejectPublication(requireProfile(profileId), planId, sessionId),
    taskDiff: async (profileId, sessionId, taskId) => {
      const profile = requireProfile(profileId)
      const task = workspaceSessions.snapshot(profile, sessionId).tasks.find((entry) => entry.id === taskId)
      if (!task) throw new Error('Aufgabe nicht gefunden.')
      return redactAndLimitRemoteDiff(await loadTaskReviewDiff(task))
    },
    resolvePermission: (profileId, sessionId, permissionId, allow) =>
      workspaceSessions.resolvePermission(requireProfile(profileId), permissionId, allow, sessionId),
    setBudgetCaps: (profileId, sessionId, caps) =>
      workspaceSessions.setBudgetCaps(requireProfile(profileId), caps, sessionId),
    pauseTask: (profileId, sessionId, taskId) =>
      workspaceSessions.pauseTask(requireProfile(profileId), taskId, sessionId),
    resumeTask: (profileId, sessionId, taskId) =>
      workspaceSessions.resumeTask(requireProfile(profileId), taskId, sessionId),
    replanPending: (profileId, sessionId, input) =>
      workspaceSessions.replanPending(requireProfile(profileId), input, sessionId),
    activateKillSwitch: () => {
      setImmediate(() => { void this.disable() })
    }
  })

  constructor() {
    super()
    this.push.on('delivery', (transition, outcome) => {
      this.audit.record({
        kind: 'lifecycle', outcome: outcome === 'error' ? 'error' : 'accepted',
        action: 'push.delivery', detail: { transition, outcome }
      })
    })
    this.tunnel.on('status', (status) => {
      if (status.publicUrl && this.gateway) {
        try { this.gateway.addAllowedHost(new URL(status.publicUrl).hostname) } catch { /* validated upstream */ }
      }
      this.emitStatus()
    })
    this.auth.on('revoked', (deviceId: string) => {
      this.gateway?.dropDevice(deviceId)
      try { this.push.removeDevice(deviceId) } catch { /* Revocation itself already succeeded. */ }
      this.emitStatus()
    })
    this.auth.on('revoke-all', () => {
      try { this.push.removeAll() } catch { /* Gateway teardown still proceeds. */ }
      this.emitStatus()
    })
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
    if (request.accessTeamDomain || request.accessAudience) {
      if (!request.accessTeamDomain || !request.accessAudience) {
        throw new Error('Access-Team-Domain und Audience mÃ¼ssen gemeinsam angegeben werden.')
      }
      writeAccessConfig({ teamDomain: request.accessTeamDomain, audience: request.accessAudience })
    }
    const currentMode = getSetting<'named' | 'quick'>('remote.tunnelMode') ?? 'named'
    const mode = request.quickTunnel === true
      ? 'quick'
      : request.quickTunnel === false || request.hostname || request.tunnelToken
        ? 'named'
        : currentMode
    if (mode === 'named' && !readCloudflareCredential()) {
      throw new Error('Für Remote-Zugriff fehlt die Named-Tunnel-Konfiguration.')
    }
    setSetting('remote.tunnelMode', mode)
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
    const mode = getSetting<'named' | 'quick'>('remote.tunnelMode') ?? 'named'
    const credential = mode === 'named' ? readCloudflareCredential() : undefined
    if (mode === 'named' && !credential) {
      this.lastError = 'Named-Tunnel-Konfiguration fehlt.'
      setSetting('remote.enabled', false)
      throw new Error(this.lastError)
    }
    this.lastError = undefined
    this.readModel.start()
    this.push.start()
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
      allowedHosts: credential ? [credential.hostname] : [],
      identityVerifier: readAccessConfig()
        ? new CloudflareAccessVerifier(readAccessConfig()!)
        : undefined,
      pushService: this.push,
      transcribeSpeech: transcribeInboxAudio
    })
    setRemoteGatewayHandle(this.gateway)
    await this.tunnel.start({
      origin: this.gateway.origin,
      mode,
      hostname: credential?.hostname,
      tunnelToken: credential?.tunnelToken
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
    this.push.stop()
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
    const actor = request.actor ?? { id: 'owner', displayName: 'Owner' }
    const scopes = (request.scopes ?? []).map((scope) => {
      requireProfile(scope.profileId)
      for (const sessionId of scope.sessionIds) {
        const session = workspaceSessions.getById(sessionId)
        if (!session || session.profileId !== scope.profileId) {
          throw new Error('Pairing-Scope enthÃ¤lt eine unbekannte Workspace-Session.')
        }
      }
      return scope
    })
    const challenge = this.auth.startPairing(
      request.capabilities,
      request.deviceNameHint,
      actor,
      scopes
    )
    const publicUrl = this.tunnel.status().publicUrl
    if (!publicUrl) throw new Error('Öffentliche Tunnel-URL fehlt.')
    const pairingUrl = `${publicUrl}/#/pair?code=${encodeURIComponent(challenge.code)}`
    return { ...challenge, pairingUrl, qrDataUrl: await pairingQrDataUrl(pairingUrl) }
  }
}

export const remoteService = new RemoteService()

export function startRemoteGatewayIfEnabled(): Promise<void> { return remoteService.startIfEnabled() }
export function stopRemoteGateway(): Promise<void> { return remoteService.stop() }
