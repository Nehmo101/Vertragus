import { z } from 'zod'
import { modelPresetSchema } from './models'
import { agentProviderId } from './profile'

const boundedText = (max: number): z.ZodString => z.string().max(max)
const optionalId = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0)
        return code <= 31 || code === 127
      }),
    'Identifier enthält ungültige Steuerzeichen.'
  )
  .optional()

/**
 * Renderer-owned draft data accepted by the narrow prompt-enhancement IPC path.
 * Filesystem paths, transfer state and persistence metadata are deliberately not
 * part of this schema.
 */
export const promptEnhancementSourceSchema = z
  .object({
    title: boundedText(300),
    content: boundedText(16_000),
    status: z.enum(['draft', 'ready', 'archived', 'done']),
    tags: z.array(boundedText(80)).max(30),
    refs: z
      .object({
        profileId: optionalId,
        workspaceId: optionalId,
        planId: optionalId,
        taskId: optionalId
      })
      .strict()
      .optional(),
    artifacts: z
      .array(
        z
          .object({
            kind: z.enum(['text', 'file', 'url']),
            label: boundedText(200),
            text: boundedText(4_000).optional(),
            url: boundedText(2_000).optional(),
            fileName: boundedText(240).optional(),
            copied: z.boolean().optional(),
            missing: z.boolean().optional(),
            urlInvalid: z.boolean().optional()
          })
          .strict()
      )
      .max(20)
  })
  .strict()

export const promptEnhancementSelectionSchema = z
  .object({
    provider: agentProviderId,
    model: boundedText(200).optional(),
    modelPreset: modelPresetSchema.optional()
  })
  .strict()

export const promptEnhancementRequestSchema = z
  .object({
    requestId: z.string().min(12).max(100).regex(/^[A-Za-z0-9_-]+$/),
    source: promptEnhancementSourceSchema,
    explicitSelection: promptEnhancementSelectionSchema.optional()
  })
  .strict()

export const promptEnhancementAbortSchema = z
  .object({
    requestId: z.string().min(12).max(100).regex(/^[A-Za-z0-9_-]+$/)
  })
  .strict()

export const promptProviderCandidateSchema = z
  .object({
    provider: agentProviderId,
    label: boundedText(120),
    status: z.enum(['ready', 'needs-login', 'unavailable', 'unverified']),
    detail: boundedText(500)
  })
  .strict()

export const resolvedPromptProviderSchema = z
  .object({
    provider: agentProviderId,
    model: boundedText(200),
    source: z.enum(['profile-orchestrator', 'explicit-selection']),
    profileId: boundedText(200).optional(),
    warning: boundedText(500).optional()
  })
  .strict()

const candidatesSchema = z.array(promptProviderCandidateSchema).max(8)
const warningsSchema = z.array(boundedText(600)).max(60)

export const promptEnhancementResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('enhanced'),
      mode: z.literal('ai'),
      title: boundedText(240),
      prompt: boundedText(16_000),
      language: boundedText(40),
      provider: agentProviderId,
      model: boundedText(200),
      selectionSource: z.enum(['profile-orchestrator', 'explicit-selection']),
      warnings: warningsSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('fallback'),
      mode: z.literal('deterministic-fallback'),
      title: boundedText(240),
      prompt: boundedText(16_000),
      reason: z.enum(['provider-error', 'timeout', 'invalid-response']),
      message: boundedText(1_000),
      retryable: z.boolean(),
      provider: agentProviderId,
      model: boundedText(200),
      warnings: warningsSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('invalid-input'),
      code: z.enum(['invalid-input', 'empty-input', 'input-too-large', 'invalid-workspace-context']),
      message: boundedText(1_000)
    })
    .strict(),
  z
    .object({
      status: z.literal('selection-required'),
      reason: z.enum(['no-profile', 'profile-without-orchestrator']),
      message: boundedText(1_000),
      candidates: candidatesSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('provider-unavailable'),
      message: boundedText(1_000),
      selection: resolvedPromptProviderSchema,
      candidates: candidatesSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('aborted'),
      message: boundedText(1_000)
    })
    .strict()
])

export type PromptEnhancementSource = z.infer<typeof promptEnhancementSourceSchema>
export type PromptEnhancementSelection = z.infer<typeof promptEnhancementSelectionSchema>
export type PromptEnhancementIpcRequest = z.infer<typeof promptEnhancementRequestSchema>
export type PromptProviderCandidateView = z.infer<typeof promptProviderCandidateSchema>
export type PromptEnhancementIpcResult = z.infer<typeof promptEnhancementResultSchema>
