import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseIpcPayload } from './ipcPayload'

describe('parseIpcPayload', () => {
  const schema = z.object({ id: z.string().min(1), count: z.number().int().optional() })

  it('returns the parsed payload on success', () => {
    expect(parseIpcPayload(schema, { id: 'a', count: 2 }, 'Testanfrage')).toEqual({
      id: 'a',
      count: 2
    })
  })

  it('throws a labeled error naming the failing path', () => {
    expect(() => parseIpcPayload(schema, { id: '' }, 'Testanfrage')).toThrow(
      /^Ungültige Testanfrage: .*\(id\)$/
    )
  })

  it('rejects non-object payloads', () => {
    expect(() => parseIpcPayload(schema, 'nope', 'Testanfrage')).toThrow(/Ungültige Testanfrage/)
    expect(() => parseIpcPayload(schema, undefined, 'Testanfrage')).toThrow(/Ungültige Testanfrage/)
  })
})
