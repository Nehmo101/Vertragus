import { describe, expect, it } from 'vitest'
import {
  promptEnhancementRequestSchema,
  promptEnhancementResultSchema
} from './promptEnhancement'

const validRequest = {
  requestId: 'request_123456789',
  source: {
    title: 'macOS support',
    content: 'Audit and implement it.',
    status: 'draft' as const,
    tags: ['desktop'],
    artifacts: []
  }
}

describe('prompt enhancement IPC schemas', () => {
  it('accepts the narrow unsaved-draft request and a typed response', () => {
    expect(promptEnhancementRequestSchema.parse(validRequest).source.title).toBe('macOS support')
    expect(
      promptEnhancementResultSchema.parse({
        status: 'enhanced',
        mode: 'ai',
        title: 'macOS unterstützen',
        prompt: '# macOS unterstützen',
        language: 'de',
        provider: 'codex',
        model: '',
        selectionSource: 'explicit-selection',
        warnings: []
      })
    ).toMatchObject({ status: 'enhanced', provider: 'codex' })
  })

  it('rejects invalid extra context, raw paths, malformed request IDs and oversized input', () => {
    expect(() =>
      promptEnhancementRequestSchema.parse({
        ...validRequest,
        source: { ...validRequest.source, workingDir: 'C:\\secret' }
      })
    ).toThrow(/unrecognized/i)
    expect(() =>
      promptEnhancementRequestSchema.parse({
        ...validRequest,
        source: {
          ...validRequest.source,
          artifacts: [{ kind: 'file', label: 'x', fileName: 'x', sourcePath: '..\\secret' }]
        }
      })
    ).toThrow(/unrecognized/i)
    expect(() => promptEnhancementRequestSchema.parse({ ...validRequest, requestId: '../bad' })).toThrow()
    expect(() =>
      promptEnhancementRequestSchema.parse({
        ...validRequest,
        source: { ...validRequest.source, content: 'x'.repeat(16_001) }
      })
    ).toThrow()
  })

  it('fails closed for invalid model responses and unknown output fields', () => {
    expect(
      promptEnhancementResultSchema.safeParse({ status: 'enhanced', prompt: 'missing fields' }).success
    ).toBe(false)
    expect(
      promptEnhancementResultSchema.safeParse({
        status: 'aborted',
        message: 'cancelled',
        hiddenSystemPrompt: 'do not expose'
      }).success
    ).toBe(false)
  })
})
