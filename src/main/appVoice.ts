/**
 * Production voice wiring: VoiceHost against the workspace directory,
 * session lifecycle, and the panel-only IPC port.
 *
 * The domain engine in `voice/` is not rewritten here. This file starts and
 * stops it, recreates the xAI client when key/wake/locale/voiceId change, and
 * never logs the API key.
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
import { createVoiceSession, type VoicePhase, type VoiceSession } from './voice/session'
import {
  createXaiClient,
  resolveXaiApiKey,
  type InjectedWebSocketConstructor,
  type XaiClient
} from './voice/xai'
import { HeaderWebSocket } from './headerWebSocket'
import type { AppSettings, SettingsStore } from './store/settings'

function keyStamp(apiKey: string): string {
  let sum = 0
  for (let i = 0; i < apiKey.length; i += 1) {
    sum = (sum + apiKey.charCodeAt(i) * (i + 1)) >>> 0
  }
  return `${apiKey.length}:${sum}`
}

export function missingApiKeyMessage(locale: AppSettings['ui']['locale']): string {
  return mainMessages(readLocale(() => locale)).voiceMissingApiKey
}

/** media/microphone only for the panel; every other permission stays as before. */
export function voicePermissionAllowed(isPanel: boolean, permission: string): boolean {
  if (permission === 'media' || permission === 'microphone') return isPanel
  return true
}

export function installVoicePermissionHandlers(
  sess: Session,
  isPanelSender: (webContentsId: number) => boolean
): void {
  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(voicePermissionAllowed(isPanelSender(webContents.id), permission))
  })
  sess.setPermissionCheckHandler((webContents, permission) => {
    const isPanel = Boolean(webContents && isPanelSender(webContents.id))
    return voicePermissionAllowed(isPanel, permission)
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

export function createAppVoice(deps: AppVoiceDeps): AppVoice {
  const host = createVoiceCommandHost(deps)
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const WebSocketImpl = deps.WebSocketImpl ?? (HeaderWebSocket as unknown as InjectedWebSocketConstructor)

  let client: XaiClient | undefined
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

  function configFingerprint(settings: AppSettings, apiKey: string): string {
    return [
      keyStamp(apiKey),
      settings.voice.wakePhrase,
      settings.voice.voiceId,
      settings.ui.locale
    ].join('\0')
  }

  function startSession(): void {
    const settings = deps.store().getSettings()
    const apiKey = resolveXaiApiKey(settings.voice.apiKey)
    if (!apiKey) {
      stopSession()
      phase = 'error'
      lastError = missingApiKeyMessage(settings.ui.locale)
      emitVoice()
      return
    }
    const nextPrint = configFingerprint(settings, apiKey)
    if (voiceSession && fingerprint === nextPrint) {
      if (phase === 'idle' || phase === 'error') voiceSession.start()
      return
    }
    stopSession()
    client = createXaiClient({
      fetch: fetchImpl,
      WebSocket: WebSocketImpl,
      apiKey
    })
    voiceSession = createVoiceSession({
      host,
      client,
      config: {
        wakePhrase: settings.voice.wakePhrase,
        voiceId: settings.voice.voiceId || 'eve',
        locale: settings.ui.locale
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
  isPanelSender: (webContentsId: number) => boolean
): void {
  installVoicePermissionHandlers(electronSession.defaultSession, isPanelSender)
}
