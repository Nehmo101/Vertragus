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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeAppearance, type Appearance } from '@shared/appearance'
import type {
  PanelSettings,
  UpdateState,
  VertragusAppApi,
  WritableSetting
} from '../../../preload'
import { errorText } from '../lib/ipcError'
import { applyAppearance } from '../styles/appearance'
import { validateAccelerator } from './model'

/**
 * How long a moving slider may run ahead of the store.
 *
 * React maps `onChange` to the DOM `input` event, so dragging a range control
 * fires on every pixel. The window paints each of those immediately (locally,
 * see `patchAppearance`); only the WRITE waits for the drag to settle, which
 * is what keeps one gesture from becoming eighty IPC round trips and eighty
 * disk writes.
 */
export const APPEARANCE_WRITE_DEBOUNCE_MS = 200

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
  set(key: Exclude<WritableSetting, 'hideAllHotkey' | 'appearance'>, value: unknown): void
  /**
   * Change one appearance field. Paints this window at once and writes the
   * whole object once the user stops moving the control.
   */
  patchAppearance(patch: Partial<Appearance>): void
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

  /** Pending debounced appearance write; cancelled by the next slider move. */
  const appearanceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The value that write is still waiting to send — see the flush below. */
  const pendingAppearance = useRef<Appearance | undefined>(undefined)

  /**
   * Closing the window must not eat the last slider position: the drag that
   * ended a moment ago may still be inside the debounce. Fire it now — this is
   * the same `setSetting` the timer would have called, just earlier.
   */
  useEffect(() => {
    return () => {
      if (!appearanceTimer.current) return
      clearTimeout(appearanceTimer.current)
      const value = pendingAppearance.current
      if (value) void bridge?.setSetting('appearance', value).catch(() => undefined)
    }
  }, [bridge])

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
    patchAppearance: (patch) => {
      if (!settings) return
      const next = normalizeAppearance({ ...settings.appearance, ...patch })
      // Local first, and unconditionally: the settings window is made of the
      // same glass it is configuring, so the slider IS the preview. Waiting for
      // the round trip would make every drag feel like it lags a frame behind.
      applyAppearance(document.documentElement, next)
      setSettings({ ...settings, appearance: next })
      if (appearanceTimer.current) clearTimeout(appearanceTimer.current)
      pendingAppearance.current = next
      appearanceTimer.current = setTimeout(() => {
        appearanceTimer.current = undefined
        pendingAppearance.current = undefined
        write('appearance', next)
      }, APPEARANCE_WRITE_DEBOUNCE_MS)
    },
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
