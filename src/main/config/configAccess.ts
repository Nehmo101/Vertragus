/**
 * Guard generic configGet/configSet IPC — only public UI keys; never secrets.*.
 */
import { getSetting, setSetting } from '@main/config/store'
import {
  parseDisabledModels,
  parseProviderEnabled,
  parseProviderLimits
} from '@shared/providers'

/** Keys the renderer may read via config:get. */
export const PUBLIC_CONFIG_GET_KEYS = new Set([
  'yoloMaster',
  'ui.theme',
  'ui.workspaceLayout',
  'ui.density',
  'providerLimits',
  'providerEnabled',
  'disabledModels'
])

/** Keys the renderer may write via config:set. */
export const PUBLIC_CONFIG_SET_KEYS = new Set([
  'yoloMaster',
  'ui.theme',
  'ui.workspaceLayout',
  'ui.density',
  'providerLimits',
  'providerEnabled',
  'disabledModels'
])

function rejectSecretsKey(key: string, action: 'read' | 'write'): void {
  if (key.startsWith('secrets.')) {
    const verb = action === 'read' ? 'lesen' : 'schreiben'
    throw new Error(`Config-Schlüssel "${key}" darf nicht per IPC ${verb} werden.`)
  }
}

export function assertConfigGetAllowed(key: string): void {
  rejectSecretsKey(key, 'read')
  if (!PUBLIC_CONFIG_GET_KEYS.has(key)) {
    throw new Error(`Config-Schlüssel "${key}" ist nicht über IPC lesbar.`)
  }
}

export function assertConfigSetAllowed(key: string): void {
  rejectSecretsKey(key, 'write')
  if (!PUBLIC_CONFIG_SET_KEYS.has(key)) {
    throw new Error(`Config-Schlüssel "${key}" ist nicht über IPC schreibbar.`)
  }
}

export function getPublicConfig<T = unknown>(key: string): T | undefined {
  assertConfigGetAllowed(key)
  return getSetting<T>(key)
}

export function setPublicConfig(key: string, value: unknown): void {
  assertConfigSetAllowed(key)
  if (key === 'providerLimits') {
    setSetting(key, parseProviderLimits(value))
    return
  }
  if (key === 'providerEnabled') {
    setSetting(key, parseProviderEnabled(value))
    return
  }
  if (key === 'disabledModels') {
    setSetting(key, parseDisabledModels(value))
    return
  }
  setSetting(key, value)
}
