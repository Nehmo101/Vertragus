import type { Idea, IdeaArtifact } from '@shared/inbox'
import { previewIdeaTransferBriefing, type IdeaTransferBriefingPreview } from '@shared/inboxTransfer'
import type {
  PromptEnhancementIpcResult,
  PromptEnhancementSelection,
  PromptEnhancementSource
} from '@shared/promptEnhancement'

export const PROMPT_SHARPEN_LABEL = 'Prompt schärfen'
export const PROMPT_ENHANCEMENT_A11Y = {
  regionLabel: 'Prompt-Verbesserung prüfen',
  live: 'polite',
  escapeAction: 'Abbrechen'
} as const

export function isPromptReviewCancelKey(key: string): boolean {
  return key === 'Escape'
}

export function shouldFocusPromptReview(open: boolean): boolean {
  return open
}

/** Existing deterministic transfer preview; it is never presented as AI output. */
export function sharpenInboxPrompt(input: unknown): IdeaTransferBriefingPreview {
  return previewIdeaTransferBriefing(input, 'Vorschau')
}

export function promptEnhancementSourceFromIdea(idea: Idea): PromptEnhancementSource {
  return {
    title: idea.title,
    content: idea.content,
    status: idea.status,
    tags: [...idea.tags],
    refs: idea.refs ? { ...idea.refs } : undefined,
    // Image artifacts carry no textual context for prompt sharpening — omit them here.
    artifacts: idea.artifacts
      .filter(
        (artifact): artifact is IdeaArtifact & { kind: 'text' | 'url' | 'file' } =>
          artifact.kind !== 'image'
      )
      .map((artifact) => ({
        kind: artifact.kind,
        label: artifact.label,
        text: artifact.text,
        url: artifact.url,
        fileName: artifact.fileName,
        copied: artifact.copied,
        missing: artifact.missing,
        urlInvalid: artifact.urlInvalid
      }))
  }
}

export interface LocalPromptFallback {
  status: 'local-fallback'
  mode: 'deterministic-fallback'
  title: string
  prompt: string
  message: string
  warnings: string[]
}

export type PromptEnhancementViewResult = PromptEnhancementIpcResult | LocalPromptFallback

export function createOfferedDeterministicFallback(
  source: PromptEnhancementSource
): LocalPromptFallback | undefined {
  const preview = sharpenInboxPrompt(source)
  if (!preview.ok) return undefined
  return {
    status: 'local-fallback',
    mode: 'deterministic-fallback',
    title: source.title.trim() || 'Prompt-Fallback',
    prompt: [
      '# Deterministischer Fallback – keine KI-Verbesserung',
      '',
      '> Dieser Text wurde nur mit dem bestehenden lokalen Briefingpfad erzeugt.',
      '',
      preview.briefing
    ].join('\n'),
    message: 'Lokaler deterministischer Fallback – keine KI-Verbesserung.',
    warnings: preview.warnings
  }
}

export interface PromptEnhancementSession {
  open: boolean
  phase: 'idle' | 'loading' | 'result' | 'error' | 'aborted'
  generation: number
  requestId?: string
  original?: PromptEnhancementSource
  result?: PromptEnhancementViewResult
  selection?: PromptEnhancementSelection
  copied: boolean
  confirmApply: boolean
}

export const INITIAL_PROMPT_ENHANCEMENT_SESSION: PromptEnhancementSession = {
  open: false,
  phase: 'idle',
  generation: 0,
  copied: false,
  confirmApply: false
}

export function startPromptEnhancementSession(
  session: PromptEnhancementSession,
  requestId: string,
  original: PromptEnhancementSource,
  selection?: PromptEnhancementSelection
): PromptEnhancementSession {
  if (session.phase === 'loading') return session
  return {
    open: true,
    phase: 'loading',
    generation: session.generation + 1,
    requestId,
    original,
    selection,
    copied: false,
    confirmApply: false
  }
}

export function settlePromptEnhancementSession(
  session: PromptEnhancementSession,
  requestId: string,
  generation: number,
  result: PromptEnhancementIpcResult
): PromptEnhancementSession {
  if (
    session.phase !== 'loading' ||
    session.requestId !== requestId ||
    session.generation !== generation
  ) {
    return session
  }
  const phase = result.status === 'aborted'
    ? 'aborted'
    : result.status === 'invalid-input'
      ? 'error'
      : 'result'
  return {
    ...session,
    phase,
    requestId: undefined,
    result,
    copied: false,
    confirmApply: false
  }
}

export function abortPromptEnhancementSession(
  session: PromptEnhancementSession,
  requestId?: string
): PromptEnhancementSession {
  if (requestId && session.requestId !== requestId) return session
  return {
    ...session,
    open: true,
    phase: 'aborted',
    generation: session.generation + 1,
    requestId: undefined,
    result: { status: 'aborted', message: 'Die Prompt-Verbesserung wurde abgebrochen.' },
    copied: false,
    confirmApply: false
  }
}

export function closePromptEnhancementSession(
  session: PromptEnhancementSession
): PromptEnhancementSession {
  return { ...INITIAL_PROMPT_ENHANCEMENT_SESSION, generation: session.generation + 1 }
}

export function promptEnhancementOutput(
  result: PromptEnhancementViewResult | undefined
): { title: string; prompt: string } | undefined {
  if (!result) return undefined
  if (result.status === 'enhanced' || result.status === 'fallback' || result.status === 'local-fallback') {
    return { title: result.title, prompt: result.prompt }
  }
  return undefined
}

/** Explicit apply is deliberately constrained to the two editable local fields. */
export function applyPromptEnhancementToDraft<T extends Idea>(
  draft: T,
  result: PromptEnhancementViewResult
): T {
  const output = promptEnhancementOutput(result)
  return output ? { ...draft, title: output.title, content: output.prompt } : draft
}

export function requestPromptApplyConfirmation(
  session: PromptEnhancementSession
): PromptEnhancementSession {
  return promptEnhancementOutput(session.result)
    ? { ...session, confirmApply: true }
    : session
}

export function confirmPromptEnhancementApply<T extends Idea>(
  draft: T,
  session: PromptEnhancementSession
): T {
  return session.confirmApply && session.result
    ? applyPromptEnhancementToDraft(draft, session.result)
    : draft
}

export function promptProviderModelLabel(result: PromptEnhancementViewResult | undefined): string {
  if (!result) return ''
  if (result.status === 'enhanced' || result.status === 'fallback') {
    return `${result.provider} · ${result.model || 'CLI-Standard'}`
  }
  if (result.status === 'provider-unavailable') {
    return `${result.selection.provider} · ${result.selection.model || 'CLI-Standard'}`
  }
  if (result.status === 'local-fallback') return 'Lokal · kein Modell'
  return ''
}

export async function copyPromptEnhancement(
  result: PromptEnhancementViewResult,
  writeText: (text: string) => Promise<void>
): Promise<boolean> {
  const output = promptEnhancementOutput(result)
  if (!output) return false
  await writeText(output.prompt)
  return true
}
