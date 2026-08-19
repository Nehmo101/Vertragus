/**
 * The lifecycle glue between the `remote` setting and the actual server.
 *
 * It owns the running {@link RemoteServerHandle} (at most one), starts and
 * stops it as the setting flips, resolves the bind address (auto = the
 * detected Tailscale IP), and encrypts the pairing token at rest. Kept apart
 * from `server.ts` so the server stays a pure, testable HTTP/WS module and all
 * the Electron-flavoured concerns (safeStorage, settings, interface
 * enumeration) live here, injected.
 */
import type { RemoteSettings } from '@main/store/settings'
import type { RemoteStatus } from '@shared/remote/types'
import { detectTailscaleAddress, type NetworkInterfaces } from './interfaces'
import { mintPairingToken, pairingUrl } from './pairing'
import { startRemoteServer, type RemoteServerHandle, type RemoteServerOptions } from './server'

export type { RemoteStatus } from '@shared/remote/types'

export interface RemoteSecretCodec {
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string | undefined
}

export interface RemoteControllerDeps {
  readSettings: () => RemoteSettings
  writeSettings: (next: RemoteSettings) => void
  networkInterfaces: () => NetworkInterfaces
  secrets: RemoteSecretCodec
  staticRoot: string
  /** Everything the server needs that is not remote-config: gateway, terminals… */
  serverBase: Omit<
    RemoteServerOptions,
    'host' | 'port' | 'pairingToken' | 'staticRoot'
  >
  startServer?: typeof startRemoteServer
}

export interface RemoteController {
  status(): RemoteStatus
  clients(): ReturnType<RemoteServerHandle['clients']>
  /** Apply an enabled/bind/port change and (re)start or stop accordingly. */
  apply(next: Partial<RemoteSettings>): Promise<RemoteStatus>
  regenerateToken(): Promise<RemoteStatus>
  revoke(token: string): boolean
  stop(): Promise<void>
}

/**
 * Resolve the concrete bind address: an explicit one wins; '' means "the
 * Tailscale address", and its absence is a hard error rather than a silent
 * fallback to a wider interface.
 */
export function resolveBindAddress(
  settings: RemoteSettings,
  interfaces: NetworkInterfaces
): { address: string } | { error: string } {
  if (settings.bindAddress) return { address: settings.bindAddress }
  const tailscale = detectTailscaleAddress(interfaces)
  if (tailscale) return { address: tailscale }
  return {
    error:
      'Keine Tailscale-Adresse gefunden. Starte Tailscale, oder wähle in den Einstellungen eine andere Bind-Adresse.'
  }
}

export function createRemoteController(deps: RemoteControllerDeps): RemoteController {
  const startServer = deps.startServer ?? startRemoteServer
  let handle: RemoteServerHandle | undefined
  let lastError: string | undefined

  const token = (): string | undefined => {
    const stored = deps.readSettings().pairingTokenEncrypted
    return stored ? deps.secrets.decrypt(stored) : undefined
  }

  const status = (): RemoteStatus => {
    const settings = deps.readSettings()
    const current = token()
    const address = handle?.host ?? bindPreview(settings)
    return {
      enabled: settings.enabled,
      running: handle !== undefined,
      ...(address ? { address } : {}),
      port: handle?.port ?? settings.port,
      hasToken: current !== undefined,
      ...(current && address
        ? { pairingUrl: pairingUrl(address, handle?.port ?? settings.port, current) }
        : {}),
      ...(lastError ? { error: lastError } : {})
    }
  }

  const bindPreview = (settings: RemoteSettings): string | undefined => {
    const resolved = resolveBindAddress(settings, deps.networkInterfaces())
    return 'address' in resolved ? resolved.address : undefined
  }

  const stop = async (): Promise<void> => {
    if (!handle) return
    await handle.close()
    handle = undefined
  }

  const start = async (settings: RemoteSettings): Promise<void> => {
    lastError = undefined
    const resolved = resolveBindAddress(settings, deps.networkInterfaces())
    if ('error' in resolved) {
      lastError = resolved.error
      return
    }
    // A first enable with no token yet mints one, so the QR is never empty.
    let current = token()
    if (!current) {
      current = mintPairingToken()
      deps.writeSettings({
        ...settings,
        pairingTokenEncrypted: deps.secrets.encrypt(current)
      })
    }
    try {
      handle = await startServer({
        ...deps.serverBase,
        host: resolved.address,
        port: settings.port,
        staticRoot: deps.staticRoot,
        pairingToken: token
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    status,
    clients: () => handle?.clients() ?? [],
    async apply(next): Promise<RemoteStatus> {
      const merged: RemoteSettings = { ...deps.readSettings(), ...next }
      deps.writeSettings(merged)
      await stop()
      if (merged.enabled) await start(merged)
      return status()
    },
    async regenerateToken(): Promise<RemoteStatus> {
      const settings = deps.readSettings()
      const fresh = mintPairingToken()
      deps.writeSettings({ ...settings, pairingTokenEncrypted: deps.secrets.encrypt(fresh) })
      // Every existing session dies with the old token — a regenerate is a
      // "lock everyone out and re-pair" action.
      await stop()
      if (settings.enabled) await start(deps.readSettings())
      return status()
    },
    revoke: (token) => handle?.revoke(token) ?? false,
    stop
  }
}
