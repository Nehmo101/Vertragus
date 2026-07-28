/**
 * Pure preset→capability mapping for the device-pairing UI in RemotePanel.
 * Kept free of React so the matrix can be unit-tested in isolation.
 */
import { REMOTE_CAPABILITIES, type RemoteCapability } from '@shared/remote'

export const REMOTE_PRESET_IDS = ['observe', 'approve', 'full'] as const
export type RemotePresetId = (typeof REMOTE_PRESET_IDS)[number]

/**
 * observe — watch only: status, diffs, push notifications.
 * approve — additionally grant approvals: speech, tool approvals, budget caps.
 * full    — every capability, including steer, admin, task control, replan and
 *           provider fallback (admin is deliberately exclusive to `full`).
 */
export const REMOTE_PRESET_CAPABILITIES: Record<RemotePresetId, readonly RemoteCapability[]> = {
  observe: ['read', 'diff', 'push'],
  approve: ['read', 'diff', 'push', 'speech', 'approve-tools', 'budget'],
  full: REMOTE_CAPABILITIES
}

/**
 * Maps a capability selection back to the preset it exactly matches
 * (order-insensitive); anything else is 'custom'.
 */
export function presetForCapabilities(
  capabilities: readonly RemoteCapability[]
): RemotePresetId | 'custom' {
  const selected = new Set(capabilities)
  for (const preset of REMOTE_PRESET_IDS) {
    const expected = REMOTE_PRESET_CAPABILITIES[preset]
    if (expected.length === selected.size && expected.every((cap) => selected.has(cap))) {
      return preset
    }
  }
  return 'custom'
}

/** Normalizes a selection to the canonical REMOTE_CAPABILITIES order. */
export function normalizeCapabilities(
  capabilities: Iterable<RemoteCapability>
): RemoteCapability[] {
  const selected = new Set(capabilities)
  return REMOTE_CAPABILITIES.filter((cap) => selected.has(cap))
}
