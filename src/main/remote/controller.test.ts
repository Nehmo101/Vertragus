import { describe, expect, it, vi } from 'vitest'
import type { RemoteSettings } from '@main/store/settings'
import {
  createRemoteController,
  resolveBindAddress,
  type RemoteControllerDeps
} from './controller'
import type { NetworkInterfaces } from './interfaces'
import type { RemoteServerHandle } from './server'

const tailnet: NetworkInterfaces = {
  tailscale0: [{ address: '100.64.10.20', family: 'IPv4', internal: false }]
}
const noTailnet: NetworkInterfaces = {
  eth0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }]
}

const DEFAULTS: RemoteSettings = { enabled: false, bindAddress: '', port: 9482 }

describe('resolveBindAddress', () => {
  it('uses an explicit bind address as-is', () => {
    expect(resolveBindAddress({ ...DEFAULTS, bindAddress: '0.0.0.0' }, noTailnet)).toEqual({
      address: '0.0.0.0'
    })
  })

  it('auto-resolves to the Tailscale address', () => {
    expect(resolveBindAddress(DEFAULTS, tailnet)).toEqual({ address: '100.64.10.20' })
  })

  it('errors rather than silently binding wider when auto and no tailnet', () => {
    const result = resolveBindAddress(DEFAULTS, noTailnet)
    expect('error' in result).toBe(true)
  })
})

function memoryFallback(initial?: string) {
  let value = initial
  return {
    read: () => value,
    write: (token: string) => {
      value = token
    },
    clear: () => {
      value = undefined
    }
  }
}

function harness(initial: RemoteSettings = DEFAULTS, interfaces = tailnet) {
  let settings = { ...initial }
  const closes: number[] = []
  let closeCount = 0
  const fallback = memoryFallback()
  const fakeHandle = (host: string, port: number): RemoteServerHandle => ({
    host,
    port,
    clients: () => [{ id: 'client-1', remoteAddress: '100.64.0.9', createdAt: 1, lastSeenAt: 2 }],
    revoke: () => true,
    close: async () => {
      closes.push(++closeCount)
    }
  })
  const startServer = vi.fn(async (options: { host: string; port?: number }) =>
    fakeHandle(options.host, options.port ?? 9482)
  )
  const deps: RemoteControllerDeps = {
    readSettings: () => settings,
    writeSettings: (next) => {
      settings = { ...next }
    },
    networkInterfaces: () => interfaces,
    // A reversible "codec" is enough to prove the round trip.
    secrets: {
      available: true,
      encrypt: (plain) => `enc(${plain})`,
      decrypt: (cipher) => (cipher.startsWith('enc(') ? cipher.slice(4, -1) : undefined)
    },
    tokenFallback: fallback,
    staticRoot: '/out/remote',
    serverBase: {
      gateway: {
        listWorkspaces: () => [],
        listProfiles: () => [],
        startWorkspace: () => {},
        stopWorkspace: () => {},
        answerQuestion: () => {},
        userMessage: () => {}
      },
      terminals: () => ({ list: () => [], get: () => undefined, attach: () => undefined, write: () => false, resize: () => false }),
      onWorkspaceChange: () => () => {},
      locale: () => 'de',
      theme: () => 'dark'
    },
    startServer: startServer as unknown as RemoteControllerDeps['startServer']
  }
  return { deps, startServer, getSettings: () => settings, fallback }
}

describe('createRemoteController', () => {
  it('stays stopped and tokenless while disabled', () => {
    const { deps } = harness()
    const controller = createRemoteController(deps)
    const status = controller.status()
    expect(status).toMatchObject({
      enabled: false,
      running: false,
      hasToken: false,
      tailscaleAddress: '100.64.10.20'
    })
  })

  it('reports no tailscaleAddress when the machine is off the tailnet', () => {
    const { deps } = harness(DEFAULTS, noTailnet)
    expect(createRemoteController(deps).status().tailscaleAddress).toBeUndefined()
  })

  it('enabling starts the server, mints a token and yields a pairing URL', async () => {
    const { deps, startServer, getSettings } = harness()
    const controller = createRemoteController(deps)
    const status = await controller.apply({ enabled: true })

    expect(startServer).toHaveBeenCalledOnce()
    expect(status.running).toBe(true)
    expect(status.address).toBe('100.64.10.20')
    expect(status.tailscaleAddress).toBe('100.64.10.20')
    expect(status.hasToken).toBe(true)
    expect(status.pairingUrl).toMatch(/^http:\/\/100\.64\.10\.20:9482\/#token=/)
    // The token was persisted, encrypted.
    expect(getSettings().pairingTokenEncrypted).toMatch(/^enc\(/)
  })

  it('reuses the same pairing URL across a restart (new controller, same stores)', async () => {
    const { deps, getSettings } = harness()
    const first = createRemoteController(deps)
    const enabled = await first.apply({ enabled: true })
    expect(enabled.pairingUrl).toMatch(/#token=/)

    const second = createRemoteController(deps)
    const resumed = await second.apply({ enabled: true })
    expect(resumed.pairingUrl).toBe(enabled.pairingUrl)
    expect(getSettings().pairingTokenEncrypted).toMatch(/^enc\(/)
  })

  it('does not mint over ciphertext that the keychain cannot unlock', async () => {
    const { deps, getSettings } = harness({
      ...DEFAULTS,
      pairingTokenEncrypted: 'enc(original-token)'
    })
    deps.secrets = {
      available: true,
      encrypt: (plain) => `enc(${plain})`,
      decrypt: () => undefined
    }
    deps.tokenFallback = memoryFallback()
    const controller = createRemoteController(deps)
    const status = await controller.apply({ enabled: true })

    expect(status.pairingUrl).toBeUndefined()
    expect(status.error).toMatch(/entsperrt/)
    expect(getSettings().pairingTokenEncrypted).toBe('enc(original-token)')
  })

  it('uses the fallback file when the keychain cannot decrypt', async () => {
    const { deps } = harness({
      ...DEFAULTS,
      pairingTokenEncrypted: 'enc(old-token)'
    })
    deps.secrets = {
      available: true,
      encrypt: (plain) => `enc(${plain})`,
      decrypt: () => undefined
    }
    deps.tokenFallback = memoryFallback('fallback-token')
    const controller = createRemoteController(deps)
    const status = await controller.apply({ enabled: true })
    expect(status.pairingUrl).toContain('#token=fallback-token')
    expect(status.error).toBeUndefined()
  })

  it('reports an error instead of starting when auto-bind finds no tailnet', async () => {
    const { deps, startServer } = harness(DEFAULTS, noTailnet)
    const controller = createRemoteController(deps)
    const status = await controller.apply({ enabled: true })
    expect(startServer).not.toHaveBeenCalled()
    expect(status.running).toBe(false)
    expect(status.error).toMatch(/Tailscale/)
  })

  it('regenerating the token stops the running server and restarts it', async () => {
    const { deps, startServer, getSettings } = harness()
    const controller = createRemoteController(deps)
    await controller.apply({ enabled: true })
    const firstToken = getSettings().pairingTokenEncrypted

    await controller.regenerateToken()
    expect(getSettings().pairingTokenEncrypted).not.toBe(firstToken)
    // Started once for enable, once for the regenerate restart.
    expect(startServer).toHaveBeenCalledTimes(2)
  })

  it('disabling stops the server', async () => {
    const { deps } = harness()
    const controller = createRemoteController(deps)
    await controller.apply({ enabled: true })
    expect(controller.status().running).toBe(true)
    const status = await controller.apply({ enabled: false })
    expect(status.running).toBe(false)
  })

  it('keeps the token out of electron-store when no keychain is available', async () => {
    const { deps, getSettings, fallback } = harness()
    // No OS keychain: encrypt must never reach the settings JSON.
    deps.secrets = {
      available: false,
      encrypt: () => {
        throw new Error('encrypt must not be called without a keychain')
      },
      decrypt: () => undefined
    }
    const controller = createRemoteController(deps)
    const status = await controller.apply({ enabled: true })

    expect(status.hasToken).toBe(true)
    expect(status.pairingUrl).toMatch(/#token=/)
    expect(getSettings().pairingTokenEncrypted).toBeUndefined()
    expect(fallback.read()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('reuses the fallback-file token across a restart without a keychain', async () => {
    const { deps, fallback } = harness()
    deps.secrets = {
      available: false,
      encrypt: () => {
        throw new Error('encrypt must not be called without a keychain')
      },
      decrypt: () => undefined
    }
    const first = createRemoteController(deps)
    const enabled = await first.apply({ enabled: true })
    expect(fallback.read()).toBeTruthy()

    const second = createRemoteController(deps)
    const resumed = await second.apply({ enabled: true })
    expect(resumed.pairingUrl).toBe(enabled.pairingUrl)
  })
})
