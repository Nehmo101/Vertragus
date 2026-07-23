import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redactAuditArgs } from './auditRedact'

function prefix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
}

describe('redactAuditArgs', () => {
  it('reduces goal.submit args to profileId + textLength + textSha256Prefix', () => {
    const text = 'Baue bitte ein streng geheimes Feature in Modul X.'
    const redacted = redactAuditArgs('goal.submit', { profileId: 'workspace-1', text })
    expect(redacted).toEqual({
      profileId: 'workspace-1',
      textLength: text.length,
      textSha256Prefix: prefix(text)
    })
    // The raw content must not survive anywhere in the redacted structure.
    expect(JSON.stringify(redacted)).not.toContain('geheimes')
  })

  it('keeps all non-text fields verbatim, including nested objects and arrays', () => {
    const args = {
      profileId: 'p',
      sessionId: 's',
      removeTaskIds: ['t-1', 't-2'],
      maxParallel: 2,
      nested: { taskId: 't-3', flags: [true, false] }
    }
    expect(redactAuditArgs('plan.replan', args)).toEqual(args)
  })

  it('redacts text-like keys in nested structures and array items', () => {
    const redacted = redactAuditArgs('custom', {
      items: [{ note: 'privater Hinweis', taskId: 't' }],
      meta: { prompt: 'geheimer Prompt' }
    }) as { items: Array<Record<string, unknown>>; meta: Record<string, unknown> }
    expect(redacted.items[0]).toEqual({
      noteLength: 'privater Hinweis'.length,
      noteSha256Prefix: prefix('privater Hinweis'),
      taskId: 't'
    })
    expect(redacted.meta).toEqual({
      promptLength: 'geheimer Prompt'.length,
      promptSha256Prefix: prefix('geheimer Prompt')
    })
  })

  it('leaves non-string values under text-like keys untouched', () => {
    expect(redactAuditArgs('custom', { text: 42, note: null })).toEqual({ text: 42, note: null })
  })

  it('reduces a bare string envelope to length + hash prefix', () => {
    const redacted = redactAuditArgs('goal.submit', 'roher geheimer text')
    expect(redacted).toEqual({
      textLength: 'roher geheimer text'.length,
      textSha256Prefix: prefix('roher geheimer text')
    })
  })

  it('passes primitives and nullish args through unchanged', () => {
    expect(redactAuditArgs('x', undefined)).toBeUndefined()
    expect(redactAuditArgs('x', null)).toBeNull()
    expect(redactAuditArgs('x', 7)).toBe(7)
    expect(redactAuditArgs('x', true)).toBe(true)
  })

  it('is deterministic and collision-visible for different texts', () => {
    const first = redactAuditArgs('goal.submit', { profileId: 'p', text: 'a' }) as { textSha256Prefix: string }
    const again = redactAuditArgs('goal.submit', { profileId: 'p', text: 'a' }) as { textSha256Prefix: string }
    const other = redactAuditArgs('goal.submit', { profileId: 'p', text: 'b' }) as { textSha256Prefix: string }
    expect(first.textSha256Prefix).toBe(again.textSha256Prefix)
    expect(first.textSha256Prefix).not.toBe(other.textSha256Prefix)
    expect(first.textSha256Prefix).toHaveLength(12)
  })
})
