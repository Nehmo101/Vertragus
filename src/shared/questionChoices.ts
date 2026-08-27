/**
 * MCP / event schemas for structured question labels.
 *
 * Display helpers (phone + panel) live in {@link ./questionChoicesDisplay.ts}
 * so this file's `zod` import cannot reach the phone bundle. Host code may
 * keep importing schemas and helpers from here; the phone client must not.
 */
import { z } from 'zod'
import { QUESTION_CHOICE_MAX, QUESTION_CHOICE_MAX_CHARS } from './questionChoicesDisplay'

export {
  QUESTION_CHOICE_MAX,
  QUESTION_CHOICE_MAX_CHARS,
  questionChoicesDisplay,
  sanitizeQuestionChoices
} from './questionChoicesDisplay'
export type { QuestionChoicesDisplay } from './questionChoicesDisplay'

/** MCP tool input: trimmed, unique, 1–28 labels, each ≤ 200 chars. */
export const questionChoicesInputSchema = z
  .array(z.string().trim().min(1).max(QUESTION_CHOICE_MAX_CHARS))
  .min(1)
  .max(QUESTION_CHOICE_MAX)
  .refine((items) => new Set(items).size === items.length, {
    message: 'choices must be unique after trim'
  })

/**
 * Loose wire field for ask_user / ask_orchestrator. Empty `[]` (a common
 * encoding of "omitted") is accepted. Strict uniqueness/length is applied
 * only when opening a new question — see {@link parseNewAskChoices} — so a
 * ticket resume is never blocked by leftover or regenerated `choices`.
 */
export const questionChoicesToolFieldSchema = z.array(z.string()).optional()

/** Strict labels for a NEW question. Empty/absent → omitted. Throws on invalid. */
export function parseNewAskChoices(raw: string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined
  return questionChoicesInputSchema.parse(raw)
}

/** Event / handoff / wire field: already-normalized labels. */
export const questionChoicesFieldSchema = z
  .array(z.string().min(1).max(QUESTION_CHOICE_MAX_CHARS))
  .max(QUESTION_CHOICE_MAX)
