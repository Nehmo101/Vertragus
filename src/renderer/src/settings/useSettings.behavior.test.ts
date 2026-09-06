import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { PanelSettings } from '../../../preload'
import { useSettings, type SettingsState } from './useSettings'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => vi.unstubAllGlobals())

it('preserves edited hotkeys through unrelated pushes, rejected saves and a delayed save acknowledgement', async () => {
  let push!: (settings: PanelSettings) => void
  let resolve!: (settings: PanelSettings) => void
  const base = { hideAllHotkey: 'Ctrl+Alt+H' } as PanelSettings
  const setSetting = vi.fn().mockRejectedValueOnce(new Error('Shortcut occupied')).mockImplementation(() => new Promise<PanelSettings>((done) => { resolve = done }))
  const off = vi.fn()
  const app = { getSettings: async () => base, getUpdateState: async () => null, onSettings: (fn: typeof push) => { push = fn; return off }, onUpdate: () => off, setSetting }
  vi.stubGlobal('window', { vertragus: { app } })
  let state!: SettingsState
  function Probe() { state = useSettings(); return null }
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(Probe)) })
  act(() => state.setHotkeyDraft('Ctrl+Alt+J'))
  act(() => push({ ...base, voiceEnabled: true }))
  expect(state.hotkeyDraft).toBe('Ctrl+Alt+J')
  await act(async () => state.saveHotkey())
  expect(state.hotkeyError).toBe('Shortcut occupied')
  expect(state.hotkeyDraft).toBe('Ctrl+Alt+J')
  act(() => state.saveHotkey())
  act(() => state.setHotkeyDraft('Ctrl+Alt+K'))
  await act(async () => resolve({ ...base, hideAllHotkey: 'Ctrl+Alt+J' }))
  expect(state.hotkeyDraft).toBe('Ctrl+Alt+K')
  act(() => state.saveHotkey())
  await act(async () => resolve({ ...base, hideAllHotkey: 'Ctrl+Alt+K' }))
  act(() => push({ ...base, hideAllHotkey: 'Ctrl+Alt+L' }))
  expect(state.hotkeyDraft).toBe('Ctrl+Alt+L')
  act(() => tree.unmount())
  expect(off).toHaveBeenCalledTimes(2)
})
