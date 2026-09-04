import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/schema/events'
import { translator } from '../i18n'
import { formatEvent, formatEventTime, mergeEvents } from './formatEvent'

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
      event({ type: 'agent_done', summary: 'parser landed', status: 'success' }),
      'en'
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
      event({ type: 'user_message', text: 'fix the tests' }),
      'de'
    )
    expect(row.detail).toBe('fix the tests')
  })

  it('uses the conflict message, then a pull-request message or its url', () => {
    expect(
      formatEvent(
        translator('en'),
        event({
          type: 'integrate_conflict',
          branch: 'feat',
          conflictFiles: ['a.ts'],
          message: 'conflict in a.ts'
        }),
        'en'
      ).detail
    ).toBe('conflict in a.ts')
    expect(
      formatEvent(
        translator('en'),
        event({
          type: 'pull_request',
          ok: true,
          branch: 'feat',
          base: 'main',
          message: 'opened #12',
          url: 'https://example.test/pr/12'
        }),
        'en'
      ).detail
    ).toBe('opened #12')
    expect(
      formatEvent(
        translator('en'),
        event({
          type: 'pull_request',
          ok: false,
          branch: 'feat',
          base: 'main',
          url: 'https://example.test/compare'
        }),
        'en'
      ).detail
    ).toBe('https://example.test/compare')
  })

  it('omits detail when the type has none or the payload is blank', () => {
    expect(
      formatEvent(translator('en'), event({ type: 'agent_started' }), 'en').detail
    ).toBeUndefined()
    expect(
      formatEvent(
        translator('en'),
        event({ type: 'agent_done', summary: '   ', status: 'success' }),
        'en'
      ).detail
    ).toBeUndefined()
  })

  it('appends a compact consumption count on agent_done', () => {
    const en = formatEvent(
      translator('en'),
      event({
        type: 'agent_done',
        summary: 'ok',
        status: 'success',
        tokenUsage: { kind: 'consumption', input: 100, output: 20, total: 12_400 }
      }),
      'en'
    )
    expect(en.label).toContain('12.4k')
    expect(en.label).toMatch(/finished/)
    const de = formatEvent(
      translator('de'),
      event({
        type: 'agent_done',
        summary: 'ok',
        status: 'success',
        tokenUsage: { kind: 'consumption', input: 100, output: 20, total: 12_400 }
      }),
      'de'
    )
    expect(de.label).toContain('12,4k')
    expect(de.label).toMatch(/fertig/)
  })

  it('appends a context occupancy label on agent_done', () => {
    const en = formatEvent(
      translator('en'),
      event({
        type: 'agent_done',
        summary: 'ok',
        status: 'success',
        tokenUsage: { kind: 'context', used: 48_000, window: 131_072 }
      }),
      'en'
    )
    expect(en.label).toMatch(/context/)
    expect(en.label).toContain('48k')
    const de = formatEvent(
      translator('de'),
      event({
        type: 'agent_done',
        summary: 'ok',
        status: 'success',
        tokenUsage: { kind: 'context', used: 48_000 }
      }),
      'de'
    )
    expect(de.label).toMatch(/Kontext/)
  })

  it('keeps the plain finished label without usage', () => {
    expect(
      formatEvent(
        translator('en'),
        event({ type: 'agent_done', summary: 'ok', status: 'success' }),
        'en'
      ).label
    ).toBe('Virgilio finished')
    expect(
      formatEvent(
        translator('de'),
        event({ type: 'agent_done', summary: 'ok', status: 'success' }),
        'de'
      ).label
    ).toBe('Virgilio fertig')
  })
})

describe('formatEventTime', () => {
  it('formats a clock in the requested locale, and de for any other tag', () => {
    const ts = 1_700_000_000_000
    expect(formatEventTime(ts, 'en')).toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(formatEventTime(ts, 'de')).toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(formatEventTime(ts, 'fr')).toBe(formatEventTime(ts, 'de'))
  })

  it('falls back to the raw timestamp when DateTimeFormat throws', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no locale data')
    })
    expect(formatEventTime(1_700_000_000_000, 'en')).toBe('1700000000000')
    vi.restoreAllMocks()
  })
})
