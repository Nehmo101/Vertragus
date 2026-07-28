import { describe, expect, it } from 'vitest'
import { REMOTE_CAPABILITIES, type RemoteCapability } from '@shared/remote'
import {
  REMOTE_PRESET_CAPABILITIES,
  REMOTE_PRESET_IDS,
  normalizeCapabilities,
  presetForCapabilities
} from './remotePresets'

describe('remotePresets', () => {
  it('only uses capabilities that exist in the shared contract', () => {
    for (const preset of REMOTE_PRESET_IDS) {
      for (const cap of REMOTE_PRESET_CAPABILITIES[preset]) {
        expect(REMOTE_CAPABILITIES).toContain(cap)
      }
    }
  })

  it('defines the agreed matrix', () => {
    expect(REMOTE_PRESET_CAPABILITIES.observe).toEqual(['read', 'diff', 'push'])
    expect(REMOTE_PRESET_CAPABILITIES.approve).toEqual([
      'read', 'diff', 'push', 'speech', 'approve-tools', 'budget'
    ])
    expect([...REMOTE_PRESET_CAPABILITIES.full]).toEqual([...REMOTE_CAPABILITIES])
  })

  it('keeps presets strictly ascending (observe ⊂ approve ⊂ full)', () => {
    const approve = new Set(REMOTE_PRESET_CAPABILITIES.approve)
    const full = new Set(REMOTE_PRESET_CAPABILITIES.full)
    for (const cap of REMOTE_PRESET_CAPABILITIES.observe) expect(approve.has(cap)).toBe(true)
    for (const cap of REMOTE_PRESET_CAPABILITIES.approve) expect(full.has(cap)).toBe(true)
    expect(approve.size).toBeGreaterThan(REMOTE_PRESET_CAPABILITIES.observe.length)
    expect(full.size).toBeGreaterThan(approve.size)
  })

  it('reserves admin and steer for full access only', () => {
    for (const preset of ['observe', 'approve'] as const) {
      expect(REMOTE_PRESET_CAPABILITIES[preset]).not.toContain('admin')
      expect(REMOTE_PRESET_CAPABILITIES[preset]).not.toContain('steer')
    }
    expect(REMOTE_PRESET_CAPABILITIES.full).toContain('admin')
    expect(REMOTE_PRESET_CAPABILITIES.full).toContain('steer')
  })

  it('roundtrips every preset through presetForCapabilities', () => {
    for (const preset of REMOTE_PRESET_IDS) {
      expect(presetForCapabilities(REMOTE_PRESET_CAPABILITIES[preset])).toBe(preset)
    }
  })

  it('matches presets independent of capability order', () => {
    const shuffled = [...REMOTE_PRESET_CAPABILITIES.approve].reverse()
    expect(presetForCapabilities(shuffled)).toBe('approve')
  })

  it('detects custom selections (supersets, subsets, unrelated sets)', () => {
    expect(presetForCapabilities([])).toBe('custom')
    expect(presetForCapabilities(['read'])).toBe('custom')
    expect(presetForCapabilities([...REMOTE_PRESET_CAPABILITIES.observe, 'speech'])).toBe('custom')
    expect(presetForCapabilities(REMOTE_PRESET_CAPABILITIES.approve.slice(0, -1))).toBe('custom')
    const almostFull = REMOTE_CAPABILITIES.filter((cap) => cap !== 'admin')
    expect(presetForCapabilities(almostFull)).toBe('custom')
  })

  it('ignores duplicate entries when matching', () => {
    const withDuplicates: RemoteCapability[] = ['read', 'read', 'diff', 'push', 'diff']
    expect(presetForCapabilities(withDuplicates)).toBe('observe')
  })

  it('normalizeCapabilities dedupes and restores canonical order', () => {
    expect(normalizeCapabilities(['push', 'read', 'diff', 'push'])).toEqual(['read', 'diff', 'push'])
    expect(normalizeCapabilities([...REMOTE_CAPABILITIES].reverse())).toEqual([...REMOTE_CAPABILITIES])
  })
})
