import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/schema/events'
import { translator } from '../i18n'
import { formatEvent, mergeEvents } from './formatEvent'

function event(partial: Partial<AgentEvent> & Pick<AgentEvent, 'type'>): AgentEvent {
  return {
    seq: 1,
    ts: 1_700_000_000_000,
    agentId: 'a1',
    name: 'Virgilio',
    roleId: 'orchestrator',
    ...partial
  } as AgentEvent
}

describe('formatEvent', () => {
  it('uses the i18n label and the done summary as detail', () => {
    const row = formatEvent(
      translator('en'),
      event({ type: 'agent_done', summary: 'parser landed', status: 'success' })
    )
    expect(row.label).toContain('Virgilio')
    expect(row.detail).toBe('parser landed')
    expect(row.seq).toBe(1)
  })

  it('merges snapshot and live rows by seq without duplicates', () => {
    const first = event({ type: 'agent_started', seq: 1 })
    const second = event({ type: 'agent_done', seq: 2, summary: 'ok', status: 'success' })
    const merged = mergeEvents([second], [first, second])
    expect(merged.map((row) => row.seq)).toEqual([1, 2])
  })

  it('quotes a user message as the detail line', () => {
    const row = formatEvent(
      translator('de'),
      event({ type: 'user_message', text: 'fix the tests' })
    )
    expect(row.detail).toBe('fix the tests')
  })
})
