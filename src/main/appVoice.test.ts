import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { quit: vi.fn(), isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  session: {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn()
    }
  }
}))
vi.mock('@main/store/settings', async () => await vi.importActual('@main/store/settings'))
vi.mock('@main/providers/discovery', () => ({ discoverModels: vi.fn() }))
vi.mock('@main/providers/health', () => ({ checkAllProviders: vi.fn() }))
vi.mock('@main/providers/authStatus', () => ({ checkAllProviderAuth: vi.fn() }))
vi.mock('@main/windows/cliWindow', () => ({
  focusCliWindow: vi.fn(),
  listCliWindows: vi.fn(() => [])
}))
vi.mock('@main/windows/panel', () => ({
  getPanelWindow: vi.fn(() => null),
  isPanelWindowSender: vi.fn(() => false)
}))
vi.mock('@main/windows/profileEditor', () => ({
  isProfileEditorWindowSender: vi.fn(() => null),
  openProfileEditorWindow: vi.fn(),
  closeProfileEditorWindow: vi.fn(),
  listProfileEditorWindows: vi.fn(() => [])
}))
vi.mock('@main/windows/providerEditor', () => ({
  isProviderEditorWindowSender: vi.fn(() => null),
  openProviderEditorWindow: vi.fn(),
  closeProviderEditorWindow: vi.fn(),
  listProviderEditorWindows: vi.fn(() => [])
}))
vi.mock('@main/windows/settingsWindow', () => ({
  isSettingsWindowSender: vi.fn(() => false),
  openSettingsWindow: vi.fn(),
  closeSettingsWindow: vi.fn(),
  getSettingsWindow: vi.fn(() => null)
}))
vi.mock('@main/updater', () => ({
  appUpdater: vi.fn(() => ({
    state: vi.fn(),
    check: vi.fn(),
    setChannel: vi.fn(),
    install: vi.fn()
  })),
  onUpdateState: vi.fn(() => () => undefined)
}))
vi.mock('@main/windows/zoneOverlay', () => ({
  openZoneOverlayWindows: vi.fn(),
  closeZoneOverlayWindows: vi.fn(),
  isZoneOverlaySender: vi.fn(() => null),
  listZoneOverlayWindows: vi.fn(() => []),
  zoneOverlayDisplayIds: vi.fn(() => [])
}))
vi.mock('@main/windows/hideAll', () => ({
  toggleHideAll: vi.fn(),
  hideAllHotkeyStatus: vi.fn(() => undefined),
  reRegisterHideAllShortcut: vi.fn(() => ({ hotkey: 'Control+Alt+V', registered: true }))
}))

import {
  createAppVoice,
  createVoiceCommandHost,
  missingApiKeyMessage,
  voicePermissionAllowed
} from './appVoice'
import { APP_CHANNELS, type VoiceStatusPayload, type WorkspaceDirectory } from './appIpc'
import { createSettingsStore, type SettingsBackend, type SettingsStore } from './store/settings'

function memoryBackend(seed: Record<string, unknown> = {}): SettingsBackend {
  const data: Record<string, unknown> = { ...seed }
  return {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = JSON.parse(JSON.stringify(value))
    }
  }
}

function stubDirectory(): WorkspaceDirectory & {
  start: ReturnType<typeof vi.fn>
  sent: Array<{ workspaceId: string; text: string }>
} {
  const sent: Array<{ workspaceId: string; text: string }> = []
  return {
    sent,
    list: () => [],
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    sendToOrchestrator: vi.fn(async (workspaceId: string, text: string) => {
      sent.push({ workspaceId, text })
    }),
    assignGoal: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    succeedOrchestrator: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    postUserMessage: vi.fn(),
    promoteAgentBranch: vi.fn(async () => undefined),
    openRunFolder: vi.fn(async () => undefined),
    focusAgent: vi.fn(),
    closeAgentWindow: vi.fn(),
    focusWorkspace: vi.fn(),
    listStaleWorktrees: async () => [],
    removeWorktree: async () => []
  }
}

describe('voicePermissionAllowed', () => {
  it('grants media and microphone only to the panel', () => {
    expect(voicePermissionAllowed(true, 'media')).toBe(true)
    expect(voicePermissionAllowed(true, 'microphone')).toBe(true)
    expect(voicePermissionAllowed(false, 'media')).toBe(false)
    expect(voicePermissionAllowed(false, 'microphone')).toBe(false)
    expect(voicePermissionAllowed(false, 'notifications')).toBe(true)
  })
})

describe('createVoiceCommandHost', () => {
  it('starts with a goal only when one was spoken, never on Play', async () => {
    const directory = stubDirectory()
    const store = createSettingsStore({ backend: memoryBackend(), warn: vi.fn() })
    const host = createVoiceCommandHost({
      directory,
      store: () => store,
      hideAll: vi.fn(),
      openSettings: vi.fn(),
      openProfileEditor: vi.fn(),
      quit: vi.fn()
    })

    await host.startWorkspace('p1')
    expect(directory.start).toHaveBeenCalledWith('p1', undefined)

    await host.startWorkspace('p1', 'fix the tests')
    expect(directory.start).toHaveBeenCalledWith('p1', 'fix the tests')

    await host.sendToOrchestrator('w1', 'go on')
    expect(directory.sent).toEqual([{ workspaceId: 'w1', text: 'go on' }])
  })

  it('writes yolo through the store', () => {
    const store = createSettingsStore({ backend: memoryBackend(), warn: vi.fn() })
    const onYoloChanged = vi.fn()
    const host = createVoiceCommandHost({
      directory: stubDirectory(),
      store: () => store,
      hideAll: vi.fn(),
      openSettings: vi.fn(),
      openProfileEditor: vi.fn(),
      quit: vi.fn(),
      onYoloChanged
    })
    host.setYolo(false)
    expect(store.getSettings().yoloMaster).toBe(false)
    expect(onYoloChanged).toHaveBeenCalled()
  })
})

describe('createAppVoice', () => {
  let store: SettingsStore
  const sent: { channel: string; payload: unknown }[] = []

  beforeEach(() => {
    sent.length = 0
    store = createSettingsStore({ backend: memoryBackend(), warn: vi.fn() })
  })

  it('goes to error when enabled without an API key', async () => {
    const voice = createAppVoice({
      directory: stubDirectory(),
      store: () => store,
      hideAll: vi.fn(),
      openSettings: vi.fn(),
      openProfileEditor: vi.fn(),
      quit: vi.fn(),
      sendToPanel: (channel, payload) => sent.push({ channel, payload })
    })
    store.setSetting('voice', { ...store.getSettings().voice, enabled: true })
    const status = (await voice.port.setEnabled(true)) as VoiceStatusPayload
    expect(status.phase).toBe('error')
    expect(status.enabled).toBe(true)
    expect(status.error).toBe(missingApiKeyMessage('de'))
    expect(sent.some((entry) => entry.channel === APP_CHANNELS.eventVoice)).toBe(true)
  })

  it('listens when a key is present and drops the socket on disable', async () => {
    store.setSetting('voice', {
      ...store.getSettings().voice,
      enabled: true,
      apiKey: 'xai-test-key'
    })
    const voice = createAppVoice({
      directory: stubDirectory(),
      store: () => store,
      hideAll: vi.fn(),
      openSettings: vi.fn(),
      openProfileEditor: vi.fn(),
      quit: vi.fn(),
      sendToPanel: (channel, payload) => sent.push({ channel, payload }),
      fetchImpl: vi.fn() as unknown as typeof fetch
    })
    const on = (await voice.port.setEnabled(true)) as VoiceStatusPayload
    expect(on.phase).toBe('listening')
    expect(on.enabled).toBe(true)

    store.setSetting('voice', { ...store.getSettings().voice, enabled: false })
    const off = (await voice.port.setEnabled(false)) as VoiceStatusPayload
    expect(off.phase).toBe('idle')
    expect(off.enabled).toBe(false)
    expect(JSON.stringify(sent)).not.toContain('xai-test-key')
  })
})

describe('missingApiKeyMessage', () => {
  it('is English without umlauts when the UI is English', () => {
    expect(missingApiKeyMessage('en')).toMatch(/API key/)
    expect(missingApiKeyMessage('en')).not.toMatch(/[äöüÄÖÜß]/)
    expect(missingApiKeyMessage('de')).toMatch(/API-Key/)
  })
})
