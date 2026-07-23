import { createHash } from 'node:crypto'

/**
 * Free-text argument keys whose string values are user content (goal prompts,
 * notes, message bodies). The audit trail must stay useful for forensics
 * without persisting that content verbatim, so matching values are replaced by
 * their length plus a short SHA-256 prefix. The prefix still lets an operator
 * confirm whether a known text matches an entry, without the log revealing it.
 */
const FREE_TEXT_KEYS = /^(?:text|prompt|goal|message|summary|note|body|content|description)$/i

const HASH_PREFIX_LENGTH = 12

function sha256Prefix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, HASH_PREFIX_LENGTH)
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && FREE_TEXT_KEYS.test(key)) {
        output[`${key}Length`] = child.length
        output[`${key}Sha256Prefix`] = sha256Prefix(child)
      } else {
        output[key] = redactValue(child)
      }
    }
    return output
  }
  return value
}

/**
 * Redact free-text fields out of remote-command args before they reach the
 * audit log: `goal.submit` args `{ profileId, text }` become
 * `{ profileId, textLength, textSha256Prefix }`. Every non-text field (ids,
 * caps, flags) is kept verbatim so entries stay correlatable. A bare string
 * envelope (schema-rejected input still hits the error audit path) is likewise
 * reduced to length + hash so it never lands on disk in clear.
 *
 * `commandId` is part of the contract so per-command rules can be added
 * without touching call sites; today every command shares the generic rule.
 */
export function redactAuditArgs(commandId: string, args: unknown): unknown {
  if (typeof args === 'string') {
    return { textLength: args.length, textSha256Prefix: sha256Prefix(args) }
  }
  return redactValue(args)
}
