import { describe, expect, it } from 'vitest'
import i18n from '@renderer/i18n'
import { presetOptionLabel } from './modelSelection'

// Assert the German source copy, independent of the host locale.
const t = i18n.getFixedT('de')

describe('presetOptionLabel', () => {
  it('names the model the selected provider would actually run', () => {
    expect(presetOptionLabel(t, 'claude', 'fast')).toBe('Schnell · haiku')
    expect(presetOptionLabel(t, 'claude', 'balanced')).toBe('Ausgewogen · sonnet')
    expect(presetOptionLabel(t, 'claude', 'strong')).toBe('Stark · opus')
  })

  it('follows the provider, so the same preset reads differently per provider', () => {
    expect(presetOptionLabel(t, 'kimi', 'strong')).toBe('Stark · kimi-k3-thinking')
    expect(presetOptionLabel(t, 'ollama', 'fast')).toBe('Schnell · qwen2.5-coder:14b')
  })
})
