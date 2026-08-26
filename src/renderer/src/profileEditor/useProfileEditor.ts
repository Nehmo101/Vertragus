/**
 * State of the profile editor window.
 *
 * Three loads with different latencies are kept apart on purpose: profiles and
 * role templates come back instantly (they are files), while `providers:list`
 * probes every CLI's `--version` and model discovery shells out per provider.
 * Waiting for the slow ones before showing the form would make a folder rename
 * feel like a network request, so the form renders on the fast data and the
 * pickers fill in as their answers arrive.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { allRoleTemplates } from '@shared/prompts/roles'
import type { RoleTemplate } from '@shared/schema/profile'
import type { ModelDiscoveryResult, ProviderListEntry, VertragusAppApi } from '../../../preload'
import { errorText } from '../lib/ipcError'
import {
  draftFromProfile,
  emptyDraft,
  resetInvalidEfforts,
  validateDraft,
  type DraftErrors,
  type ProfileDraft
} from './model'

/** The preset that always exists — the default orchestrator of a new profile. */
const FALLBACK_PROVIDER_ID = 'claude'

export interface ProfileEditorState {
  bridge: VertragusAppApi | undefined
  draft: ProfileDraft | null
  /** Set when the editor cannot work at all (unknown profile, no bridge). */
  fatal: string | null
  errors: DraftErrors
  providers: ProviderListEntry[]
  providersLoading: boolean
  roles: RoleTemplate[]
  models: Record<string, ModelDiscoveryResult>
  /** Provider ids whose model discovery is currently running. */
  modelsLoading: Record<string, boolean>
  saving: boolean
  /** True for a profile that has not been saved once. */
  isNew: boolean
  update(mutate: (draft: ProfileDraft) => ProfileDraft): void
  save(): void
  cancel(): void
  remove(): void
  exportSaved(): void
  pickFolder(): void
  /** Re-run discovery for one provider, ignoring what was already fetched. */
  reloadModels(providerId: string): void
  saveCustomRole(template: RoleTemplate): Promise<RoleTemplate | null>
}

export function useProfileEditor(
  profileId?: string,
  /**
   * WP-7: which provider a NEW profile's orchestrator starts on. The first-run
   * card passes the CLI whose health probe actually answered, so the form does
   * not open defaulted to a provider that is not installed on this machine.
   */
  providerHint?: string
): ProfileEditorState {
  const { t } = useTranslation()
  const bridge = useMemo(() => window.vertragus?.app, [])
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [fatal, setFatal] = useState<string | null>(bridge ? null : t('common.bridgeMissing'))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [providers, setProviders] = useState<ProviderListEntry[]>([])
  const [providersLoading, setProvidersLoading] = useState(true)
  const [roles, setRoles] = useState<RoleTemplate[]>(allRoleTemplates())
  const [models, setModels] = useState<Record<string, ModelDiscoveryResult>>({})
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const isNew = !profileId

  // --- fast load: the profile itself and the role templates ---------------
  useEffect(() => {
    if (!bridge) return
    let alive = true
    Promise.all([bridge.listProfiles(), bridge.listRoles()]).then(
      ([profiles, custom]) => {
        if (!alive) return
        setRoles(allRoleTemplates(custom))
        if (!profileId) {
          setDraft(emptyDraft(providerHint?.trim() || FALLBACK_PROVIDER_ID))
          return
        }
        const profile = profiles.find((entry) => entry.id === profileId)
        if (!profile) setFatal(t('profileEditor.unknownProfile'))
        else setDraft(draftFromProfile(profile))
      },
      (cause) => {
        if (alive) setFatal(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, profileId, providerHint, t])

  // Zones are saved by the overlay, not by this form. When that write lands,
  // fold the fresh layout into the draft so a later "Save" cannot ship a stale
  // snapshot that omits (or regresses) the rectangles the user just drew.
  useEffect(() => {
    if (!bridge || !profileId) return undefined
    return bridge.onProfiles((profiles) => {
      const profile = profiles.find((entry) => entry.id === profileId)
      if (!profile) return
      setDraft((current) =>
        current ? { ...current, zones: profile.zones } : current
      )
    })
  }, [bridge, profileId])

  // --- slow load: provider list with health -------------------------------
  useEffect(() => {
    if (!bridge) return
    let alive = true
    const load = (): void => {
      bridge.listProviders().then(
        (entries) => {
          if (!alive) return
          setProviders(entries)
          setProvidersLoading(false)
        },
        (cause) => {
          if (!alive) return
          setProvidersLoading(false)
          setErrors((current) => ({ ...current, form: errorText(cause) }))
        }
      )
    }
    load()
    // A provider created from THIS window's "+ Eigener Provider …" entry has to
    // show up in the very dropdown it was created from; re-listing (instead of
    // taking the pushed configs) is what also refreshes its health probe.
    const off = bridge.onProviders?.(() => load())
    return () => {
      alive = false
      off?.()
    }
  }, [bridge])

  // --- lazy load: one model catalogue per provider actually in use --------
  const requested = useRef(new Set<string>())

  /**
   * Every provider the draft points at — the orchestrator AND every slot.
   * Recomputed from the draft, so switching a single slot to a provider nobody
   * used yet triggers that provider's discovery; a provider that is already
   * loaded is never fetched twice.
   */
  const providerIdsInUse = useMemo(() => {
    if (!draft) return [] as string[]
    return [
      ...new Set(
        [draft.orchestrator.providerId, ...draft.slots.map((slot) => slot.providerId)].filter(
          Boolean
        )
      )
    ]
  }, [draft])

  const loadModels = useCallback(
    (providerId: string, force = false) => {
      if (!bridge || !providerId) return
      if (!force && requested.current.has(providerId)) return
      requested.current.add(providerId)
      setModelsLoading((current) => ({ ...current, [providerId]: true }))
      bridge.discoverModels(providerId).then(
        (result) => {
          setModels((current) => ({ ...current, [providerId]: result }))
          setModelsLoading((current) => ({ ...current, [providerId]: false }))
        },
        (cause) => {
          // A provider without a catalogue is normal (CLI missing, not logged
          // in): the combo stays free text — but it says so instead of looking
          // like a field that simply refuses to open.
          requested.current.delete(providerId)
          setModels((current) => ({
            ...current,
            [providerId]: {
              models: [],
              source: 'none',
              refreshedAt: Date.now(),
              detail: errorText(cause)
            }
          }))
          setModelsLoading((current) => ({ ...current, [providerId]: false }))
        }
      )
    },
    [bridge]
  )

  useEffect(() => {
    for (const providerId of providerIdsInUse) loadModels(providerId)
  }, [loadModels, providerIdsInUse])

  useEffect(() => {
    setDraft((current) =>
      current
        ? resetInvalidEfforts(current, providers, models, modelsLoading, providersLoading)
        : current
    )
  }, [providers, models, modelsLoading, providersLoading])

  const update = useCallback((mutate: (current: ProfileDraft) => ProfileDraft) => {
    setDraft((current) => (current ? mutate(current) : current))
  }, [])

  const save = useCallback(() => {
    if (!bridge || !draft) return
    const result = validateDraft(t, draft)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    setSaving(true)
    bridge.saveProfile(result.profile).then(
      () => bridge.closeProfileEditor(),
      (cause) => {
        setSaving(false)
        setErrors({ form: errorText(cause) })
      }
    )
  }, [bridge, draft, t])

  const cancel = useCallback(() => bridge?.closeProfileEditor(), [bridge])

  const remove = useCallback(() => {
    if (!bridge || !draft || isNew) return
    if (!window.confirm(t('profileEditor.deleteConfirm', { name: draft.name || draft.id })))
      return
    setSaving(true)
    bridge.deleteProfile(draft.id).then(
      () => bridge.closeProfileEditor(),
      (cause) => {
        setSaving(false)
        setErrors({ form: errorText(cause) })
      }
    )
  }, [bridge, draft, isNew, t])

  const exportSaved = useCallback(() => {
    if (!bridge || !draft || isNew) return
    bridge.exportProfile(draft.id).then(
      () => undefined,
      (cause) => setErrors({ form: errorText(cause) })
    )
  }, [bridge, draft, isNew])

  const pickFolder = useCallback(() => {
    if (!bridge || !draft) return
    bridge.pickDirectory(draft.repoPath || undefined).then(
      (path) => {
        if (path) update((current) => ({ ...current, repoPath: path }))
      },
      (cause) => setErrors((current) => ({ ...current, repoPath: errorText(cause) }))
    )
  }, [bridge, draft, update])

  const reloadModels = useCallback(
    (providerId: string) => loadModels(providerId, true),
    [loadModels]
  )

  const saveCustomRole = useCallback(
    async (template: RoleTemplate): Promise<RoleTemplate | null> => {
      if (!bridge) return null
      try {
        const custom = await bridge.saveRole(template)
        setRoles(allRoleTemplates(custom))
        return template
      } catch (cause) {
        setErrors((current) => ({ ...current, form: errorText(cause) }))
        return null
      }
    },
    [bridge]
  )

  return {
    bridge,
    draft,
    fatal,
    errors,
    providers,
    providersLoading,
    roles,
    models,
    modelsLoading,
    saving,
    isNew,
    update,
    save,
    cancel,
    remove,
    exportSaved,
    pickFolder,
    reloadModels,
    saveCustomRole
  }
}
