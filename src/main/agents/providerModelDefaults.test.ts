import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ homedir: vi.fn(() => '/nonexistent-home') }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: mocks.homedir }
})

import {
  CODEX_CONFIG_DEFAULT_LABEL,
  detectCodexDefaultModel,
  resetCodexDefaultModelCacheForTest,
  resolveSlotModel
} from './providerModelDefaults'

const created: string[] = []

afterEach(async () => {
  resetCodexDefaultModelCacheForTest()
  mocks.homedir.mockReturnValue('/nonexistent-home')
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function homeWithCodexConfig(toml: string): Promise<string> {
  const home = await mkdtemp('/tmp/orca-codex-home-')
  created.push(home)
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'config.toml'), toml)
  return home
}

describe('providerModelDefaults', () => {
  it('reads the codex default model from ~/.codex/config.toml', async () => {
    mocks.homedir.mockReturnValue(await homeWithCodexConfig(
      '# kommentar\nmodel = "gpt-5.6-sol"\n[sandbox]\nmode = "workspace-write"\n'
    ))
    resetCodexDefaultModelCacheForTest()

    expect(detectCodexDefaultModel()).toBe('gpt-5.6-sol')
    expect(resolveSlotModel('codex', {})).toBe('gpt-5.6-sol')
  })

  it('falls back to a stable label instead of an empty string', () => {
    // Retros: model:"" machte Learnings unattribuierbar ("Orca lieferte
    // keinen Modellnamen"); der Slot-Name muss immer befüllt sein.
    expect(resolveSlotModel('codex', {})).toBe(CODEX_CONFIG_DEFAULT_LABEL)
  })

  it('keeps explicit models and presets untouched', () => {
    expect(resolveSlotModel('codex', { model: 'gpt-5.4-mini' })).toBe('gpt-5.4-mini')
    expect(resolveSlotModel('codex', { modelPreset: 'strong' })).toBe('gpt-5.6-sol')
    expect(resolveSlotModel('claude', {})).toBe('')
  })
})
