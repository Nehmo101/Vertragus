import { describe, expect, it } from 'vitest'
import {
  collapseModelVariants,
  groupModelsByFamily,
  groupModelVariantsByFamily,
  isModelAlias,
  isSnapshotId,
  modelAfterProviderChange,
  modelFamily,
  normalizeModelKey,
  orderedModelList,
  snapshotBase,
  uniqueModels
} from './models'

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

describe('normalizeModelKey', () => {
  it('folds punctuation spellings of the same id together', () => {
    expect(normalizeModelKey('claude-sonnet-4.6')).toBe(normalizeModelKey('claude-sonnet-4-6'))
    expect(normalizeModelKey('CLAUDE-Sonnet-4_6')).toBe('claude-sonnet-4-6')
  })
})

describe('uniqueModels', () => {
  it('keeps the first spelling and drops blanks and non-strings', () => {
    expect(uniqueModels(['claude-sonnet-4.6', ' claude-sonnet-4-6 ', '', 7, null, 'opus'])).toEqual([
      'claude-sonnet-4.6',
      'opus'
    ])
  })
})

describe('snapshot ids', () => {
  it('detects dated snapshots and strips the date to the base id', () => {
    expect(isSnapshotId('claude-sonnet-4-5-20250929')).toBe(true)
    expect(snapshotBase('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
  })

  it('leaves non-date numeric ids alone', () => {
    for (const id of ['qwen2.5-coder:32b', 'gpt-5.4-mini', 'claude-sonnet-4-5', 'llama3.3:70b']) {
      expect(isSnapshotId(id)).toBe(false)
      expect(snapshotBase(id)).toBe(id)
    }
  })
})

describe('collapseModelVariants', () => {
  it('folds a dated snapshot into its base row as tooltip data', () => {
    expect(
      collapseModelVariants(['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-5'])
    ).toEqual([
      { id: 'claude-sonnet-4-5', snapshots: ['claude-sonnet-4-5-20250929'] },
      { id: 'claude-opus-5', snapshots: [] }
    ])
  })

  it('folds a snapshot listed BEFORE its base (source order independent)', () => {
    expect(collapseModelVariants(['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'])).toEqual([
      { id: 'claude-sonnet-4-5', snapshots: ['claude-sonnet-4-5-20250929'] }
    ])
  })

  it('keeps an orphan snapshot launchable as its own row', () => {
    expect(collapseModelVariants(['claude-haiku-4-5-20251001'])).toEqual([
      { id: 'claude-haiku-4-5-20251001', snapshots: [] }
    ])
  })

  it('collapses punctuation twins, first spelling wins', () => {
    expect(collapseModelVariants(['claude-sonnet-4.6', 'claude-sonnet-4-6'])).toEqual([
      { id: 'claude-sonnet-4.6', snapshots: [] }
    ])
  })

  it('does not collapse genuinely different versions', () => {
    const rows = collapseModelVariants(['gpt-5.4-mini', 'gpt-5.6-sol', 'qwen2.5-coder:32b'])
    expect(rows.map((row) => row.id)).toEqual(['gpt-5.4-mini', 'gpt-5.6-sol', 'qwen2.5-coder:32b'])
  })
})

describe('groupModelVariantsByFamily', () => {
  it('shows alias, base and snapshot as ONE family block', () => {
    const groups = groupModelVariantsByFamily(
      collapseModelVariants([
        'sonnet',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-5'
      ])
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.alias?.id).toBe('sonnet')
    expect(groups[0]!.pinned.map((variant) => variant.id)).toEqual([
      'claude-sonnet-4-6',
      'claude-sonnet-4-5'
    ])
    expect(groups[0]!.pinned[1]!.snapshots).toEqual(['claude-sonnet-4-5-20250929'])
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

  it('keeps a version-free multi-word id whole', () => {
    expect(modelFamily('kimi-for-coding')).toBe('kimi-for-coding')
  })

  it('returns an empty family for blank input', () => {
    expect(modelFamily('  ')).toBe('')
  })
})

describe('groupModelsByFamily', () => {
  it('pairs the rolling alias with its pinned releases (the fable/claude-fable-5 question)', () => {
    expect(groupModelsByFamily(['fable', 'claude-fable-5', 'opus', 'claude-opus-5'])).toEqual([
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
    expect(groupModelsByFamily(['opus', 'OPUS', 'claude-opus-5', 'claude-opus-5'])).toEqual([
      { family: 'opus', alias: 'opus', pinned: ['claude-opus-5'] }
    ])
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
    const ordered = orderedModelList(['opus', 'claude-opus-5', 'OPUS', 'claude-opus-5', 'sonnet'])
    expect(new Set(ordered).size).toBe(ordered.length)
    expect(ordered.indexOf('opus')).toBeLessThan(ordered.indexOf('claude-opus-5'))
  })
})

describe('modelAfterProviderChange', () => {
  // The same helper backs the orchestrator field and every slot, so these cases
  // guard both call sites (regression: a same-value reselect used to wipe a
  // saved model and persist model: '').
  it('keeps an explicit model when the provider is unchanged (main regression)', () => {
    expect(modelAfterProviderChange('claude', 'claude', 'opus')).toBe('opus')
  })

  it('clears the model on a real provider switch', () => {
    expect(modelAfterProviderChange('claude', 'codex', 'opus')).toBe('')
  })

  it('does not restore an old model after A→B→A', () => {
    const afterSwitch = modelAfterProviderChange('claude', 'codex', 'opus')
    expect(afterSwitch).toBe('')
    expect(modelAfterProviderChange('codex', 'claude', afterSwitch)).toBe('')
  })

  it('preserves a free-text model outside the catalogue on same-provider reselect', () => {
    expect(modelAfterProviderChange('claude', 'claude', 'my-custom-experimental')).toBe(
      'my-custom-experimental'
    )
  })

  it('works for custom provider ids too (no closed provider union any more)', () => {
    expect(modelAfterProviderChange('custom-acme', 'custom-acme', 'x1')).toBe('x1')
    expect(modelAfterProviderChange('custom-acme', 'claude', 'x1')).toBe('')
  })
})
