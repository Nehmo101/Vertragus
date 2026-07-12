import { describe, expect, it, vi } from 'vitest'
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
})
