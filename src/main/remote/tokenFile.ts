/**
 * Restart-safe pairing-token persistence when the OS keychain is missing.
 *
 * electron-store is plaintext JSON, so the controller refuses to put the
 * pairing secret there. Without a keychain it used to live only in RAM —
 * every app restart minted a new token and the Tailscale QR changed.
 *
 * This file is the escape hatch: a dedicated path under userData, mode 0600
 * (best-effort on Windows). It is not a substitute for safeStorage when the
 * keyring works; it is the thing that keeps the pairing URL stable when it
 * does not. Regenerating the token overwrites or deletes it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface PairingTokenFallback {
  read(): string | undefined
  write(token: string): void
  clear(): void
}

export function createPairingTokenFile(filePath: string): PairingTokenFallback {
  return {
    read() {
      try {
        if (!existsSync(filePath)) return undefined
        const value = readFileSync(filePath, 'utf8').trim()
        return value.length > 0 ? value : undefined
      } catch {
        return undefined
      }
    },
    write(token: string) {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(filePath, 0o600)
      } catch {
        /* Windows cannot honour POSIX modes; the ACL of userData still applies. */
      }
    },
    clear() {
      try {
        unlinkSync(filePath)
      } catch {
        /* Missing is the cleared state. */
      }
    }
  }
}
