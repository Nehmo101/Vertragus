/**
 * State of the settings window.
 *
 * Every write goes to main and the answer REPLACES the local state — the form
 * never keeps its own idea of what is stored. That matters here more than in
 * the profile editor: three of the five fields have a side effect in the main
 * process (hotkey registration, login item, update channel), and the honest
 * result of the write is what main sends back, not what the user clicked.
 *
 * The hotkey is the one field with a draft: it is free text, so it is edited
 * locally and committed explicitly. Everything else commits on change, because
 * a toggle with a Save button is a toggle people forget to save.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PanelSettings,
  UpdateState,
  VertragusAppApi,
  WritableSetting
} from '../../../preload'
import { errorText } from '../lib/ipcError'
import { validateAccelerator } from './model'

export interface SettingsState {
  bridge: VertragusAppApi | undefined
  settings: PanelSettings | null
  update: UpdateState | null
  /** Set when the window cannot work at all (no bridge, unreadable config). */
  fatal: string | null
  /** The hotkey field's live text — may differ from `settings.hideAllHotkey`. */
  hotkeyDraft: string
  hotkeyError: string | null
  saving: boolean
  /** Errors that belong to the sheet, not to one field. */
  error: string | null
  setHotkeyDraft(value: string): void
  saveHotkey(): void
  set(key: Exclude<WritableSetting, 'hideAllHotkey'>, value: unknown): void
  checkForUpdates(): void
  installUpdate(): void
  close(): void
}

export function useSettings(): SettingsState {
  const { t } = useTranslation()
  const bridge = useMemo(() => window.vertragus?.app, [])
  const [settings, setSettings] = useState<PanelSettings | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [fatal, setFatal] = useState<string | null>(bridge ? null : t('common.bridgeMissing'))
  const [hotkeyDraft, setHotkeyDraft] = useState('')
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((next: PanelSettings) => {
    setSettings(next)
    // The stored hotkey wins over the draft after every round trip: main may
    // have trimmed it, and a refused one still gets stored (with its reason).
    setHotkeyDraft(next.hideAllHotkey)
    setHotkeyError(next.hideAllHotkeyError ?? null)
  }, [])

  useEffect(() => {
    if (!bridge) return
    let alive = true

    bridge.getSettings().then(
      (next) => {
        if (alive) apply(next)
      },
      (cause) => {
        if (alive) setFatal(errorText(cause))
      }
    )
    bridge.getUpdateState().then(
      (next) => {
        if (alive) setUpdate(next)
      },
      // A broken updater must not take the settings window with it.
      (cause) => {
        if (alive) setError(errorText(cause))
      }
    )

    const off = bridge.onUpdate((next) => setUpdate(next))
    return () => {
      alive = false
      off()
    }
  }, [bridge, apply])

  const write = useCallback(
    (key: WritableSetting, value: unknown) => {
      if (!bridge) return
      setError(null)
      setSaving(true)
      bridge.setSetting(key, value).then(
        (next) => {
          setSaving(false)
          apply(next)
        },
        (cause) => {
          setSaving(false)
          if (key === 'hideAllHotkey') setHotkeyError(errorText(cause))
          else setError(errorText(cause))
        }
      )
    },
    [bridge, apply]
  )

  return {
    bridge,
    settings,
    update,
    fatal,
    hotkeyDraft,
    hotkeyError,
    saving,
    error,
    setHotkeyDraft: (value) => {
      setHotkeyDraft(value)
      setHotkeyError(null)
    },
    saveHotkey: () => {
      // The cheap gate first: a malformed accelerator would make main drop the
      // working registration before finding out it cannot take the new one.
      const check = validateAccelerator(t, hotkeyDraft)
      if (!check.ok) {
        setHotkeyError(check.reason)
        return
      }
      write('hideAllHotkey', hotkeyDraft.trim())
    },
    set: (key, value) => write(key, value),
    checkForUpdates: () => {
      if (!bridge) return
      setError(null)
      bridge.checkForUpdates().then(
        (next) => setUpdate(next),
        (cause) => setError(errorText(cause))
      )
    },
    installUpdate: () => {
      if (!bridge) return
      bridge.installUpdate().catch((cause: unknown) => setError(errorText(cause)))
    },
    close: () => bridge?.closeSettings()
  }
}
