import { describe, expect, it, vi } from 'vitest'
import { REMOTE_CHANNELS, registerRemoteIpc, type RemoteIpcDeps } from './ipc'
import type { RemoteController, RemoteStatus } from './controller'

function harness(overrides: Partial<RemoteIpcDeps> = {}) {
  const handlers = new Map<string, (event: { sender: { id: number } }, arg?: unknown) => unknown>()
  const status: RemoteStatus = { enabled: false, running: false, port: 9482, hasToken: false }
  const controller: RemoteController = {
    status: () => status,
    clients: () => [{ remoteAddress: '100.64.0.9', createdAt: 1, lastSeenAt: 2 }],
    apply: vi.fn(async () => status),
    regenerateToken: vi.fn(async () => status),
    revoke: vi.fn(() => true),
    stop: vi.fn(async () => {})
  }
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  const deps: RemoteIpcDeps = {
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener as never),
      removeHandler: (channel) => handlers.delete(channel)
    },
    controller,
    bindOptions: () => [{ label: 'Tailscale', address: '100.64.0.1', tailscale: true }],
    isSettingsSender: () => true,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    ...overrides
  }
  const ipc = registerRemoteIpc(deps)
  const call = (channel: string, arg?: unknown, senderId = 1): unknown =>
    handlers.get(channel)!({ sender: { id: senderId } }, arg)
  return { ipc, call, controller, broadcasts }
}

describe('registerRemoteIpc', () => {
  it('rejects any window that is not the settings window', () => {
    const { call } = harness({ isSettingsSender: () => false })
    expect(() => call(REMOTE_CHANNELS.get)).toThrow(/not available/)
  })

  it('applies a sanitized patch and pushes a fresh status', async () => {
    const { call, controller, broadcasts } = harness()
    await call(REMOTE_CHANNELS.set, { enabled: true, bindAddress: '0.0.0.0', port: 1234, evil: 'x' })
    expect(controller.apply).toHaveBeenCalledWith({ enabled: true, bindAddress: '0.0.0.0', port: 1234 })
    expect(broadcasts.at(-1)?.channel).toBe(REMOTE_CHANNELS.event)
  })

  it('drops non-writable and mistyped fields from the patch', async () => {
    const { call, controller } = harness()
    await call(REMOTE_CHANNELS.set, { enabled: 'yes', port: 'nope', pairingTokenEncrypted: 'sneaky' })
    expect(controller.apply).toHaveBeenCalledWith({})
  })

  it('regenerates the token and revokes a client', async () => {
    const { call, controller } = harness()
    await call(REMOTE_CHANNELS.regenerateToken)
    expect(controller.regenerateToken).toHaveBeenCalled()
    expect(call(REMOTE_CHANNELS.revokeClient, 'session-token')).toBe(true)
    expect(controller.revoke).toHaveBeenCalledWith('session-token')
  })

  it('lists bind options for the picker', () => {
    const { call } = harness()
    expect(call(REMOTE_CHANNELS.interfaces)).toEqual([
      { label: 'Tailscale', address: '100.64.0.1', tailscale: true }
    ])
  })
})
