import { describe, expect, it, vi } from 'vitest'
import { BrowserBridge } from '@main/mcp/browserBridge'
import {
  BROWSER_EXTENSION_CHANNELS,
  registerBrowserExtensionIpc,
  type BrowserExtensionIpcDeps
} from './ipc'

class FakeIpc {
  readonly handlers = new Map<string, (...args: never[]) => unknown>()
  handle(channel: string, listener: (...args: never[]) => unknown): void {
    this.handlers.set(channel, listener)
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
}

function harness(settingsId = 7): {
  ipc: FakeIpc
  bridge: BrowserBridge
  broadcasts: Array<{ channel: string; payload: unknown }>
  call: (channel: string, senderId?: number) => unknown
} {
  const ipc = new FakeIpc()
  const bridge = new BrowserBridge({ token: 'b'.repeat(32) })
  bridge.port = 5123
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  registerBrowserExtensionIpc({
    ipcMain: ipc as unknown as BrowserExtensionIpcDeps['ipcMain'],
    bridge: () => bridge,
    extensionPath: () => '/repo/extensions/chromium',
    reveal: async () => '',
    isSettingsSender: (id) => id === settingsId,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload })
  })
  const call = (channel: string, senderId = settingsId): unknown => {
    const handler = ipc.handlers.get(channel)
    if (!handler) throw new Error(`no handler ${channel}`)
    return handler({ sender: { id: senderId } } as never)
  }
  return { ipc, bridge, broadcasts, call }
}

describe('browser extension IPC', () => {
  it('refuses non-settings senders', () => {
    const { call } = harness()
    expect(() => call(BROWSER_EXTENSION_CHANNELS.get, 99)).toThrow(/not available/)
  })

  it('returns pairing status and rotates the token', async () => {
    const { call, bridge, broadcasts } = harness()
    const first = (await call(BROWSER_EXTENSION_CHANNELS.get)) as { token: string; pairingUrl: string }
    expect(first.token).toBe(bridge.status().token)
    expect(first.pairingUrl).toContain('/browser?token=')
    expect(first.pairingUrl).toContain('127.0.0.1')

    const rotated = (await call(BROWSER_EXTENSION_CHANNELS.regenerate)) as { token: string }
    expect(rotated.token).not.toBe(first.token)
    expect(broadcasts.at(-1)?.channel).toBe(BROWSER_EXTENSION_CHANNELS.event)
  })

  it('reveals the extension folder and surfaces OS errors', async () => {
    const ipc = new FakeIpc()
    const reveal = vi.fn(async () => '')
    registerBrowserExtensionIpc({
      ipcMain: ipc as unknown as BrowserExtensionIpcDeps['ipcMain'],
      bridge: () => undefined,
      extensionPath: () => '/ext',
      reveal,
      isSettingsSender: () => true,
      broadcast: () => undefined
    })
    const handler = ipc.handlers.get(BROWSER_EXTENSION_CHANNELS.reveal)!
    await expect(handler({ sender: { id: 1 } } as never)).resolves.toBe(true)
    expect(reveal).toHaveBeenCalledWith('/ext')
  })
})
