/**
 * Boundary parsing for structured renderer→main IPC payloads. Every handler
 * that receives an object from the renderer treats it as `unknown` and runs
 * it through the matching shared zod schema here — the third validation style
 * ("trust the compile-time type") is retired (audit M5). Error style follows
 * the established profileSaveIpc controller.
 */
import type { z } from 'zod'

export function parseIpcPayload<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
  label: string
): z.infer<Schema> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path?.length ? ` (${issue.path.join('.')})` : ''
    throw new Error(`Ungültige ${label}: ${issue?.message ?? 'invalid payload'}${path}`)
  }
  return parsed.data
}
