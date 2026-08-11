/**
 * The panel's data layer: one hook, no store library.
 *
 * The panel shows three small lists and toggles one setting — a zustand store
 * would be more machinery than state. What matters is that every bridge call
 * routes through `fail`, so a rejected IPC (the workspace manager refusing to
 * start, a save that did not validate) always ends up visible in the panel
 * instead of in the devtools console nobody has open.
 *
 * Workspaces are additionally polled: `ev:workspaces` is the fast path, but the
 * panel must also be right when whoever owns the workspaces forgets to emit.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Profile } from '@shared/schema/profile'
import type { PanelSettings, VertragusAppApi, WorkspaceSummary } from '../../../preload'
import { errorText } from './viewModel'

/** Slow enough to be free, fast enough that a stale card is never a surprise. */
export const WORKSPACE_POLL_MS = 4_000

export interface PanelData {
  bridge: VertragusAppApi | undefined
  profiles: Profile[]
  workspaces: WorkspaceSummary[]
  settings: PanelSettings | null
  error: string | null
  dismissError(): void
  startWorkspace(profileId: string): void
  stopWorkspace(workspaceId: string): void
  focusAgent(agentId: string): void
  editProfile(profileId?: string): void
  toggleYolo(): void
  hideAll(): void
  /** Quit Vertragus — main asks first when agents are still running. */
  quitApp(): void
}

export function usePanelData(): PanelData {
  const bridge = useMemo(() => window.vertragus?.app, [])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [settings, setSettings] = useState<PanelSettings | null>(null)
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
    loadWorkspaces()

    const offProfiles = bridge.onProfiles((next) => setProfiles(next))
    const offWorkspaces = bridge.onWorkspaces((next) => setWorkspaces(next))
    const timer = setInterval(loadWorkspaces, WORKSPACE_POLL_MS)

    return () => {
      alive = false
      offProfiles()
      offWorkspaces()
      clearInterval(timer)
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
    error,
    dismissError: () => setError(null),
    startWorkspace: (profileId) =>
      run(async (api) => {
        await api.startWorkspace(profileId)
        setWorkspaces(await api.listWorkspaces())
      }),
    stopWorkspace: (workspaceId) =>
      run(async (api) => {
        await api.stopWorkspace(workspaceId)
        setWorkspaces(await api.listWorkspaces())
      }),
    focusAgent: (agentId) => run((api) => api.focusAgent(agentId)),
    editProfile: (profileId) => run((api) => api.openProfileEditor(profileId)),
    toggleYolo: () =>
      run(async (api) => {
        const next = await api.setYoloMaster(!(settings?.yoloMaster ?? false))
        setSettings(next)
      }),
    hideAll: () => run((api) => api.hideAllWindows()),
    quitApp: () => run((api) => api.quitApp())
  }
}
