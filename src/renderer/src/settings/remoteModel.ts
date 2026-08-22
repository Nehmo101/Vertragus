/**
 * Pure view of the remote-access bind picker.
 *
 * The settings card has to answer "is Tailscale here?" before anyone toggles
 * the server: the controller only errors on enable, and a `<select>` whose
 * stored value is the empty auto-bind shows the first LAN option as if it
 * were selected. This module injects a Tailscale row in that case, picks the
 * honest selected value, and formats labels so the main-process strings
 * (always German) never leak into an English window.
 */
import type { BindOption, RemoteStatus } from '@shared/remote/types'
import type { Translate } from '../i18n'

/** Empty bind = "auto: the Tailscale address" in the settings store. */
export const TAILSCALE_AUTO_BIND = ''

export const ALL_INTERFACES = '0.0.0.0'

/** Official installer; the navigation guard opens https in the system browser. */
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

/**
 * How often the settings card re-reads interfaces while it is open.
 * Starting Tailscale after opening the window should flip the status
 * without a close/reopen.
 */
export const REMOTE_INTERFACE_POLL_MS = 2_500

export function missingTailscaleOption(): BindOption {
  return { label: 'Tailscale', address: TAILSCALE_AUTO_BIND, tailscale: true }
}

/**
 * Bind options as the picker renders them: Tailscale always first, even when
 * the interface is missing — otherwise the recommended transport disappears
 * and the LAN address looks like the default.
 */
export function remotePickerOptions(interfaces: readonly BindOption[]): BindOption[] {
  if (interfaces.some((option) => option.tailscale && option.address)) {
    return [...interfaces]
  }
  return [missingTailscaleOption(), ...interfaces]
}

export function detectedTailscaleAddress(
  status: Pick<RemoteStatus, 'tailscaleAddress'>,
  options: readonly BindOption[]
): string | undefined {
  if (status.tailscaleAddress) return status.tailscaleAddress
  return options.find((option) => option.tailscale && option.address)?.address
}

/**
 * The `<select>` value that matches what is actually stored / resolved.
 * Prefers a concrete bound address, then a live Tailscale IP, then the
 * missing-Tailscale placeholder — never a silent fall-through to LAN.
 */
export function selectedBindAddress(
  status: Pick<RemoteStatus, 'address' | 'tailscaleAddress'>,
  options: readonly BindOption[]
): string {
  const addresses = new Set(options.map((option) => option.address))
  if (status.address && addresses.has(status.address)) return status.address
  if (status.tailscaleAddress && addresses.has(status.tailscaleAddress)) {
    return status.tailscaleAddress
  }
  if (addresses.has(TAILSCALE_AUTO_BIND)) return TAILSCALE_AUTO_BIND
  return options[0]?.address ?? TAILSCALE_AUTO_BIND
}

export function isAllInterfaces(address: string): boolean {
  return address === ALL_INTERFACES
}

/** True when the picker is sitting on the "Tailscale — not found" row. */
export function isMissingTailscaleBind(
  address: string,
  options: readonly BindOption[]
): boolean {
  const selected = options.find((option) => option.address === address)
  return Boolean(selected?.tailscale && selected.address === TAILSCALE_AUTO_BIND)
}

export function bindOptionLabel(option: BindOption, t: Translate): string {
  if (option.address === ALL_INTERFACES) return t('settings.remoteBindAll')
  if (option.tailscale) {
    if (!option.address) return t('settings.remoteBindTailscaleMissing')
    return t('settings.remoteBindTailscale', { address: option.address })
  }
  return t('settings.remoteBindLan', { address: option.address })
}
