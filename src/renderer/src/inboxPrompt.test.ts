import { describe, expect, it, vi } from 'vitest'
import type { Idea } from '@shared/inbox'
import type { PromptEnhancementIpcResult } from '@shared/promptEnhancement'
import {
  INITIAL_PROMPT_ENHANCEMENT_SESSION,
  PROMPT_ENHANCEMENT_A11Y,
  PROMPT_SHARPEN_LABEL,
  abortPromptEnhancementSession,
  closePromptEnhancementSession,
  confirmPromptEnhancementApply,
  copyPromptEnhancement,
  createOfferedDeterministicFallback,
  isPromptReviewCancelKey,
  promptEnhancementSourceFromIdea,
  promptProviderModelLabel,
  requestPromptApplyConfirmation,
  settlePromptEnhancementSession,
  sharpenInboxPrompt,
  shouldFocusPromptReview,
  startPromptEnhancementSession
} from './inboxPrompt'

function idea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: 'idea-1',
    title: 'Orca-Strator soll für MacOS nutzbar sein',
    content: 'Bitte konkretisieren.',
    status: 'draft',
    tags: ['desktop'],
    refs: { profileId: 'profile-1', workspaceId: 'workspace-1' },
    artifacts: [
      {
        id: 'artifact-1',
        kind: 'file',
        label: 'Notizen',
        fileName: 'notes.txt',
        sourcePath: 'C:\\private\\notes.txt',
        createdAt: 1
      }
    ],
    transfer: {
      id: 'transfer-1',
      status: 'planned',
      profileId: 'profile-1',
      action: 'none',
      startedAt: 1,
      updatedAt: 2,
      planId: 'plan-1'
    },
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

const enhanced: PromptEnhancementIpcResult = {
  status: 'enhanced',
  mode: 'ai',
  title: 'macOS-Unterstützung verifizieren und herstellen',
  prompt: '# macOS-Unterstützung\n\n## Ziel\n\nAudit, Packaging, CI und Release validieren.',
  language: 'de',
  provider: 'claude',
  model: 'sonnet',
  selectionSource: 'profile-orchestrator',
  warnings: []
}

describe('Inbox prompt enhancement renderer workflow', () => {
  it('uses the existing button label and strips filesystem paths from an unsaved draft IPC source', () => {
    const source = promptEnhancementSourceFromIdea(idea())
    expect(PROMPT_SHARPEN_LABEL).toBe('Prompt schärfen')
    expect(source.title).toContain('MacOS')
    expect(source.refs).toEqual({ profileId: 'profile-1', workspaceId: 'workspace-1' })
    expect(JSON.stringify(source)).not.toContain('C:\\private')
    expect(source.artifacts[0]).toMatchObject({ kind: 'file', fileName: 'notes.txt' })
  })

  it('models loading, success, provider/model display and blocks multiclick starts', () => {
    const original = promptEnhancementSourceFromIdea(idea())
    const loading = startPromptEnhancementSession(
      INITIAL_PROMPT_ENHANCEMENT_SESSION,
      'request_123456789',
      original
    )
    expect(loading).toMatchObject({ open: true, phase: 'loading', generation: 1 })
    expect(startPromptEnhancementSession(loading, 'request_987654321', original)).toBe(loading)

    const success = settlePromptEnhancementSession(
      loading,
      'request_123456789',
      loading.generation,
      enhanced
    )
    expect(success).toMatchObject({ phase: 'result', result: enhanced })
    expect(promptProviderModelLabel(success.result)).toBe('claude · sonnet')
  })

  it('ignores stale responses by request ID and generation', () => {
    const loading = startPromptEnhancementSession(
      INITIAL_PROMPT_ENHANCEMENT_SESSION,
      'request_123456789',
      promptEnhancementSourceFromIdea(idea())
    )
    expect(settlePromptEnhancementSession(loading, 'stale_request_123', 1, enhanced)).toBe(loading)
    expect(settlePromptEnhancementSession(loading, 'request_123456789', 999, enhanced)).toBe(loading)
  })

  it('keeps the original on cancel/error and supports retry after abort', () => {
    const original = promptEnhancementSourceFromIdea(idea())
    const loading = startPromptEnhancementSession(
      INITIAL_PROMPT_ENHANCEMENT_SESSION,
      'request_123456789',
      original
    )
    const aborted = abortPromptEnhancementSession(loading, 'request_123456789')
    expect(aborted).toMatchObject({ phase: 'aborted', original })
    const retried = startPromptEnhancementSession(aborted, 'request_987654321', original, {
      provider: 'codex'
    })
    expect(retried).toMatchObject({ phase: 'loading', selection: { provider: 'codex' } })

    const failed = settlePromptEnhancementSession(retried, 'request_987654321', retried.generation, {
      status: 'invalid-input',
      code: 'empty-input',
      message: 'Bitte Inhalt eingeben.'
    })
    expect(failed).toMatchObject({ phase: 'error', original })
  })

  it('offers the existing deterministic briefing only as a clear non-AI fallback', () => {
    const source = promptEnhancementSourceFromIdea(idea())
    const fallback = createOfferedDeterministicFallback(source)
    expect(fallback).toMatchObject({
      status: 'local-fallback',
      mode: 'deterministic-fallback'
    })
    expect(fallback?.prompt).toContain('keine KI-Verbesserung')
    expect(sharpenInboxPrompt({ title: ' ', content: '', artifacts: [] })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/mindestens/i)
    })
  })

  it('copies output and applies only title/content after explicit confirmation logic', async () => {
    const writeText = vi.fn(async () => undefined)
    await expect(copyPromptEnhancement(enhanced, writeText)).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith(enhanced.prompt)

    const original = idea()
    const resultSession = {
      ...INITIAL_PROMPT_ENHANCEMENT_SESSION,
      open: true,
      phase: 'result' as const,
      original: promptEnhancementSourceFromIdea(original),
      result: enhanced
    }
    expect(confirmPromptEnhancementApply(original, resultSession)).toBe(original)
    const confirmedSession = requestPromptApplyConfirmation(resultSession)
    expect(confirmedSession.confirmApply).toBe(true)
    const applied = confirmPromptEnhancementApply(original, confirmedSession)
    expect(applied.title).toBe(enhanced.title)
    expect(applied.content).toBe(enhanced.prompt)
    expect(applied.status).toBe(original.status)
    expect(applied.tags).toEqual(original.tags)
    expect(applied.refs).toEqual(original.refs)
    expect(applied.artifacts).toEqual(original.artifacts)
    expect(applied.transfer).toEqual(original.transfer)
    expect(original.title).not.toBe(enhanced.title)
  })

  it('exposes keyboard, focus and aria-live behavior and closes without changing the draft', () => {
    const loading = startPromptEnhancementSession(
      INITIAL_PROMPT_ENHANCEMENT_SESSION,
      'request_123456789',
      promptEnhancementSourceFromIdea(idea())
    )
    expect(PROMPT_ENHANCEMENT_A11Y).toEqual({
      regionLabel: 'Prompt-Verbesserung prüfen',
      live: 'polite',
      escapeAction: 'Abbrechen'
    })
    expect(isPromptReviewCancelKey('Escape')).toBe(true)
    expect(isPromptReviewCancelKey('Enter')).toBe(false)
    expect(shouldFocusPromptReview(loading.open)).toBe(true)
    expect(closePromptEnhancementSession(loading)).toMatchObject({ open: false, phase: 'idle' })
  })
})
