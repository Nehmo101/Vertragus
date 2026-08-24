/**
 * Production voice wiring: VoiceHost against the workspace directory,
 * session lifecycle, and the panel-only IPC port.
 *
 * The domain engine in `voice/` is not rewritten here. This file starts and
 * stops it, recreates the realtime client when key/provider/wake/locale/voiceId
 * change, and never logs the API key.
 */
import { session as electronSession, type Session } from 'electron'
import {
  APP_CHANNELS,
  type AppVoicePort,
  type VoiceEventPayload,
  type VoiceStatusPayload,
  type WorkspaceDirectory
} from './appIpc'
import { mainMessages, readLocale } from '@shared/mainMessages'
import type { VoiceHost, VoiceHostProfile, VoiceHostWorkspace } from '@shared/voice/commands'
import { defaultVoiceId, type VoiceClient, type VoiceProvider } from './voice/client'
import { createVoiceSession, type VoicePhase, type VoiceSession } from './voice/session'
import { createXaiClient, resolveXaiApiKey, type InjectedWebSocketConstructor } from './voice/xai'
import { createOpenaiClient, resolveOpenaiApiKey } from './voice/openai'
import { HeaderWebSocket } from './headerWebSocket'
import type { AppSettings, SettingsStore } from './store/settings'

function keyStamp(apiKey: string): string {
  let sum = 0
  for (let i = 0; i < apiKey.length; i += 1) {
    sum = (sum + apiKey.charCodeAt(i) * (i + 1)) >>> 0
  }
  return `${apiKey.length}:${sum}`
}

export function missingApiKeyMessage(
  locale: AppSettings['ui']['locale'],
  provider: VoiceProvider = 'xai'
): string {
  const messages = mainMessages(readLocale(() => locale))
  return provider === 'openai' ? messages.voiceMissingOpenaiApiKey : messages.voiceMissingApiKey
}

/** media/microphone for the panel (capture) and settings (device labels). */
export function voicePermissionAllowed(isVoiceWindow: boolean, permission: string): boolean {
  if (permission === 'media' || permission === 'microphone') return isVoiceWindow
  return true
}

export function installVoicePermissionHandlers(
  sess: Session,
  isVoiceWindowSender: (webContentsId: number) => boolean
): void {
  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(voicePermissionAllowed(isVoiceWindowSender(webContents.id), permission))
  })
  sess.setPermissionCheckHandler((webContents, permission) => {
    const allowed = Boolean(webContents && isVoiceWindowSender(webContents.id))
    return voicePermissionAllowed(allowed, permission)
  })
}

export interface VoiceCommandHostDeps {
  directory: WorkspaceDirectory
  store: () => SettingsStore
  hideAll(): void
  openSettings(): void
  openProfileEditor(profileId?: string): void
  quit(): void
  onYoloChanged?(): void
}

export function createVoiceCommandHost(deps: VoiceCommandHostDeps): VoiceHost {
  return {
    listProfiles(): VoiceHostProfile[] {
      return deps.store().getProfiles().map((profile) => ({
        id: profile.id,
        name: profile.name
      }))
    },
    listWorkspaces(): VoiceHostWorkspace[] {
      return deps.directory.list().map((workspace) => ({
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        profileId: workspace.profileId,
        profileName: workspace.profileName,
        active: workspace.active,
        taskText: workspace.taskText,
        agents: workspace.agents.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          roleId: agent.roleId,
          state: agent.state
        }))
      }))
    },
    async startWorkspace(profileId, goal) {
      await deps.directory.start(profileId, goal)
    },
    async stopWorkspace(workspaceId) {
      await deps.directory.stop(workspaceId)
    },
    focusWorkspace(workspaceId) {
      deps.directory.focusWorkspace(workspaceId)
    },
    focusAgent(agentId) {
      deps.directory.focusAgent(agentId)
    },
    hideAll() {
      deps.hideAll()
    },
    openSettings() {
      deps.openSettings()
    },
    openProfileEditor(profileId) {
      deps.openProfileEditor(profileId)
    },
    setYolo(enabled) {
      deps.store().setSetting('yoloMaster', enabled)
      deps.onYoloChanged?.()
    },
    async sendToOrchestrator(workspaceId, text) {
      await deps.directory.sendToOrchestrator(workspaceId, text)
    },
    quitApp() {
      deps.quit()
    }
  }
}

export interface AppVoiceDeps extends VoiceCommandHostDeps {
  sendToPanel(channel: string, payload: unknown): void
  fetchImpl?: typeof fetch
  WebSocketImpl?: InjectedWebSocketConstructor
}

export interface AppVoice {
  readonly port: AppVoicePort
  dispose(): void
}

function resolveVoiceKey(
  settings: AppSettings
): { provider: VoiceProvider; apiKey: string } | undefined {
  const provider = settings.voice.provider
  const apiKey =
    provider === 'openai'
      ? resolveOpenaiApiKey(settings.voice.openaiApiKey)
      : resolveXaiApiKey(settings.voice.apiKey)
  if (!apiKey) return undefined
  return { provider, apiKey }
}

function createProviderClient(
  provider: VoiceProvider,
  apiKey: string,
  fetchImpl: typeof fetch,
  WebSocketImpl: InjectedWebSocketConstructor
): VoiceClient {
  if (provider === 'openai') {
    return createOpenaiClient({ fetch: fetchImpl, WebSocket: WebSocketImpl, apiKey })
  }
  return createXaiClient({ fetch: fetchImpl, WebSocket: WebSocketImpl, apiKey })
}

export function createAppVoice(deps: AppVoiceDeps): AppVoice {
  const host = createVoiceCommandHost(deps)
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const WebSocketImpl = deps.WebSocketImpl ?? (HeaderWebSocket as unknown as InjectedWebSocketConstructor)

  let client: VoiceClient | undefined
  let voiceSession: VoiceSession | undefined
  let phase: VoicePhase = 'idle'
  let lastError: string | undefined
  let fingerprint: string | undefined

  function currentStatus(): VoiceStatusPayload {
    const enabled = deps.store().getSettings().voice.enabled
    return lastError
      ? { phase, enabled, error: lastError }
      : { phase, enabled }
  }

  function emitVoice(extra?: Partial<VoiceEventPayload>): void {
    const payload: VoiceEventPayload = {
      phase,
      ...(lastError ? { error: lastError } : {}),
      ...extra
    }
    deps.sendToPanel(APP_CHANNELS.eventVoice, payload)
  }

  function stopSession(): void {
    voiceSession?.stop()
    voiceSession = undefined
    client?.close()
    client = undefined
    fingerprint = undefined
    phase = 'idle'
    lastError = undefined
  }

  function configFingerprint(settings: AppSettings, provider: VoiceProvider, apiKey: string): string {
    return [
      provider,
      keyStamp(apiKey),
      settings.voice.wakePhrase,
      settings.voice.voiceId,
      settings.ui.locale
    ].join('\0')
  }

  function startSession(): void {
    const settings = deps.store().getSettings()
    const resolved = resolveVoiceKey(settings)
    if (!resolved) {
      stopSession()
      phase = 'error'
      lastError = missingApiKeyMessage(settings.ui.locale, settings.voice.provider)
      emitVoice()
      return
    }
    const nextPrint = configFingerprint(settings, resolved.provider, resolved.apiKey)
    if (voiceSession && fingerprint === nextPrint) {
      if (phase === 'idle' || phase === 'error') voiceSession.start()
      return
    }
    stopSession()
    client = createProviderClient(resolved.provider, resolved.apiKey, fetchImpl, WebSocketImpl)
    voiceSession = createVoiceSession({
      host,
      client,
      config: {
        wakePhrase: settings.voice.wakePhrase,
        voiceId: defaultVoiceId(resolved.provider, settings.voice.voiceId),
        locale: settings.ui.locale,
        provider: resolved.provider
      },
      onPhase: (next) => {
        phase = next
        emitVoice()
      },
      onTranscript: (text) => {
        emitVoice({ transcript: text })
      },
      onAudioOut: (pcm) => {
        deps.sendToPanel(APP_CHANNELS.voiceAudio, pcm)
      },
      onError: (message) => {
        lastError = message
        emitVoice({ error: message })
      }
    })
    fingerprint = nextPrint
    voiceSession.start()
    phase = voiceSession.phase
    emitVoice()
  }

  async function setEnabled(on: boolean): Promise<VoiceStatusPayload> {
    if (!on) {
      stopSession()
      emitVoice()
      return currentStatus()
    }
    startSession()
    return currentStatus()
  }

  const port: AppVoicePort = {
    status: () => currentStatus(),
    setEnabled,
    pushPcm(pcm) {
      void voiceSession?.pushPcm(pcm)
    }
  }

  return {
    port,
    dispose() {
      stopSession()
    }
  }
}

export function installDefaultVoicePermissions(
  isVoiceWindowSender: (webContentsId: number) => boolean
): void {
  installVoicePermissionHandlers(electronSession.defaultSession, isVoiceWindowSender)
}
