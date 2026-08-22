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
import { mainMessages } from '@shared/mainMessages'
import type { RemoteStatus } from '@shared/remote/types'
import { detectTailscaleAddress, type NetworkInterfaces } from './interfaces'
import { mintPairingToken, pairingUrl } from './pairing'
import { startRemoteServer, type RemoteServerHandle, type RemoteServerOptions } from './server'
import type { PairingTokenFallback } from './tokenFile'

export type { RemoteStatus } from '@shared/remote/types'

export interface RemoteSecretCodec {
  /** True only when the OS keychain is available (Electron safeStorage). */
  available: boolean
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string | undefined
}

export interface RemoteControllerDeps {
  readSettings: () => RemoteSettings
  writeSettings: (next: RemoteSettings) => void
  networkInterfaces: () => NetworkInterfaces
  secrets: RemoteSecretCodec
  staticRoot: string
  /**
   * Restart-safe token store used when the OS keychain cannot wrap the secret
   * (or as a backup if decrypt fails). Must not be electron-store — that file
   * is plaintext JSON. Production injects a 0600 file under userData.
   */
  tokenFallback?: PairingTokenFallback
  /** Everything the server needs that is not remote-config: gateway, terminals… */
  serverBase: Omit<RemoteServerOptions, 'host' | 'port' | 'pairingToken' | 'staticRoot'>
  startServer?: typeof startRemoteServer
  /**
   * Stored UI locale for the error strings the settings window shows; absent
   * (tests) falls back to the schema default via `mainMessages`.
   */
  locale?(): string | undefined
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
  interfaces: NetworkInterfaces,
  locale?: string
): { address: string } | { error: string } {
  if (settings.bindAddress) return { address: settings.bindAddress }
  const tailscale = detectTailscaleAddress(interfaces)
  if (tailscale) return { address: tailscale }
  return { error: mainMessages(locale).remoteNoTailscale }
}

export function createRemoteController(deps: RemoteControllerDeps): RemoteController {
  const startServer = deps.startServer ?? startRemoteServer
  let handle: RemoteServerHandle | undefined
  let lastError: string | undefined
  /**
   * Process-local cache. Persistence is encrypted settings and/or the
   * injected fallback file — never a new mint on every boot.
   */
  let memoryToken: string | undefined

  const ciphertext = (): string | undefined => deps.readSettings().pairingTokenEncrypted

  const token = (): string | undefined => {
    if (memoryToken) return memoryToken
    const stored = ciphertext()
    if (stored) {
      const decrypted = deps.secrets.decrypt(stored)
      if (decrypted) {
        memoryToken = decrypted
        return decrypted
      }
    }
    const fallback = deps.tokenFallback?.read()
    if (fallback) {
      memoryToken = fallback
      return fallback
    }
    return undefined
  }

  /**
   * Write the pairing token so a restart shows the same QR. Encrypted in the
   * settings file when the keychain works; always also the fallback file when
   * one is injected, so a locked keyring cannot silently rotate the link.
   */
  const persistToken = (settings: RemoteSettings, fresh: string): void => {
    memoryToken = fresh
    if (deps.secrets.available) {
      deps.writeSettings({ ...settings, pairingTokenEncrypted: deps.secrets.encrypt(fresh) })
    } else if (settings.pairingTokenEncrypted) {
      deps.writeSettings({ ...settings, pairingTokenEncrypted: undefined })
    }
    deps.tokenFallback?.write(fresh)
  }

  /** If we recovered the token from the file, wrap it in the keychain too. */
  const migrateFallbackToKeychain = (settings: RemoteSettings, current: string): void => {
    if (!deps.secrets.available) return
    const stored = settings.pairingTokenEncrypted
    const decrypted = stored ? deps.secrets.decrypt(stored) : undefined
    if (decrypted === current) return
    deps.writeSettings({ ...settings, pairingTokenEncrypted: deps.secrets.encrypt(current) })
  }

  const status = (): RemoteStatus => {
    const settings = deps.readSettings()
    const current = token()
    const address = handle?.host ?? bindPreview(settings)
    const tailscaleAddress = detectTailscaleAddress(deps.networkInterfaces())
    return {
      enabled: settings.enabled,
      running: handle !== undefined,
      ...(address ? { address } : {}),
      ...(tailscaleAddress ? { tailscaleAddress } : {}),
      port: handle?.port ?? settings.port,
      hasToken: current !== undefined,
      ...(current && address
        ? { pairingUrl: pairingUrl(address, handle?.port ?? settings.port, current) }
        : {}),
      ...(lastError ? { error: lastError } : {})
    }
  }

  const bindPreview = (settings: RemoteSettings): string | undefined => {
    const resolved = resolveBindAddress(settings, deps.networkInterfaces(), deps.locale?.())
    return 'address' in resolved ? resolved.address : undefined
  }

  const stop = async (): Promise<void> => {
    if (!handle) return
    await handle.close()
    handle = undefined
  }

  const start = async (settings: RemoteSettings): Promise<void> => {
    lastError = undefined
    const resolved = resolveBindAddress(settings, deps.networkInterfaces(), deps.locale?.())
    if ('error' in resolved) {
      lastError = resolved.error
      return
    }
    const current = token()
    if (!current) {
      // A locked ciphertext without a fallback must not be overwritten — that
      // is how the QR used to change on every restart. First enable (nothing
      // stored) still mints.
      if (ciphertext()) {
        lastError = mainMessages(deps.locale?.()).remoteTokenLocked
      } else {
        persistToken(settings, mintPairingToken())
      }
    } else {
      // Keep the 0600 file in sync so a later keychain lock cannot rotate
      // the QR. Also wrap a file-recovered token in the keychain when it works.
      deps.tokenFallback?.write(current)
      migrateFallbackToKeychain(deps.readSettings(), current)
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
      persistToken(settings, mintPairingToken())
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
