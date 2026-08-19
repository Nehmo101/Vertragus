import { describe, expect, it, vi } from 'vitest'
import { REMOTE_COMMANDS } from '@shared/remote/protocol'
import { runRemoteCommand, type RemoteGatewayHost } from './gateway'

function host(overrides: Partial<RemoteGatewayHost> = {}): RemoteGatewayHost {
  return {
    listWorkspaces: () => [
      {
        workspaceId: 'w1',
        name: 'Paradiso',
        profileId: 'p1',
        active: true,
        agents: []
      }
    ],
    listProfiles: () => [{ id: 'p1', name: 'Profile', repoPath: '/repo' }],
    startWorkspace: vi.fn(),
    stopWorkspace: vi.fn(),
    ...overrides
  }
}

describe('runRemoteCommand', () => {
  it('lists workspaces and profiles', async () => {
    const h = host()
    expect(await runRemoteCommand(h, 'workspaces:list', undefined)).toMatchObject({
      ok: true,
      result: [{ workspaceId: 'w1' }]
    })
    expect(await runRemoteCommand(h, 'profiles:list', undefined)).toMatchObject({
      ok: true,
      result: [{ id: 'p1' }]
    })
  })

  it('starts a workspace by profileId', async () => {
    const start = vi.fn()
    const result = await runRemoteCommand(host({ startWorkspace: start }), 'workspaces:start', 'p1')
    expect(result).toEqual({ ok: true, result: { started: 'p1' } })
    expect(start).toHaveBeenCalledWith('p1')
  })

  it('stops a workspace by workspaceId', async () => {
    const stop = vi.fn()
    const result = await runRemoteCommand(host({ stopWorkspace: stop }), 'workspaces:stop', 'w1')
    expect(result).toEqual({ ok: true, result: { stopped: 'w1' } })
    expect(stop).toHaveBeenCalledWith('w1')
  })

  it('refuses start/stop without an argument instead of throwing', async () => {
    expect(await runRemoteCommand(host(), 'workspaces:start', undefined)).toMatchObject({ ok: false })
    expect(await runRemoteCommand(host(), 'workspaces:stop', undefined)).toMatchObject({ ok: false })
  })

  it('turns a host failure into a gateway error, not a crash', async () => {
    const result = await runRemoteCommand(
      host({
        startWorkspace: () => {
          throw new Error('no repo path')
        }
      }),
      'workspaces:start',
      'p1'
    )
    expect(result).toEqual({ ok: false, error: 'no repo path' })
  })

  it('the exposed surface is exactly four read/lifecycle verbs — no settings, no editing', () => {
    // A guard against scope creep: this list is the whole remote surface.
    expect([...REMOTE_COMMANDS].sort()).toEqual([
      'profiles:list',
      'workspaces:list',
      'workspaces:start',
      'workspaces:stop'
    ])
  })
})
