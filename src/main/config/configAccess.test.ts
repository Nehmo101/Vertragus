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

  it('exposes remote.enabled but refuses unsafe generic activation', () => {
    expect(() => assertConfigGetAllowed('remote.enabled')).not.toThrow()
    expect(() => assertConfigSetAllowed('remote.enabled')).not.toThrow()
    expect(() => setPublicConfig('remote.enabled', true)).toThrow(/sichere Remote-Aktivierung/)
    setPublicConfig('remote.enabled', false)
    expect(setSetting).toHaveBeenLastCalledWith('remote.enabled', false)
  })

  it('validates retroSync keys before persisting', () => {
    setPublicConfig('retroSync.enabled', true)
    expect(setSetting).toHaveBeenLastCalledWith('retroSync.enabled', true)
    expect(() => setPublicConfig('retroSync.enabled', 'yes')).toThrow(/true oder false/)

    setPublicConfig('retroSync.repoOwner', ' @Nehmo101 ')
    expect(setSetting).toHaveBeenLastCalledWith('retroSync.repoOwner', 'Nehmo101')
    expect(() => setPublicConfig('retroSync.repoOwner', '-x')).toThrow(/Ungültiger GitHub-Owner/)

    setPublicConfig('retroSync.repoName', 'Vertragus')
    expect(setSetting).toHaveBeenLastCalledWith('retroSync.repoName', 'Vertragus')
    expect(() => setPublicConfig('retroSync.repoName', 'a/b')).toThrow(/Repo-Name/)

    setPublicConfig('retroSync.branch', ' retros ')
    expect(setSetting).toHaveBeenLastCalledWith('retroSync.branch', 'retros')
    expect(() => setPublicConfig('retroSync.branch', 'main')).toThrow(/geschützten Branch/)
  })

  it('persists only validated Orca process gates', () => {
    setPublicConfig('providerLimits', { cursor: 2, claude: 6 })

    expect(setSetting).toHaveBeenLastCalledWith('providerLimits', {
      claude: 6,
      kimi: 8,
      codex: 8,
      cursor: 2,
      copilot: 8,
      ollama: 8
    })
    expect(() => setPublicConfig('providerLimits', { cursor: 0 })).toThrow(/zwischen 1 und/)
    expect(() => setPublicConfig('providerLimits', { cursor: -1 })).toThrow(/zwischen 1 und/)
    expect(() => setPublicConfig('providerLimits', { claude: Number.NaN })).toThrow(/ganze Zahl/)
    expect(() => setPublicConfig('providerLimits', { injected: 4 })).toThrow(/Unbekanntes Orca-Gate/)
  })
})
