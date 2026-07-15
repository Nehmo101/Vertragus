import { describe, expect, it } from 'vitest'
import { redactAndLimitRemoteDiff } from './remoteDiff'

describe('remote task diff', () => {
  it('redacts credentials and applies the independent mobile byte cap', () => {
    const output = redactAndLimitRemoteDiff({
      taskId: 'task-1',
      diff: `+ Authorization: Bearer raw-secret-token\n+ sk-abcdefghijklmnop\n${'x'.repeat(200)}`,
      truncated: false
    }, 100)
    expect(output.diff).not.toContain('raw-secret-token')
    expect(output.diff).not.toContain('sk-abcdefghijklmnop')
    expect(output.diff).toContain('Mobilgeräte gekürzt')
    expect(output.truncated).toBe(true)
    expect(Buffer.byteLength(output.diff, 'utf8')).toBeLessThanOrEqual(100)
  })
})
