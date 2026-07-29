import { describe, expect, it } from 'vitest'
import { agentSlotSchema, orchestratorSchema, workspaceProfileSchema } from './profile'
import {
  formatModelLabel,
  groupModelsByFamily,
  isModelAlias,
  modelAfterProviderChange,
  modelFamily,
  orderedModelList,
  resolveModel
} from './models'
import { DEFAULT_MODELS } from './providers'

describe('resolveModel', () => {
  it('returns the explicit model', () => {
    expect(resolveModel('claude', { model: 'fable' })).toBe('fable')
  })

  it('falls back to the provider CLI default for an empty model', () => {
    expect(resolveModel('codex', { model: '' })).toBe('')
    expect(resolveModel('claude', { model: '   ' })).toBe('')
    expect(resolveModel('claude', {})).toBe('')
  })
})

describe('formatModelLabel', () => {
  it('shows the resolved id or the CLI default hint', () => {
    expect(formatModelLabel('sonnet')).toBe('sonnet')
    expect(formatModelLabel('')).toBe('CLI-Standard')
  })
})

describe('isModelAlias', () => {
  it('treats version-free ids as rolling aliases', () => {
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable', 'auto']) {
      expect(isModelAlias(alias)).toBe(true)
    }
  })

  it('treats versioned ids as pinned releases', () => {
    for (const pinned of ['claude-opus-5', 'claude-haiku-4-5', 'gpt-5.6-sol', 'qwen2.5-coder:32b']) {
      expect(isModelAlias(pinned)).toBe(false)
    }
  })

  it('rejects blank input', () => {
    expect(isModelAlias('   ')).toBe(false)
  })
})

describe('modelFamily', () => {
  it('maps an alias and its pinned releases to the same family', () => {
    expect(modelFamily('opus')).toBe('opus')
    expect(modelFamily('claude-opus-5')).toBe('opus')
    expect(modelFamily('claude-opus-4-8')).toBe('opus')
    expect(modelFamily('CLAUDE-Opus-4-7')).toBe('opus')
  })

  it('groups non-Claude ids by their leading name segments', () => {
    expect(modelFamily('gpt-5.6-sol')).toBe('gpt')
    expect(modelFamily('composer-2.5-fast')).toBe('composer')
    expect(modelFamily('kimi-k3-thinking')).toBe('kimi')
  })

  it('falls back to the first segment when the id starts with its version', () => {
    expect(modelFamily('qwen2.5-coder:32b')).toBe('qwen2')
  })

  it('returns an empty family for blank input', () => {
    expect(modelFamily('  ')).toBe('')
  })
})

describe('groupModelsByFamily', () => {
  it('pairs the rolling alias with its pinned releases (the fable/claude-fable-5 question)', () => {
    const groups = groupModelsByFamily(['fable', 'claude-fable-5', 'opus', 'claude-opus-5'])
    expect(groups).toEqual([
      { family: 'fable', alias: 'fable', pinned: ['claude-fable-5'] },
      { family: 'opus', alias: 'opus', pinned: ['claude-opus-5'] }
    ])
  })

  it('keeps the order of first appearance', () => {
    const groups = groupModelsByFamily(['claude-opus-5', 'haiku', 'opus'])
    expect(groups.map((group) => group.family)).toEqual(['opus', 'haiku'])
    expect(groups[0]).toEqual({ family: 'opus', alias: 'opus', pinned: ['claude-opus-5'] })
  })

  it('collapses case-insensitive duplicates from merged catalogues', () => {
    const groups = groupModelsByFamily(['opus', 'OPUS', 'claude-opus-5', 'claude-opus-5'])
    expect(groups).toEqual([{ family: 'opus', alias: 'opus', pinned: ['claude-opus-5'] }])
  })

  it('handles families without an alias', () => {
    expect(groupModelsByFamily(['gpt-5.6-sol', 'gpt-5.4-mini'])).toEqual([
      { family: 'gpt', pinned: ['gpt-5.6-sol', 'gpt-5.4-mini'] }
    ])
  })
})

describe('orderedModelList', () => {
  it('puts every family alias directly before its pinned releases', () => {
    expect(orderedModelList(['claude-opus-5', 'sonnet', 'opus', 'claude-sonnet-5'])).toEqual([
      'opus',
      'claude-opus-5',
      'sonnet',
      'claude-sonnet-5'
    ])
  })

  it('deduplicates without losing an entry', () => {
    const seeded = orderedModelList(DEFAULT_MODELS.claude)
    expect(new Set(seeded).size).toBe(seeded.length)
    expect(seeded).toContain('opus')
    expect(seeded).toContain('claude-opus-5')
    // The rolling alias always precedes the pinned releases of its family.
    expect(seeded.indexOf('opus')).toBeLessThan(seeded.indexOf('claude-opus-5'))
  })
})

describe('profile schema model selection', () => {
  it('accepts legacy profiles that only carry a model', () => {
    const profile = workspaceProfileSchema.parse({
      id: 'legacy',
      name: 'Legacy',
      workingDir: '',
      orchestrator: { provider: 'claude', model: 'fable', autoOpenSubwindows: true },
      agents: [{ role: 'worker', provider: 'codex', model: '', count: 1, orchestrated: true, yolo: false }],
      yoloDefault: false
    })
    expect(profile.orchestrator?.effort).toBeUndefined()
    expect(profile.agents[0]?.effort).toBeUndefined()
    expect(resolveModel('claude', profile.orchestrator!)).toBe('fable')
    expect(resolveModel('codex', profile.agents[0]!)).toBe('')
  })

  it('accepts an optional effort on the orchestrator and on slots', () => {
    const orch = orchestratorSchema.parse({
      provider: 'cursor',
      model: 'composer-2.5',
      effort: 'max',
      autoOpenSubwindows: true
    })
    expect(orch.effort).toBe('max')

    const slot = agentSlotSchema.parse({
      role: 'worker',
      provider: 'claude',
      model: 'opus',
      effort: 'ultra',
      count: 1,
      orchestrated: true,
      yolo: false
    })
    expect(slot.effort).toBe('ultra')
  })

  it('rejects an unknown effort level', () => {
    expect(
      agentSlotSchema.safeParse({
        role: 'worker',
        provider: 'claude',
        model: '',
        effort: 'balanced',
        count: 1,
        orchestrated: true,
        yolo: false
      }).success
    ).toBe(false)
  })
})

describe('modelAfterProviderChange', () => {
  // Same shared helper is used by the orchestrator and every subagent slot,
  // so these cases guard both call sites identically (regression: a same-value
  // provider reselect used to wipe a saved model and persist model: '').
  it('keeps an explicit model when the provider is unchanged (main regression)', () => {
    expect(modelAfterProviderChange('claude', 'claude', 'opus')).toBe('opus')
  })

  it('clears the model on a real provider switch', () => {
    expect(modelAfterProviderChange('claude', 'codex', 'opus')).toBe('')
  })

  it('leaves an already-empty model empty on a same-provider reselect', () => {
    expect(modelAfterProviderChange('claude', 'claude', '')).toBe('')
  })

  it('does not restore an old model after A→B→A', () => {
    // switch away clears, switching back does not resurrect the previous id
    const afterSwitch = modelAfterProviderChange('claude', 'codex', 'opus')
    expect(afterSwitch).toBe('')
    expect(modelAfterProviderChange('codex', 'claude', afterSwitch)).toBe('')
  })

  it('preserves a free-text model outside the catalogue on same-provider reselect', () => {
    expect(modelAfterProviderChange('claude', 'claude', 'my-custom-experimental')).toBe(
      'my-custom-experimental'
    )
  })

  it('resolveModel keeps the saved model after a same-provider reselect (persistence)', () => {
    const model = modelAfterProviderChange('claude', 'claude', 'opus')
    expect(resolveModel('claude', { model })).toBe('opus')
  })
})
