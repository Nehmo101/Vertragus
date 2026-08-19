import { describe, expect, it, vi } from 'vitest'

// devRun is the production wiring: it reaches for Electron's userData path, the
// real CLI windows and the settings store. Only the pure parts are under test
// here, so Electron is replaced wholesale.
vi.mock('electron', () => ({ app: { getPath: () => '/userData' }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('./windows/cliWindow', () => ({
  createCliWindow: vi.fn(),
  closeCliWindow: vi.fn(),
  getCliWindow: vi.fn(() => null),
  isCliWindowSender: vi.fn(() => null)
}))

import { buildDevProfile, DEV_RUN_ENV, maybeStartDevWorkspace } from './devRun'
import { profileRoleIds, slotLimitFor } from '@shared/schema/profile'
import type { McpServerHandle } from './mcp/server'
import type { WorkspaceManager } from './workspace/WorkspaceManager'

describe('buildDevProfile', () => {
  it('is a valid profile with a worker and a reviewer on Claude', () => {
    const profile = buildDevProfile('C:\\git\\playground')

    expect(profile.repoPath).toBe('C:\\git\\playground')
    expect(profile.orchestrator.providerId).toBe('claude')
    expect(profileRoleIds(profile)).toEqual(['worker', 'reviewer'])
    expect(profile.maxSubagents).toBe(4)
    // No per-slot cap: only maxSubagents binds, which is what a dev run wants.
    expect(slotLimitFor(profile, 'worker')).toEqual({ configured: true })
  })
})

function fakeMcp(): McpServerHandle & { closed: number } {
  return {
    port: 4711,
    closed: 0,
    registerWorkspace: vi.fn(),
    unregisterWorkspace: vi.fn(),
    orchestratorUrl: () => '',
    subagentUrl: () => '',
    pendingQuestion: () => undefined,
    workspaceTask: () => undefined,
    agentTask: () => undefined,
    close: vi.fn(async function (this: { closed: number }) {
      this.closed += 1
    })
  } as unknown as McpServerHandle & { closed: number }
}

describe('maybeStartDevWorkspace', () => {
  it('does nothing without the env var', async () => {
    const startServer = vi.fn()
    await expect(
      maybeStartDevWorkspace({ env: {}, startServer: startServer as never })
    ).resolves.toBeUndefined()
    expect(startServer).not.toHaveBeenCalled()
  })

  it('starts the workspace for the repo in the env var', async () => {
    const mcp = fakeMcp()
    const workspace = { name: 'Paradiso' }
    const manager = {
      startWorkspace: vi.fn(async () => ({
        workspace,
        orchestrator: { agentId: 'a1', name: 'Virgilio', role: 'orchestrator' },
        urls: { orchestratorUrl: 'u', subagentUrl: () => 's' }
      })),
      stopAll: vi.fn(async () => undefined)
    } as unknown as WorkspaceManager
    const log = vi.fn()

    const handle = await maybeStartDevWorkspace({
      env: { [DEV_RUN_ENV]: ' /repo ' },
      startServer: (async () => mcp) as never,
      createManager: () => manager,
      log
    })

    expect(manager.startWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/repo' })
    )
    expect(log.mock.calls[0]![0]).toContain('Paradiso')
    await handle!.stop()
    expect(manager.stopAll).toHaveBeenCalled()
  })

  it('never takes the app down when the run fails — it closes the server instead', async () => {
    const mcp = fakeMcp()
    const manager = {
      startWorkspace: vi.fn(async () => {
        throw new Error('claude not installed')
      })
    } as unknown as WorkspaceManager
    const logError = vi.fn()

    await expect(
      maybeStartDevWorkspace({
        env: { [DEV_RUN_ENV]: '/repo' },
        startServer: (async () => mcp) as never,
        createManager: () => manager,
        logError
      })
    ).resolves.toBeUndefined()

    expect(logError).toHaveBeenCalled()
    expect(mcp.close).toHaveBeenCalled()
  })
})
