import { z } from 'zod'
import { effortLevelSchema } from './provider'

/** A run-local execution seat; switching never rewrites the saved profile. */
export const agentSeatSchema = z
  .object({
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    effort: effortLevelSchema.optional()
  })
  .strict()
export type AgentSeat = z.infer<typeof agentSeatSchema>
export const seatOverrideSchema = agentSeatSchema.partial()
export type SeatOverride = z.infer<typeof seatOverrideSchema>
export const reseatInputSchema = seatOverrideSchema
  .extend({
    agentId: z.string().min(1),
    reason: z.string().trim().min(1).max(300).optional(),
    note: z.string().trim().min(1).max(2000).optional()
  })
  .strict()
export type ReseatInput = z.infer<typeof reseatInputSchema>

export function resolveSeat(current: AgentSeat, override: SeatOverride): AgentSeat {
  // A different CLI has its own defaults; do not carry another provider's model.
  const base =
    override.providerId && override.providerId !== current.providerId
      ? { providerId: override.providerId }
      : current
  return agentSeatSchema.parse({
    ...base,
    ...(override.providerId !== undefined ? { providerId: override.providerId } : {}),
    ...(override.model !== undefined ? { model: override.model } : {}),
    ...(override.effort !== undefined ? { effort: override.effort } : {})
  })
}
