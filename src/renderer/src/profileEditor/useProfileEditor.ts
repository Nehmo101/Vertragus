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
import { allRoleTemplates } from '@shared/prompts/roles'
import type { RoleTemplate } from '@shared/schema/profile'
import type { ModelDiscoveryResult, ProviderListEntry, VertragusAppApi } from '../../../preload'
import { errorText } from '../lib/ipcError'
import {
  draftFromProfile,
  emptyDraft,
  validateDraft,
  type DraftErrors,
  type ProfileDraft
} from './model'
import { EDITOR_STRINGS } from './strings'

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
  saving: boolean
  /** True for a profile that has not been saved once. */
  isNew: boolean
  update(mutate: (draft: ProfileDraft) => ProfileDraft): void
  save(): void
  cancel(): void
  remove(): void
  pickFolder(): void
  saveCustomRole(template: RoleTemplate): Promise<RoleTemplate | null>
}

export function useProfileEditor(profileId?: string): ProfileEditorState {
  const bridge = useMemo(() => window.vertragus?.app, [])
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [fatal, setFatal] = useState<string | null>(bridge ? null : EDITOR_STRINGS.bridgeMissing)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [providers, setProviders] = useState<ProviderListEntry[]>([])
  const [providersLoading, setProvidersLoading] = useState(true)
  const [roles, setRoles] = useState<RoleTemplate[]>(allRoleTemplates())
  const [models, setModels] = useState<Record<string, ModelDiscoveryResult>>({})
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
          setDraft(emptyDraft(FALLBACK_PROVIDER_ID))
          return
        }
        const profile = profiles.find((entry) => entry.id === profileId)
        if (!profile) setFatal(EDITOR_STRINGS.unknownProfile)
        else setDraft(draftFromProfile(profile))
      },
      (cause) => {
        if (alive) setFatal(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, profileId])

  // --- slow load: provider list with health -------------------------------
  useEffect(() => {
    if (!bridge) return
    let alive = true
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
    return () => {
      alive = false
    }
  }, [bridge])

  // --- lazy load: one model catalogue per provider actually in use --------
  const requested = useRef(new Set<string>())
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

  useEffect(() => {
    if (!bridge) return
    for (const providerId of providerIdsInUse) {
      if (requested.current.has(providerId)) continue
      requested.current.add(providerId)
      bridge.discoverModels(providerId).then(
        (result) => setModels((current) => ({ ...current, [providerId]: result })),
        () => {
          // A provider without a catalogue is normal (Cursor offline, no CLI):
          // the combo stays free text, which is always allowed.
          requested.current.delete(providerId)
        }
      )
    }
  }, [bridge, providerIdsInUse])

  const update = useCallback((mutate: (current: ProfileDraft) => ProfileDraft) => {
    setDraft((current) => (current ? mutate(current) : current))
  }, [])

  const save = useCallback(() => {
    if (!bridge || !draft) return
    const result = validateDraft(draft)
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
  }, [bridge, draft])

  const cancel = useCallback(() => bridge?.closeProfileEditor(), [bridge])

  const remove = useCallback(() => {
    if (!bridge || !draft || isNew) return
    if (!window.confirm(EDITOR_STRINGS.deleteConfirm(draft.name || draft.id))) return
    setSaving(true)
    bridge.deleteProfile(draft.id).then(
      () => bridge.closeProfileEditor(),
      (cause) => {
        setSaving(false)
        setErrors({ form: errorText(cause) })
      }
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
    saving,
    isNew,
    update,
    save,
    cancel,
    remove,
    pickFolder,
    saveCustomRole
  }
}
