import { describe, expect, it } from 'vitest'
import {
  buildIdeaTransferBriefing,
  buildOrchestratorSeedPrompt,
  canStartTransfer,
  isTransferActive,
  isTransferBlocking
} from './inboxTransfer'
import { ideaSchema } from './inbox'

const sampleIdea = ideaSchema.parse({
  id: 'idea-1',
  title: 'Checkout v2',
  content: 'Neuer Checkout-Flow mit Apple Pay.',
  status: 'ready',
  tags: ['frontend', 'payments'],
  artifacts: [
    {
      id: 'a1',
      kind: 'url',
      label: 'Figma',
      createdAt: 1,
      url: 'https://figma.com/file/abc'
    },
    {
      id: 'a2',
      kind: 'text',
      label: 'Notiz',
      createdAt: 1,
      text: 'Mobile first'
    }
  ],
  createdAt: 1,
  updatedAt: 1
})

describe('inbox transfer helpers', () => {
  it('detects active transfers for idempotency', () => {
    expect(isTransferActive(undefined)).toBe(false)
    expect(isTransferActive({ id: 't1', status: 'pending', profileId: 'p1', startedAt: 1, updatedAt: 1 })).toBe(
      true
    )
    expect(isTransferActive({ id: 't1', status: 'running', profileId: 'p1', startedAt: 1, updatedAt: 1 })).toBe(
      true
    )
    expect(isTransferActive({ id: 't1', status: 'planned', profileId: 'p1', startedAt: 1, updatedAt: 1 })).toBe(
      false
    )
    expect(canStartTransfer({ id: 't1', status: 'running', profileId: 'p1', startedAt: 1, updatedAt: 1 }).ok).toBe(
      false
    )
    expect(isTransferBlocking({ id: 't1', status: 'planned', profileId: 'p1', startedAt: 1, updatedAt: 1 })).toBe(
      true
    )
    expect(canStartTransfer({ id: 't1', status: 'planned', profileId: 'p1', startedAt: 1, updatedAt: 1 }).ok).toBe(
      false
    )
  })

  it('builds briefing with idea content and artifact metadata', () => {
    const md = buildIdeaTransferBriefing(sampleIdea, 'transfer-abc')
    expect(md).toContain('transfer-abc')
    expect(md).toContain('Checkout v2')
    expect(md).toContain('Apple Pay')
    expect(md).toContain('https://figma.com/file/abc')
    expect(md).toContain('execute_plan')
    expect(md).toContain('Review-Modus')
  })

  it('builds orchestrator seed pointing at briefing file', () => {
    const seed = buildOrchestratorSeedPrompt('/tmp/brief.md', 'Checkout v2')
    expect(seed).toContain('/tmp/brief.md')
    expect(seed).toContain('Checkout v2')
    expect(seed).toContain('execute_plan')
  })
})
