import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSlot } from '@shared/profile'
import {
  MultiAgentOverrideSelect,
  effectiveMultiAgentEnabled,
  multiAgentOverrideChoice,
  slotWithMultiAgentOverride
} from './profileEditor/MultiAgentOverrideSelect'

const baseSlot: AgentSlot = {
  role: 'worker',
  provider: 'codex',
  model: '',
  count: 1,
  orchestrated: false,
  yolo: false,
  strengths: [],
  weaknesses: []
}

describe('ProfileEditor multiagent slot override', () => {
  it('treats old and new slots without an override as Global erben', () => {
    expect(multiAgentOverrideChoice(undefined)).toBe('inherit')
    expect('multiAgent' in baseSlot).toBe(false)
    expect(effectiveMultiAgentEnabled(baseSlot, true)).toBe(true)
    expect(effectiveMultiAgentEnabled(baseSlot, false)).toBe(false)
  })

  it('preserves explicit false instead of falling back to the global value', () => {
    const updated = slotWithMultiAgentOverride(baseSlot, 'off')

    expect(updated.multiAgent).toBe(false)
    expect(multiAgentOverrideChoice(updated.multiAgent)).toBe('off')
    expect(effectiveMultiAgentEnabled(updated, true)).toBe(false)
  })

  it('stores explicit true even for count=1 and a non-orchestrated slot', () => {
    const updated = slotWithMultiAgentOverride(baseSlot, 'on')

    expect(updated).toMatchObject({ count: 1, orchestrated: false, multiAgent: true })
    expect(effectiveMultiAgentEnabled(updated, false)).toBe(true)
  })

  it('removes an existing override when Global erben is selected', () => {
    const overridden = slotWithMultiAgentOverride(baseSlot, 'off')
    const inherited = slotWithMultiAgentOverride(overridden, 'inherit')

    expect('multiAgent' in inherited).toBe(false)
    expect(multiAgentOverrideChoice(inherited.multiAgent)).toBe('inherit')
  })

  it('renders an accessible inherited selection with the current global effect', () => {
    const markup = renderToStaticMarkup(createElement(MultiAgentOverrideSelect, {
      id: 'slot-multi-agent-0',
      value: undefined,
      globalEnabled: true,
      onChange: vi.fn()
    }))

    expect(markup).toContain('for="slot-multi-agent-0"')
    expect(markup).toContain('aria-describedby="slot-multi-agent-0-status"')
    expect(markup).toContain('<option value="inherit" selected="">Global erben — aktuell Aktiv</option>')
    expect(markup).toContain('Effektiv: Aktiv · globale Einstellung geerbt')
  })

  it('shows explicit false as an override while keeping count=1 editable', () => {
    const markup = renderToStaticMarkup(createElement(MultiAgentOverrideSelect, {
      id: 'slot-multi-agent-0',
      value: false,
      globalEnabled: true,
      onChange: vi.fn()
    }))

    expect(markup).toContain('<option value="off" selected="">Aus</option>')
    expect(markup).toContain('Effektiv: Aus · Slot-Override · global Aktiv')
    expect(markup).not.toContain('id="slot-multi-agent-0" class="slot-select-sm" disabled=""')
  })
})
