/** Provider health, model catalogue and provider/model gating. */
import type { StateCreator } from 'zustand'
import {
  DEFAULT_DISABLED_MODELS,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_ENABLED,
  DEFAULT_PROVIDER_LIMITS,
  normalizeDisabledModels,
  normalizeProviderEnabled,
  normalizeProviderLimits
} from '@shared/providers'
import { normalizeModelCatalog } from '@renderer/modelCatalog'
import { errorMessage } from '../useAppStore'
import type { AppState, ProvidersSlice } from './types'

let modelRefreshSequence = 0

export const createProvidersSlice: StateCreator<AppState, [], [], ProvidersSlice> = (set, get) => ({
  health: [],
  models: normalizeModelCatalog(DEFAULT_MODELS),
  providerLimits: DEFAULT_PROVIDER_LIMITS,
  providerEnabled: DEFAULT_PROVIDER_ENABLED,
  disabledModels: DEFAULT_DISABLED_MODELS,

  async refreshHealth() {
    try {
      const health = await window.vertragus.checkProviders()
      set({ health })
      if (health.some((provider) => provider.id === 'github')) void get().refreshGithubAuth()
    } finally {
      // The sidebar refresh is also an explicit refresh of model suggestions.
      await get().refreshModels()
    }
  },

  async refreshModels() {
    const sequence = ++modelRefreshSequence
    try {
      const models = await window.vertragus.listModels()
      if (sequence !== modelRefreshSequence) return
      set({ models: normalizeModelCatalog(models) })
    } catch {
      // Never retain another account's last live catalogue after logout or a
      // failed refresh. Fall back to explicitly unverified local suggestions.
      if (sequence === modelRefreshSequence) set({ models: normalizeModelCatalog(DEFAULT_MODELS) })
    }
  },

  async loginProvider(id) {
    const provider = get().health.find((item) => item.id === id)
    if (!provider?.available || !provider.canLogin) return
    try {
      await window.vertragus.loginProvider(id)
      // The completion event triggers a second reload after the CLI closes.
      void get().refreshModels()
      get().showToast(`${provider.loginLabel ?? 'Provider-Login'} im sicheren Terminal geöffnet.`)
    } catch (error) {
      get().showToast(`Login konnte nicht gestartet werden: ${errorMessage(error)}`)
    }
  },

  setProviderLimit(provider, value) {
    const providerLimits = normalizeProviderLimits({ ...get().providerLimits, [provider]: value })
    set({ providerLimits })
    void window.vertragus.setConfig('providerLimits', providerLimits)
  },

  setProviderEnabled(provider, enabled) {
    const providerEnabled = normalizeProviderEnabled({
      ...get().providerEnabled,
      [provider]: enabled
    })
    set({ providerEnabled })
    void window.vertragus.setConfig('providerEnabled', providerEnabled)
  },

  setModelEnabled(provider, model, enabled) {
    const normalized = model.trim()
    if (!normalized) return
    const current = get().disabledModels[provider]
    const disabled = enabled
      ? current.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase())
      : [...current.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase()), normalized]
    const disabledModels = normalizeDisabledModels({
      ...get().disabledModels,
      [provider]: disabled
    })
    set({ disabledModels })
    void window.vertragus.setConfig('disabledModels', disabledModels)
  }
})
