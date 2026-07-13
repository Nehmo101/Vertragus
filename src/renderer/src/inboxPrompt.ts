import { previewIdeaTransferBriefing, type IdeaTransferBriefingPreview } from '@shared/inboxTransfer'

export const PROMPT_SHARPEN_LABEL = 'Prompt schärfen'

/** Renderer entry point for the standalone, non-mutating prompt preview action. */
export function sharpenInboxPrompt(input: unknown): IdeaTransferBriefingPreview {
  return previewIdeaTransferBriefing(input, 'Vorschau')
}
