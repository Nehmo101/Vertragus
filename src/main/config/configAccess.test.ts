import { describe, expect, it, vi } from 'vitest'
import { setSetting } from '@main/config/store'
import {
  assertConfigGetAllowed,
  assertConfigSetAllowed,
  getPublicConfig,
  setPublicConfig
} from './configAccess'

vi.mock('@main/config/store', () => ({
  getSetting: vi.fn((key: string) => (key === 'yoloMaster' ? true : undefined)),
  setSetting: vi.fn()
}))

describe('configAccess', () => {
  it('allows public UI keys for get/set', () => {
    expect(() => assertConfigGetAllowed('ui.theme')).not.toThrow()
    expect(() => assertConfigSetAllowed('providerLimits')).not.toThrow()
    expect(getPublicConfig<boolean>('yoloMaster')).toBe(true)
    expect(() => setPublicConfig('yoloMaster', false)).not.toThrow()
  })

  it('blocks secrets.* keys for get and set', () => {
    expect(() => assertConfigGetAllowed('secrets.github.oauth')).toThrow(/per IPC lesen/)
    expect(() => assertConfigSetAllowed('secrets.openai.transcription')).toThrow(/per IPC schreiben/)
    expect(() => getPublicConfig('secrets.github.meta')).toThrow()
    expect(() => setPublicConfig('secrets.github.oauth', 'x')).toThrow()
  })

  it('rejects unknown keys', () => {
    expect(() => assertConfigGetAllowed('inboxSpeech.model')).toThrow(/nicht über IPC lesbar/)
    expect(() => assertConfigSetAllowed('github.oauthClientId')).toThrow(/nicht über IPC schreibbar/)
  })

  it('persists only validated Orca process gates', () => {
    setPublicConfig('providerLimits', { cursor: 2, claude: 6 })

    expect(setSetting).toHaveBeenLastCalledWith('providerLimits', {
      claude: 6,
      codex: 4,
      cursor: 2,
      copilot: 4,
      ollama: 2
    })
    expect(() => setPublicConfig('providerLimits', { cursor: 0 })).toThrow(/zwischen 1 und 16/)
    expect(() => setPublicConfig('providerLimits', { claude: Number.NaN })).toThrow(/ganze Zahl/)
    expect(() => setPublicConfig('providerLimits', { injected: 4 })).toThrow(/Unbekanntes Orca-Gate/)
  })
})
