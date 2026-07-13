import { describe, expect, it } from 'vitest'
import { agentSlotSchema, orchestratorSchema, workspaceProfileSchema } from './profile'
import {
  MODEL_PRESETS,
  PRESET_MODELS,
  formatModelLabel,
  modelPresetSchema,
  resolveModel
} from './models'

describe('modelPresetSchema', () => {
  it('accepts fast, balanced and strong', () => {
    for (const preset of MODEL_PRESETS) {
      expect(modelPresetSchema.parse(preset)).toBe(preset)
    }
  })
})

describe('resolveModel', () => {
  it('prefers explicit free-text over preset', () => {
    expect(resolveModel('claude', { model: 'fable', modelPreset: 'fast' })).toBe('fable')
  })

  it('maps preset when model is empty', () => {
    expect(resolveModel('claude', { model: '', modelPreset: 'strong' })).toBe('opus')
    expect(resolveModel('cursor', { model: '', modelPreset: 'fast' })).toBe('composer-2.5-fast')
    expect(resolveModel('codex', { model: '', modelPreset: 'balanced' })).toBe('gpt-5.6-terra')
    expect(resolveModel('codex', { model: '', modelPreset: 'strong' })).toBe('gpt-5.6-sol')
    expect(resolveModel('copilot', { model: '', modelPreset: 'balanced' })).toBe(
      'claude-sonnet-4.6'
    )
  })

  it('keeps legacy CLI default when preset is absent and model empty', () => {
    expect(resolveModel('codex', { model: '' })).toBe('')
    expect(resolveModel('claude', { model: '   ' })).toBe('')
  })

  it('covers every provider preset mapping', () => {
    const providers = Object.keys(PRESET_MODELS) as Array<keyof typeof PRESET_MODELS>
    for (const provider of providers) {
      for (const preset of MODEL_PRESETS) {
        const mapped = PRESET_MODELS[provider][preset]
        expect(typeof mapped).toBe('string')
        expect(resolveModel(provider, { model: '', modelPreset: preset })).toBe(mapped)
      }
    }
  })
})

describe('formatModelLabel', () => {
  it('shows resolved id or CLI default hint', () => {
    expect(formatModelLabel('sonnet')).toBe('sonnet')
    expect(formatModelLabel('', { modelPreset: 'balanced' })).toBe('CLI-Standard (Ausgewogen)')
    expect(formatModelLabel('')).toBe('CLI-Standard')
  })
})

describe('profile schema presets', () => {
  it('migrates legacy profiles without modelPreset', () => {
    const profile = workspaceProfileSchema.parse({
      id: 'legacy',
      name: 'Legacy',
      workingDir: '',
      orchestrator: { provider: 'claude', model: 'fable', autoOpenSubwindows: true },
      agents: [{ role: 'worker', provider: 'codex', model: '', count: 1, orchestrated: true, yolo: false }],
      yoloDefault: false
    })
    expect(profile.orchestrator?.modelPreset).toBeUndefined()
    expect(profile.agents[0]?.modelPreset).toBeUndefined()
    expect(resolveModel('claude', profile.orchestrator!)).toBe('fable')
    expect(resolveModel('codex', profile.agents[0]!)).toBe('')
  })

  it('accepts optional modelPreset on orchestrator and slots', () => {
    const orch = orchestratorSchema.parse({
      provider: 'cursor',
      model: '',
      modelPreset: 'strong',
      autoOpenSubwindows: true
    })
    expect(orch.modelPreset).toBe('strong')
    expect(resolveModel('cursor', orch)).toBe('claude-opus-4-8-high')

    const slot = agentSlotSchema.parse({
      role: 'worker',
      provider: 'ollama',
      model: '',
      modelPreset: 'fast',
      count: 1,
      orchestrated: true,
      yolo: false
    })
    expect(slot.modelPreset).toBe('fast')
    expect(resolveModel('ollama', slot)).toBe('qwen2.5-coder:14b')
  })
})
