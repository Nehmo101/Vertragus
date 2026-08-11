/**
 * State of the provider editor window.
 *
 * Simpler than the profile editor's hook because there is only one load: the
 * effective provider list, which is also what tells us whether this id is a
 * preset (and therefore resettable) and which ids are already taken.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderConfig } from '@shared/schema/provider'
import type { ProviderListEntry, VertragusAppApi } from '../../../preload'
import { errorText } from '../lib/ipcError'
import {
  draftFromProvider,
  emptyDraft,
  validateDraft,
  type DraftErrors,
  type ProviderDraft
} from './model'

export interface ProviderEditorState {
  draft: ProviderDraft | null
  /** Set when the editor cannot work at all (unknown provider, no bridge). */
  fatal: string | null
  errors: DraftErrors
  saving: boolean
  /** True for a provider that has not been saved once. */
  isNew: boolean
  /** True while editing a built-in — the reset button's condition. */
  isPreset: boolean
  /** Health probe of THIS provider, when the list already answered. */
  health: ProviderListEntry['health']
  update(mutate: (draft: ProviderDraft) => ProviderDraft): void
  save(): void
  cancel(): void
  /** Delete a custom provider, or reset a preset — the same store call. */
  removeOrReset(): void
}

export function useProviderEditor(providerId?: string): ProviderEditorState {
  const { t } = useTranslation()
  const bridge = useMemo<VertragusAppApi | undefined>(() => window.vertragus?.app, [])
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [fatal, setFatal] = useState<string | null>(bridge ? null : t('common.bridgeMissing'))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saving, setSaving] = useState(false)
  const [entries, setEntries] = useState<ProviderListEntry[]>([])
  const isNew = !providerId

  useEffect(() => {
    if (!bridge) return
    let alive = true
    bridge.listProviders().then(
      (list) => {
        if (!alive) return
        setEntries(list)
        if (!providerId) {
          setDraft(emptyDraft())
          return
        }
        const entry = list.find((candidate) => candidate.config.id === providerId)
        if (!entry) setFatal(t('providerEditor.unknownProvider'))
        else setDraft(draftFromProvider(entry.config))
      },
      (cause) => {
        if (alive) setFatal(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, providerId, t])

  const update = useCallback((mutate: (current: ProviderDraft) => ProviderDraft) => {
    setDraft((current) => (current ? mutate(current) : current))
  }, [])

  /** Ids that already exist — minus this record's own, which may be rewritten. */
  const takenIds = useMemo(
    () => entries.map((entry) => entry.config.id).filter((id) => id !== providerId),
    [entries, providerId]
  )

  const save = useCallback(() => {
    if (!bridge || !draft) return
    const result = validateDraft(t, draft, takenIds)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    setSaving(true)
    bridge.saveProvider(result.config as ProviderConfig).then(
      () => bridge.closeProviderEditor(),
      (cause) => {
        setSaving(false)
        setErrors({ form: errorText(cause) })
      }
    )
  }, [bridge, draft, takenIds, t])

  const cancel = useCallback(() => bridge?.closeProviderEditor(), [bridge])

  const isPreset = Boolean(draft?.presetId)

  const removeOrReset = useCallback(() => {
    if (!bridge || !draft || isNew) return
    const label = draft.label || draft.id
    const question = draft.presetId
      ? t('providerEditor.resetConfirm', { label })
      : t('providerEditor.deleteConfirm', { label })
    if (!window.confirm(question)) return
    setSaving(true)
    // One store call for both: dropping the stored entry deletes a custom
    // provider and, for a preset id, lets the built-in reappear.
    bridge.deleteProvider(draft.id).then(
      () => bridge.closeProviderEditor(),
      (cause) => {
        setSaving(false)
        setErrors({ form: errorText(cause) })
      }
    )
  }, [bridge, draft, isNew, t])

  const health = useMemo(
    () => entries.find((entry) => entry.config.id === providerId)?.health,
    [entries, providerId]
  )

  return {
    draft,
    fatal,
    errors,
    saving,
    isNew,
    isPreset,
    health,
    update,
    save,
    cancel,
    removeOrReset
  }
}
