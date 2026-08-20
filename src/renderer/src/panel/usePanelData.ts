/**
 * The panel's data layer: one hook, no store library.
 *
 * The panel shows three small lists and toggles one setting — a zustand store
 * would be more machinery than state. What matters is that every bridge call
 * routes through `fail`, so a rejected IPC (the workspace manager refusing to
 * start, a save that did not validate) always ends up visible in the panel
 * instead of in the devtools console nobody has open.
 *
 * Workspaces arrive over `ev:workspaces` — the manager pushes on every change
 * (agent events, question badges, start/stop), so there is no poll here. The
 * one belt-and-braces refresh left is window focus: if a push was ever lost
 * while the panel was in the background, looking at it makes it true again.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Profile } from '@shared/schema/profile'
import type {
  PanelSettings,
  UpdateState,
  VertragusAppApi,
  WorkspaceSummary
} from '../../../preload'
import { errorText } from './viewModel'

export interface PanelData {
  bridge: VertragusAppApi | undefined
  profiles: Profile[]
  workspaces: WorkspaceSummary[]
  settings: PanelSettings | null
  /** Null until the first push/poll; `disabled` in a dev run. */
  update: UpdateState | null
  error: string | null
  dismissError(): void
  /** Start a workspace; a non-empty goal is seeded into the orchestrator (H2). */
  startWorkspace(profileId: string, goal?: string): void
  stopWorkspace(workspaceId: string): void
  /** Answer an agent's open question from its `?` badge (H1). */
  answerQuestion(workspaceId: string, agentId: string, questionId: string, text: string): void
  /** D2: steer a running workspace — wakes the orchestrator's await_events. */
  sendUserMessage(workspaceId: string, text: string): void
  focusAgent(agentId: string): void
  /** Close a finished agent's CLI window; the row and last task stay. */
  closeAgentWindow(agentId: string): void
  /** Bring this workspace's CLI windows forward; minimize the others. */
  focusWorkspace(workspaceId: string): void
  editProfile(profileId?: string): void
  openSettings(): void
  toggleYolo(): void
  hideAll(): void
  /** The head's − : put the panel itself down to the taskbar. */
  minimizePanel(): void
  /** Restart into the downloaded update — the badge's click target. */
  installUpdate(): void
  /** Quit Vertragus — main asks first when agents are still running. */
  quitApp(): void
}

export function usePanelData(): PanelData {
  const bridge = useMemo(() => window.vertragus?.app, [])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [settings, setSettings] = useState<PanelSettings | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fail = useCallback((cause: unknown) => setError(errorText(cause)), [])

  useEffect(() => {
    if (!bridge) return
    let alive = true

    const loadWorkspaces = (): void => {
      bridge.listWorkspaces().then((next) => {
        if (alive) setWorkspaces(next)
      }, fail)
    }
    bridge.listProfiles().then((next) => {
      if (alive) setProfiles(next)
    }, fail)
    bridge.getSettings().then((next) => {
      if (alive) setSettings(next)
    }, fail)
    // The updater is the one source here that may be absent entirely (dev run,
    // GitHub down). Its failure stays silent: the badge simply never appears,
    // and a red banner about updates would bury the workspaces below it.
    bridge.getUpdateState().then(
      (next) => {
        if (alive) setUpdate(next)
      },
      () => undefined
    )
    loadWorkspaces()

    const offProfiles = bridge.onProfiles((next) => setProfiles(next))
    const offWorkspaces = bridge.onWorkspaces((next) => setWorkspaces(next))
    const offUpdate = bridge.onUpdate((next) => setUpdate(next))
    window.addEventListener('focus', loadWorkspaces)

    return () => {
      alive = false
      offProfiles()
      offWorkspaces()
      offUpdate()
      window.removeEventListener('focus', loadWorkspaces)
    }
  }, [bridge, fail])

  const run = useCallback(
    (action: (api: VertragusAppApi) => Promise<unknown>) => {
      if (!bridge) return
      setError(null)
      action(bridge).catch(fail)
    },
    [bridge, fail]
  )

  return {
    bridge,
    profiles,
    workspaces,
    settings,
    update,
    error,
    dismissError: () => setError(null),
    startWorkspace: (profileId, goal) =>
      run(async (api) => {
        await api.startWorkspace(profileId, goal)
        setWorkspaces(await api.listWorkspaces())
      }),
    stopWorkspace: (workspaceId) =>
      run(async (api) => {
        await api.stopWorkspace(workspaceId)
        setWorkspaces(await api.listWorkspaces())
      }),
    answerQuestion: (workspaceId, agentId, questionId, text) =>
      run(async (api) => {
        await api.answerQuestion(workspaceId, agentId, questionId, text)
        setWorkspaces(await api.listWorkspaces())
      }),
    sendUserMessage: (workspaceId, text) =>
      run((api) => api.sendUserMessage(workspaceId, text)),
    focusAgent: (agentId) => run((api) => api.focusAgent(agentId)),
    closeAgentWindow: (agentId) => run((api) => api.closeAgentWindow(agentId)),
    focusWorkspace: (workspaceId) => run((api) => api.focusWorkspace(workspaceId)),
    editProfile: (profileId) => run((api) => api.openProfileEditor(profileId)),
    openSettings: () => run((api) => api.openSettings()),
    installUpdate: () => run((api) => api.installUpdate()),
    toggleYolo: () =>
      run(async (api) => {
        const next = await api.setYoloMaster(!(settings?.yoloMaster ?? false))
        setSettings(next)
      }),
    hideAll: () => run((api) => api.hideAllWindows()),
    minimizePanel: () => run((api) => api.minimizePanel()),
    quitApp: () => run((api) => api.quitApp())
  }
}
