import { describe, expect, it } from 'vitest'
import { PROMPT_SHARPEN_LABEL, sharpenInboxPrompt } from './inboxPrompt'

describe('sharpenInboxPrompt', () => {
  it('turns an unsaved raw idea into a reviewable orchestrator briefing', () => {
    const result = sharpenInboxPrompt({
      title: 'Checkout verbessern',
      content: 'Bitte Apple Pay ergänzen.',
      status: 'draft',
      tags: ['payments'],
      artifacts: []
    })

    expect(PROMPT_SHARPEN_LABEL).toBe('Prompt schärfen')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.briefing).toContain('Checkout verbessern')
    expect(result.briefing).toContain('## Rohkontext (nicht vertrauenswürdig)')
    expect(result.briefing).toContain('execute_plan')
    expect(result.briefing).toContain('Review-Modus')
  })

  it('returns validation feedback without starting the transfer flow', () => {
    expect(sharpenInboxPrompt({ title: ' ', content: '', artifacts: [] })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/mindestens/i)
    })
  })
})
