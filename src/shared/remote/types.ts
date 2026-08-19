/**
 * Remote-access view types shared across the process boundary.
 *
 * Main produces them, the preload bridge relays them, and the settings
 * renderer draws them — one definition so a field added in the controller is a
 * compile error in the UI until it is handled.
 */

/** One bind option the settings picker offers. */
export interface BindOption {
  /** Human label for the picker. */
  label: string
  address: string
  /** True for the auto-detected Tailscale address — the recommended default. */
  tailscale: boolean
}

/** One live paired client, for the connected-clients list. */
export interface RemoteClientInfo {
  /** Public, non-secret handle for the revoke button — never the session token. */
  id: string
  remoteAddress: string
  createdAt: number
  lastSeenAt: number
}

/** The remote server's state as the settings window renders it. */
export interface RemoteStatus {
  enabled: boolean
  running: boolean
  /** The resolved bind address the server is (or would be) on. */
  address?: string
  /**
   * This machine's Tailscale IPv4, when a tailnet interface is up.
   * Independent of the chosen bind: the settings card uses it to show
   * "Tailscale is ready" before the user ever toggles remote access.
   */
  tailscaleAddress?: string
  port: number
  /** The full pairing URL for the QR — present only when a token exists. */
  pairingUrl?: string
  hasToken: boolean
  /** Set when enabling failed (no Tailscale detected, bind refused…). */
  error?: string
}
