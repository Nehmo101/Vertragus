import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveLanguage } from './i18n'
import de from './locales/de.json'
import en from './locales/en.json'

describe('resolveLanguage', () => {
  it('honours explicit choices', () => {
    expect(resolveLanguage('de')).toBe('de')
    expect(resolveLanguage('en')).toBe('en')
  })

  it('falls back to a supported language for the system preference', () => {
    expect(['de', 'en']).toContain(resolveLanguage('system'))
  })
})

describe('locale resources', () => {
  function keysOf(value: unknown, prefix = ''): string[] {
    if (typeof value !== 'object' || value === null) return [prefix]
    return Object.entries(value).flatMap(([key, child]) =>
      keysOf(child, prefix ? `${prefix}.${key}` : key)
    )
  }

  it('keeps German and English key sets in sync', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(de).sort())
  })

  it('leaves no empty translations', () => {
    for (const resource of [de, en]) {
      for (const key of keysOf(resource)) {
        const leaf = key.split('.').reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)[part],
          resource
        )
        expect(String(leaf).trim().length, key).toBeGreaterThan(0)
      }
    }
  })

  it('keeps canvas composer + voice overlay surface keys in DE/EN parity', () => {
    const required = [
      'canvas.composer.startMode',
      'canvas.composer.label',
      'canvas.composer.placeholder',
      'canvas.composer.startPlaceholder',
      'canvas.composer.voice',
      'canvas.composer.send',
      'canvas.thread.label',
      'voiceOverlay.toggle',
      'voiceOverlay.hide',
      'voiceOverlay.confirmation',
      'voiceOverlay.yesValue',
      'voiceOverlay.noValue',
      'voiceOverlay.state.listening',
      'voiceOverlay.state.thinking',
      'voiceOverlay.state.speaking'
    ]
    const deKeys = new Set(keysOf(de))
    const enKeys = new Set(keysOf(en))
    for (const key of required) {
      expect(deKeys.has(key), `missing DE key ${key}`).toBe(true)
      expect(enKeys.has(key), `missing EN key ${key}`).toBe(true)
    }
  })
})

/**
 * Hard-coded German UI copy is being migrated to i18n keys incrementally. German
 * umlauts / eszett (ä ö ü Ä Ö Ü ß) are a reliable fingerprint of un-migrated
 * copy, so this guard fails when a renderer `.tsx` component that is NOT on the
 * allowlist still contains them — either from a regression in an already migrated
 * screen, or from a brand-new component authored with hard-coded German.
 *
 * The ALLOWLIST enumerates the components that are still authored in German. It
 * is meant to SHRINK over time: when a component is migrated to t()-keys, delete
 * its entry here. When the list is empty, the whole renderer is migrated.
 */
describe('renderer i18n hardcode guard', () => {
  const UMLAUTS = /[äöüÄÖÜß]/
  // This test file lives at src/renderer/src/i18n.test.ts, so its directory is
  // the renderer source root that we walk for components.
  const rendererSrc = dirname(fileURLToPath(import.meta.url))

  // Components not yet migrated to i18n keys (still contain German umlauts).
  // ProfileEditor + everything under profileEditor/ is being decomposed by a
  // separate effort and must stay untouched here. Remove entries as screens are
  // migrated — this list should only ever get shorter.
  const ALLOWLIST = new Set<string>([
    'components/ProfileEditor.tsx',
    'components/profileEditor/AgentSlotsSection.tsx',
    'components/profileEditor/AutoGitSection.tsx',
    'components/profileEditor/AutoPrSection.tsx',
    'components/profileEditor/ModeOrchestratorSection.tsx',
    'components/profileEditor/PlannerSection.tsx',
    'components/profileEditor/RepoWorkspaceSection.tsx',
    'components/profileEditor/SkillsSection.tsx',
    'components/OrchestratorPanel.tsx',
    'components/TitleBar.tsx',
    'components/CanvasBoard.tsx',
    'components/CanvasTerminalDrawer.tsx',
    'components/DiffMergeCenter.tsx',
    'components/HandoffModal.tsx',
    'components/IdeaTransferModal.tsx',
    'components/ModelCombo.tsx',
    'components/PaneWindow.tsx',
    'components/PromptEnhancementReview.tsx',
    'components/RemotePanel.tsx',
    'components/VoiceOverlay.tsx'
  ])

  /** Every renderer `.tsx` component (test fixtures excluded), path relative to src. */
  function componentFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return componentFiles(full)
      if (!entry.isFile() || !entry.name.endsWith('.tsx')) return []
      if (entry.name.endsWith('.test.tsx')) return []
      return [relative(rendererSrc, full).split(sep).join('/')]
    })
  }

  it('migrated components contain no hard-coded German umlauts', () => {
    const offenders = componentFiles(rendererSrc).filter(
      (file) => !ALLOWLIST.has(file) && UMLAUTS.test(readFileSync(join(rendererSrc, file), 'utf8'))
    )
    expect(
      offenders,
      `Migrate these components to i18n keys (or, only if unavoidable, allowlist them): ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('the four target components are migrated and not on the allowlist', () => {
    const migrated = [
      'App.tsx',
      'components/InboxPanel.tsx',
      'components/AgentPane.tsx',
      'components/McpServerEditor.tsx'
    ]
    for (const file of migrated) {
      expect(ALLOWLIST.has(file), `${file} must not be allowlisted`).toBe(false)
      expect(UMLAUTS.test(readFileSync(join(rendererSrc, file), 'utf8')), `${file} still has umlauts`).toBe(false)
    }
  })

  it('keeps the allowlist honest so it can only shrink', () => {
    // A file may only stay on the allowlist while it still has German umlauts.
    // Once migrated it becomes clean and must be removed from the list.
    const stale = [...ALLOWLIST].filter(
      (file) => !UMLAUTS.test(readFileSync(join(rendererSrc, file), 'utf8'))
    )
    expect(stale, `These files are already clean — drop them from ALLOWLIST: ${stale.join(', ')}`).toEqual([])
  })
})
